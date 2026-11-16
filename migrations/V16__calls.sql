-- v0.17.0 — 1:1 voice / video calls
--
-- Call log only. Media never touches the server (WebRTC P2P / TURN);
-- signaling is routed in-memory by Signalix-realtime, which drives the
-- lifecycle here through POST /calls, /calls/:id/accept and /calls/:id/end.
--
-- `id` is generated client-side (caller device) so ICE candidates can be
-- correlated before the API round trip completes.

CREATE TABLE IF NOT EXISTS calls (
  id           UUID PRIMARY KEY,
  chat_id      UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  caller_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_type    VARCHAR(10) NOT NULL,
  status       VARCHAR(10) NOT NULL DEFAULT 'ringing',
  end_reason   VARCHAR(20),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at  TIMESTAMPTZ,
  ended_at     TIMESTAMPTZ,
  CHECK (call_type IN ('audio', 'video')),
  CHECK (status IN ('ringing', 'active', 'ended')),
  CHECK (end_reason IS NULL OR end_reason IN
    ('completed', 'missed', 'rejected', 'busy', 'cancelled', 'unavailable', 'failed'))
);

-- History reads: "my calls, newest first" from either side.
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls (caller_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls (callee_id, started_at DESC);
