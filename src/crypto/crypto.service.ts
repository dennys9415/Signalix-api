import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DeviceKeyBundleDTO,
  ErrorCode,
  KeyAlgorithm,
  KeyBundleResponse,
  PreKeyDTO,
  RegisterDeviceKeysResponse,
  RotateSignedPreKeyResponse,
  SignedPreKeyDTO,
  UploadPreKeysResponse,
} from '@signalix/contracts';
import { DbService } from '../db/db.service';
import {
  PreKeyMaterialDto,
  RegisterDeviceKeysDto,
  RotateSignedPreKeyDto,
  SignedPreKeyMaterialDto,
  UploadPreKeysDto,
} from './dto/key-material.dto';

/**
 * Storage layer for the v0.8.0 encryption foundation. Owns the lifecycle
 * of identity keys, signed pre-keys, and one-time pre-keys, plus the
 * atomic "claim a fresh pre-key" path used by `GET /key-bundle`.
 *
 * No cryptography happens here — the service treats key material as
 * opaque blobs (base64url on the wire, BYTEA in PostgreSQL) and trusts
 * the client to produce + sign them correctly. v0.9.0 will add
 * verification of `signedPreKey.signature` against `signingKey` before
 * persisting.
 */
@Injectable()
export class CryptoService {
  constructor(private readonly db: DbService) {}

