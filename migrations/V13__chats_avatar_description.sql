-- v0.7.0 — Group chat metadata
--
-- Adds two optional columns on `chats` used by group chats:
--   * avatar_url  — public URL pointing to the group image in the
--                   signalix-avatars bucket under `chats/{chatId}/...`.
--   * description — plain-text group description, owner/admin editable.
--
-- Both columns are nullable; direct chats leave them NULL.

ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS avatar_url  TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT;
