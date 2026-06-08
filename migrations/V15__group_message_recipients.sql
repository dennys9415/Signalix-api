-- v0.10.0 — Group E2EE beta
--
-- Per-recipient encrypted payloads for group text messages. Each group
-- encrypted send writes one row in `messages` with empty ciphertext and
-- `encryption_version = 1`, plus N rows here (one per recipient device
-- that should be able to decrypt). The `getMessages` path joins this
-- table on `recipient_user_id = caller.id` and replaces the empty
-- top-level ciphertext + envelope columns with the row's per-recipient
-- values before returning the DTO.
--
-- The sender does not appear in this table — sender history is served
-- by the local plaintext cache in the browser (same mechanism as v0.9.x
-- direct E2EE). A new joiner has no row for old messages and therefore
-- can't decrypt them, which is the v0.10.0 beta's intended property.
--
-- v0.11.0+ replaces this fan-out with Sender Keys.

CREATE TABLE IF NOT EXISTS group_message_recipients (
  message_id          UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_user_id   UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  recipient_device_id UUID NOT NULL REFERENCES devices(id)  ON DELETE CASCADE,
  ciphertext          TEXT NOT NULL,
  encryption_version  INTEGER NOT NULL DEFAULT 1,
  pre_key_id          INTEGER,
  signed_pre_key_id   INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, recipient_user_id, recipient_device_id)
);

-- Read path: every history-fetch hits this with (recipient_user_id, message_id),
-- so the index covers it directly.
CREATE INDEX IF NOT EXISTS idx_group_message_recipients_user
  ON group_message_recipients (recipient_user_id, message_id);
