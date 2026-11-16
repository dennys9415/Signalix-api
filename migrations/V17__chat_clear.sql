-- Clear chat: reuse the chat_deletions cutoff (messages up to deleted_at are
-- hidden for that user) but keep the chat in the list. Delete-for-me rows keep
-- the old behaviour (chat hidden until a newer message arrives).
ALTER TABLE chat_deletions ADD COLUMN keep_in_list BOOLEAN NOT NULL DEFAULT FALSE;