  async registerDeviceKeys(
    deviceId: string,
    dto: RegisterDeviceKeysDto,
  ): Promise<RegisterDeviceKeysResponse> {
    const algorithm: KeyAlgorithm = (dto.algorithm ?? 'x25519') as KeyAlgorithm;
    const identityBuf = decodeKey(dto.identityKey, 'identityKey');
    const signingBuf = decodeKey(dto.signingKey, 'signingKey');

    return this.db.transaction(async (client) => {
      // Identity is an upsert — re-registering a device replaces its
      // long-term keys (only meaningful when the local store is wiped).
      await client.query(
        `
        INSERT INTO device_identity_keys (device_id, registration_id, identity_key, signing_key, key_algorithm)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (device_id) DO UPDATE
          SET registration_id = EXCLUDED.registration_id,
              identity_key    = EXCLUDED.identity_key,
              signing_key     = EXCLUDED.signing_key,
              key_algorithm   = EXCLUDED.key_algorithm,
              updated_at      = NOW()
        `,
        [deviceId, dto.registrationId, identityBuf, signingBuf, algorithm],
      );

      // Signed pre-key — keyed by (device_id, key_id); duplicates from a
      // retried request are no-ops.
      await client.query(
        `
        INSERT INTO signed_pre_keys (device_id, key_id, public_key, signature, key_algorithm)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (device_id, key_id) DO NOTHING
        `,
        [
          deviceId,
          dto.signedPreKey.keyId,
          decodeKey(dto.signedPreKey.publicKey, 'signedPreKey.publicKey'),
          decodeKey(dto.signedPreKey.signature, 'signedPreKey.signature'),
          algorithm,
        ],
      );

      // One-time pre-keys — bulk insert with ON CONFLICT DO NOTHING so
      // retries are idempotent.
      for (const pk of dto.preKeys) {
        await client.query(
          `
          INSERT INTO pre_keys (device_id, key_id, public_key, key_algorithm)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (device_id, key_id) DO NOTHING
          `,
          [deviceId, pk.keyId, decodeKey(pk.publicKey, 'preKey.publicKey'), algorithm],
        );
      }

      const count = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM pre_keys WHERE device_id = $1 AND consumed_at IS NULL',
        [deviceId],
      );
      return { deviceId, preKeyCount: Number(count.rows[0].count) };
    });
  }

  async rotateSignedPreKey(
    deviceId: string,
    dto: RotateSignedPreKeyDto,
  ): Promise<RotateSignedPreKeyResponse> {
    const spk = dto.signedPreKey;
    const publicKey = decodeKey(spk.publicKey, 'signedPreKey.publicKey');
    const signature = decodeKey(spk.signature, 'signedPreKey.signature');
    const algorithm: KeyAlgorithm = (spk.algorithm ?? 'x25519') as KeyAlgorithm;

    return this.db.transaction(async (client) => {
      // Mark any *unrotated* prior signed pre-keys as rotated. We keep
      // the rows around for late handshakes that still reference them.
      await client.query(
        `UPDATE signed_pre_keys SET rotated_at = NOW()
         WHERE device_id = $1 AND rotated_at IS NULL`,
        [deviceId],
      );
      await client.query(
        `
        INSERT INTO signed_pre_keys (device_id, key_id, public_key, signature, key_algorithm)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (device_id, key_id) DO NOTHING
        `,
        [deviceId, spk.keyId, publicKey, signature, algorithm],
      );
      return {
        deviceId,
        signedPreKey: {
          keyId: spk.keyId,
          publicKey: spk.publicKey,
          signature: spk.signature,
          algorithm,
        },
      };
    });
  }

  async uploadPreKeys(
    deviceId: string,
    dto: UploadPreKeysDto,
  ): Promise<UploadPreKeysResponse> {
    const algorithm: KeyAlgorithm = (dto.algorithm ?? 'x25519') as KeyAlgorithm;
    for (const pk of dto.preKeys) {
      await this.db.query(
        `
        INSERT INTO pre_keys (device_id, key_id, public_key, key_algorithm)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (device_id, key_id) DO NOTHING
        `,
        [deviceId, pk.keyId, decodeKey(pk.publicKey, 'preKey.publicKey'), algorithm],
      );
    }
    const count = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM pre_keys WHERE device_id = $1 AND consumed_at IS NULL',
      [deviceId],
    );
    return { deviceId, preKeyCount: Number(count.rows[0].count) };
  }

  /**
   * Fetch the key bundle for every device of the target user that has
   * published identity keys. For each device, atomically claims one
   * unconsumed one-time pre-key (`FOR UPDATE SKIP LOCKED`) so two
   * concurrent senders can't both grab the same key. If the device's
   * one-time pool is exhausted, the bundle includes only the signed
   * pre-key — the sender will fall back to a slightly-weaker handshake.
   */
  async getKeyBundle(targetUserId: string): Promise<KeyBundleResponse> {
    // Identity rows for every device of this user that has registered.
    const devicesRow = await this.db.query<{
      device_id: string;
      registration_id: number;
      identity_key: Buffer;
      signing_key: Buffer;
      key_algorithm: string;
    }>(
      `
      SELECT dik.device_id, dik.registration_id, dik.identity_key, dik.signing_key, dik.key_algorithm
      FROM device_identity_keys dik
      JOIN devices d ON d.id = dik.device_id
      WHERE d.user_id = $1
      `,
      [targetUserId],
    );

    if (devicesRow.rows.length === 0) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: 'No devices with published keys for this user.',
      });
    }

    const bundles: DeviceKeyBundleDTO[] = [];

    for (const dev of devicesRow.rows) {
      // Current (unrotated) signed pre-key with the highest created_at.
      const spk = await this.db.query<{
        key_id: number; public_key: Buffer; signature: Buffer; key_algorithm: string;
      }>(
        `
        SELECT key_id, public_key, signature, key_algorithm
        FROM signed_pre_keys
        WHERE device_id = $1 AND rotated_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [dev.device_id],
      );
      if (spk.rows.length === 0) continue; // device has no signed pre-key yet

      // Atomically claim one unconsumed pre-key, if any.
      const pk = await this.db.query<{
        key_id: number; public_key: Buffer; key_algorithm: string;
      }>(
        `
        UPDATE pre_keys
        SET consumed_at = NOW()
        WHERE (device_id, key_id) IN (
          SELECT device_id, key_id FROM pre_keys
          WHERE device_id = $1 AND consumed_at IS NULL
          ORDER BY key_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING key_id, public_key, key_algorithm
        `,
        [dev.device_id],
      );

      const signedPreKey: SignedPreKeyDTO = {
        keyId: spk.rows[0].key_id,
        publicKey: encodeKey(spk.rows[0].public_key),
        signature: encodeKey(spk.rows[0].signature),
        algorithm: spk.rows[0].key_algorithm as KeyAlgorithm,
      };
      const bundle: DeviceKeyBundleDTO = {
        deviceId: dev.device_id,
        identityKey: encodeKey(dev.identity_key),
        signingKey: encodeKey(dev.signing_key),
        registrationId: dev.registration_id,
        algorithm: dev.key_algorithm as KeyAlgorithm,
        signedPreKey,
      };
      if (pk.rows[0]) {
        const preKey: PreKeyDTO = {
          keyId: pk.rows[0].key_id,
          publicKey: encodeKey(pk.rows[0].public_key),
          algorithm: pk.rows[0].key_algorithm as KeyAlgorithm,
        };
        bundle.preKey = preKey;
      }
      bundles.push(bundle);
    }

    if (bundles.length === 0) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: 'No usable key bundles for this user (no signed pre-key registered).',
      });
    }

    return { userId: targetUserId, bundles };
  }
}

function decodeKey(base64url: string, field: string): Buffer {
  try {
    // Node accepts base64url natively since v16.
    return Buffer.from(base64url, 'base64url');
  } catch {
    throw new BadRequestException({
      code: ErrorCode.VALIDATION_ERROR,
      message: `Invalid base64url value for ${field}.`,
    });
  }
}

function encodeKey(buf: Buffer): string {
  return buf.toString('base64url');
}

// Re-export key DTO shapes so other API services can import them centrally.
export type {
  PreKeyMaterialDto,
  SignedPreKeyMaterialDto,
  RegisterDeviceKeysDto,
  RotateSignedPreKeyDto,
  UploadPreKeysDto,
};
