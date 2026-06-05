CREATE TABLE chat_read_state (
  chat_id             UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  last_read_at        TIMESTAMP WITHOUT TIME ZONE,
  updated_at          TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);
