-- v0.8.0 — Encryption foundation
--
-- Scaffolding for a future Signal-Protocol-style E2EE layer. Nothing in
-- v0.8.0 actually encrypts messages — the rows in `messages` remain
-- plaintext with `encryption_version = 0`. These tables exist so that
-- when v0.9.0 turns on real encryption, no further migration is needed
-- and existing chats just start emitting `encryption_version >= 1`.
--
-- Keys are stored as raw BYTEA. Wire format uses base64url; the server
-- decodes once on publish and encodes on lookup.

-- ── Per-device identity ────────────────────────────────────────────────────
-- One row per device. Identity + signing keys are long-lived: rotating
-- them means re-registering the device.
CREATE TABLE IF NOT EXISTS device_identity_keys (
  device_id        UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  registration_id  INTEGER NOT NULL,
  identity_key     BYTEA NOT NULL,
  signing_key      BYTEA NOT NULL,
  key_algorithm    TEXT NOT NULL DEFAULT 'x25519',
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Signed pre-keys ────────────────────────────────────────────────────────
-- Rotated periodically (~monthly). The current one for a device is the
-- row with the highest created_at; older rows are kept for late-arriving
-- handshakes that referenced the previous key.
CREATE TABLE IF NOT EXISTS signed_pre_keys (
  device_id        UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_id           INTEGER NOT NULL,
  public_key       BYTEA NOT NULL,
  signature        BYTEA NOT NULL,
  key_algorithm    TEXT NOT NULL DEFAULT 'x25519',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at       TIMESTAMPTZ,
  PRIMARY KEY (device_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_signed_pre_keys_current
  ON signed_pre_keys (device_id, created_at DESC)
  WHERE rotated_at IS NULL;

-- ── One-time pre-keys ──────────────────────────────────────────────────────
-- Each row is consumed by exactly one incoming handshake. The bundle
-- endpoint atomically marks one as consumed (UPDATE ... RETURNING) so
-- two concurrent handshakes can't claim the same key.
CREATE TABLE IF NOT EXISTS pre_keys (
  device_id        UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_id           INTEGER NOT NULL,
  public_key       BYTEA NOT NULL,
  key_algorithm    TEXT NOT NULL DEFAULT 'x25519',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at      TIMESTAMPTZ,
  PRIMARY KEY (device_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_pre_keys_unconsumed
  ON pre_keys (device_id, key_id)
  WHERE consumed_at IS NULL;

-- ── Message envelope columns ───────────────────────────────────────────────
-- Inline columns on `messages` rather than a sidecar table — null storage
-- cost is negligible (PostgreSQL's null bitmap), and avoids a JOIN on the
-- read-heavy message-history path. `encryption_version = 0` is the v0.8.0
-- default and means the ciphertext column carries plaintext.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS encryption_version  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sender_device_id    UUID REFERENCES devices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recipient_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pre_key_id          INTEGER,
  ADD COLUMN IF NOT EXISTS signed_pre_key_id   INTEGER;
