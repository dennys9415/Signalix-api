-- v0.6.0 — Web Push subscriptions
--
-- Stores one row per (user, device endpoint). A single user may have many
-- subscriptions (one per device/browser). Endpoints are URL-shaped and unique
-- per push service, so we de-duplicate within the same user.
--
-- p256dh / auth are the public key + auth secret returned by PushSubscription
-- in the browser. They are not credentials in the user-auth sense; they are
-- per-device opaque bytes the browser needs to encrypt payloads.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT push_subscriptions_user_endpoint_unique UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON push_subscriptions (user_id);
