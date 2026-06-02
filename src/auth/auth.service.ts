import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import type { PoolClient } from 'pg';
import type { AuthSessionDTO } from '@signalix/contracts';
import { ErrorCode, MAX_ACTIVE_DEVICES_PER_USER } from '@signalix/contracts';
import { DbService } from '../db/db.service';
import type { RegisterDto } from './dto/register.dto';
import type { LoginDto } from './dto/login.dto';

interface UserRow {
  id: string;
  email: string;
  username: string;
  password_hash: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string;
  expires_at: Date;
}

interface CreateSessionOpts {
  deviceId?: string;   // if set, reuse existing device instead of inserting new one
  deviceName?: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto, ip?: string): Promise<AuthSessionDTO> {
    const passwordHash = await bcrypt.hash(dto.password, 12);

    return this.db.transaction(async (client) => {
      let userId: string;

      try {
        const result = await client.query<{ id: string }>(`
          INSERT INTO users (email, username, password_hash, display_name)
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `, [
          dto.email.toLowerCase(),
          dto.username.toLowerCase(),
          passwordHash,
          dto.displayName ?? dto.username,
        ]);
        userId = result.rows[0].id;
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          const detail = (err as { detail?: string }).detail ?? '';
          if (detail.includes('username')) {
            throw new ConflictException({
              code: ErrorCode.USERNAME_TAKEN,
              message: 'Username is already taken.',
            });
          }
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: 'Email is already registered.',
          });
        }
        throw err;
      }

      await client.query(`
        INSERT INTO auth_providers (user_id, provider, provider_user_id)
        VALUES ($1, 'local', $2)
      `, [userId, userId]);

      return this.createDeviceSession(client, userId, {
        deviceName: dto.deviceName,
        ip,
        userAgent: dto.userAgent,
      });
    });
  }

  async login(dto: LoginDto, ip?: string): Promise<AuthSessionDTO> {
    const identifier = dto.identifier.toLowerCase();

    const userResult = await this.db.query<UserRow>(`
      SELECT id, email, username, password_hash
      FROM users
      WHERE email = $1 OR username = $1
      LIMIT 1
    `, [identifier]);

    const user = userResult.rows[0];

    if (!user?.password_hash) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid credentials.',
      });
    }

    const valid = await bcrypt.compare(dto.password, user.password_hash);
    if (!valid) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid credentials.',
      });
    }

    return this.db.transaction(async (client) => {
      // If the client sends a user_agent, look for an existing active session from
      // the same browser. If found, revoke it and reuse the device so that repeated
      // logins from the same browser do not consume additional device slots.
      let reuseDeviceId: string | undefined;

      if (dto.userAgent) {
        const existing = await client.query<{ id: string; device_id: string }>(`
          SELECT id, device_id
          FROM device_sessions
          WHERE user_id    = $1
            AND user_agent = $2
            AND revoked    = false
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
        `, [user.id, dto.userAgent]);

        if (existing.rows[0]) {
          await client.query(
            'UPDATE device_sessions SET revoked = true, updated_at = NOW() WHERE id = $1',
            [existing.rows[0].id],
          );
          reuseDeviceId = existing.rows[0].device_id;
        }
      }

      // Only enforce the device cap when we are not reusing an existing slot.
      if (!reuseDeviceId) {
        const countResult = await client.query<{ count: string }>(`
          SELECT COUNT(*) AS count
          FROM device_sessions
          WHERE user_id = $1 AND revoked = false AND expires_at > NOW()
        `, [user.id]);

        if (parseInt(countResult.rows[0].count, 10) >= MAX_ACTIVE_DEVICES_PER_USER) {
          throw new ForbiddenException({
            code: ErrorCode.DEVICE_LIMIT_REACHED,
            message: 'Maximum active device limit reached.',
          });
        }
      }

      return this.createDeviceSession(client, user.id, {
        deviceId: reuseDeviceId,
        deviceName: dto.deviceName,
        ip,
        userAgent: dto.userAgent,
      });
    });
  }

  async refresh(refreshToken: string): Promise<AuthSessionDTO> {
    const tokenHash = hashToken(refreshToken);

    const sessionResult = await this.db.query<SessionRow>(`
      SELECT id, user_id, device_id, expires_at
      FROM device_sessions
      WHERE refresh_token_hash = $1
        AND revoked = false
        AND expires_at > NOW()
    `, [tokenHash]);

    const session = sessionResult.rows[0];
    if (!session) {
      throw new UnauthorizedException({
        code: ErrorCode.SESSION_REVOKED,
        message: 'Invalid or expired refresh token.',
      });
    }

    await this.db.query(`
      UPDATE device_sessions
      SET last_seen = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [session.id]);

    const { accessToken, accessTokenExpiresAt } = this.buildAccessToken(
      session.user_id,
      session.device_id,
    );

    return {
      userId: session.user_id,
      deviceId: session.device_id,
      accessToken,
      refreshToken,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: session.expires_at.toISOString(),
    };
  }

  private async createDeviceSession(
    client: PoolClient,
    userId: string,
    opts: CreateSessionOpts,
  ): Promise<AuthSessionDTO> {
    const deviceId = opts.deviceId ?? randomUUID();
    const sessionId = randomUUID();
    const refreshTokenRaw = randomBytes(32).toString('hex');
    const refreshTokenHash = hashToken(refreshTokenRaw);
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    if (opts.deviceId) {
      // Reusing an existing device — just bump last_seen.
      await client.query(
        'UPDATE devices SET last_seen = NOW() WHERE id = $1',
        [deviceId],
      );
    } else {
      await client.query(`
        INSERT INTO devices (id, user_id, device_name, device_type, last_seen)
        VALUES ($1, $2, $3, 'web', NOW())
      `, [deviceId, userId, opts.deviceName ?? null]);
    }

    await client.query(`
      INSERT INTO device_sessions
        (id, user_id, device_id, refresh_token_hash, ip, user_agent, last_seen, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
    `, [sessionId, userId, deviceId, refreshTokenHash, opts.ip ?? null, opts.userAgent ?? null, refreshExpiresAt]);

    const { accessToken, accessTokenExpiresAt } = this.buildAccessToken(userId, deviceId);

    return {
      userId,
      deviceId,
      accessToken,
      refreshToken: refreshTokenRaw,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    };
  }

  private buildAccessToken(
    userId: string,
    deviceId: string,
  ): { accessToken: string; accessTokenExpiresAt: Date } {
    const accessTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const accessToken = this.jwtService.sign({ sub: userId, deviceId, type: 'access' });
    return { accessToken, accessTokenExpiresAt };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}
