import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ChatType,
  DeleteMessageForEveryoneResponse,
  DeleteMessageForMeResponse,
  EditMessageResponse,
  ErrorCode,
  MessageDTO,
  MessageLifecycleState,
  MessageReactionDTO,
  MessageSearchResultDTO,
  MessageStatus,
  MessageStatusDTO,
  MessageType,
  ReactionResponse,
  ReplyPreviewDTO,
  SearchMessagesResponse,
  SendMessageResponse,
} from '@signalix/contracts';
import { DbService } from '../db/db.service';
import { LinkPreviewService } from '../link-preview/link-preview.service';
import { PushService } from '../push/push.service';
import type { SendMessageDto } from './dto/send-message.dto';

interface MessageStatusRow {
  message_id: string;
  user_id: string;
  status: string;
  timestamp: Date;
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly db: DbService,
    private readonly linkPreview: LinkPreviewService,
    private readonly push: PushService,
  ) {}

  async sendMessage(
    senderId: string,
    dto: SendMessageDto,
  ): Promise<SendMessageResponse> {
    const result = await this.db.transaction(async (client) => {
      let chatId: string;

      if (dto.chatId) {
        const check = await client.query(
          'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
          [dto.chatId, senderId],
        );
        if (check.rows.length === 0) {
          throw new ForbiddenException({
            code: ErrorCode.FORBIDDEN,
            message: 'Not a participant in this chat.',
          });
        }
        chatId = dto.chatId;
      } else if (dto.recipientUsername) {
        const recipientResult = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE username = $1',
          [dto.recipientUsername.toLowerCase()],
        );

        const recipientId = recipientResult.rows[0]?.id;
        if (!recipientId) {
          throw new NotFoundException({
            code: ErrorCode.USER_NOT_FOUND,
            message: 'User not found.',
          });
        }
        if (recipientId === senderId) {
          throw new BadRequestException({
            code: ErrorCode.VALIDATION_ERROR,
            message: 'Cannot send a message to yourself.',
          });
        }

        const pairKey = buildDirectPairKey(senderId, recipientId);
        const newChatId = randomUUID();

        // INSERT the chat; if a concurrent request already created it, DO UPDATE
        // is a no-op that still triggers RETURNING so we get the winning id back.
        const chatResult = await client.query<{ id: string }>(`
          INSERT INTO chats (id, type, created_by, direct_pair_key)
          VALUES ($1, 'direct', $2, $3)
          ON CONFLICT (direct_pair_key) DO UPDATE SET updated_at = chats.updated_at
          RETURNING id
        `, [newChatId, senderId, pairKey]);

        chatId = chatResult.rows[0].id;
        const isNew = chatId === newChatId;

        if (isNew) {
          await client.query(`
            INSERT INTO chat_participants (chat_id, user_id, role)
            VALUES ($1, $2, 'owner'), ($1, $3, 'member')
          `, [chatId, senderId, recipientId]);
        }
      } else {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Either chatId or recipientUsername is required.',
        });
      }

      // Validate and resolve reply preview
      let replyTo: ReplyPreviewDTO | undefined;
      if (dto.replyToMessageId) {
        const replyRow = await client.query<{
          chat_id: string;
          sender_id: string;
          ciphertext: string;
          deleted_at: Date | null;
        }>(
          'SELECT chat_id, sender_id, ciphertext, deleted_at FROM messages WHERE id = $1',
          [dto.replyToMessageId],
        );
        if (!replyRow.rows[0] || replyRow.rows[0].chat_id !== chatId) {
          throw new BadRequestException({
            code: ErrorCode.VALIDATION_ERROR,
            message: 'Invalid reply target.',
          });
        }
        if (!replyRow.rows[0].deleted_at) {
          replyTo = {
            messageId: dto.replyToMessageId,
            senderId: replyRow.rows[0].sender_id,
            ciphertext: replyRow.rows[0].ciphertext,
          };
        }
      }

      const msgId = randomUUID();
      const now = new Date();

      await client.query(`
        INSERT INTO messages (id, chat_id, sender_id, ciphertext, message_type, reply_to, is_forwarded)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [msgId, chatId, senderId, dto.ciphertext, dto.messageType, dto.replyToMessageId ?? null, dto.isForwarded ?? false]);

      await client.query(
        'INSERT INTO message_status (message_id, user_id, status) VALUES ($1, $2, $3)',
        [msgId, senderId, MessageStatus.SENT],
      );

      await client.query(
        'UPDATE chats SET updated_at = NOW() WHERE id = $1',
        [chatId],
      );


      const message: MessageDTO = {
        id: msgId,
        chatId,
        senderId,
        ciphertext: dto.ciphertext,
        messageType: dto.messageType,
        state: MessageLifecycleState.SENT,
        createdAt: now.toISOString(),
        ...(replyTo && { replyTo }),
        ...(dto.isForwarded && { isForwarded: true }),
      };

      return {
        message,
        chatId,
        ...(dto.tempId ? { tempId: dto.tempId } : {}),
      };
    });

    // Fire-and-forget push notifications to offline participants.
    // Never block or throw — push is best-effort.
    void this.dispatchPushNotifications(senderId, result.message).catch((err) => {
      this.logger.warn(`Push dispatch failed: ${(err as Error).message}`);
    });

    // Generate link preview after transaction — failure must never block the send
    if (result.message.messageType === MessageType.TEXT) {
      const url = this.linkPreview.extractFirstUrl(result.message.ciphertext);
      if (url) {
        try {
          const preview = await this.linkPreview.fetchPreview(url);
          if (preview) {
            await this.db.query(
              'UPDATE messages SET link_preview = $1 WHERE id = $2',
              [JSON.stringify(preview), result.message.id],
            );
            return { ...result, message: { ...result.message, linkPreview: preview } };
          }
        } catch { /* preview errors must not surface to the caller */ }
      }
    }

    return result;
  }

  /**
   * Push to offline participants of `chatId`, excluding the sender.
   * A participant is "offline" if their presence row says so, or if they
   * have no presence row at all (never connected this session).
   */
  private async dispatchPushNotifications(
    senderId: string,
    message: MessageDTO,
  ): Promise<void> {
    // Resolve sender display info for the notification title + icon.
    const senderRow = await this.db.query<{
      display_name: string | null;
      username: string;
      avatar_url: string | null;
    }>(
      'SELECT display_name, username, avatar_url FROM users WHERE id = $1',
      [senderId],
    );
    const sender = senderRow.rows[0];
    if (!sender) return;
    const senderName = sender.display_name ?? sender.username;

    // Offline = no presence row OR status != 'online'. LEFT JOIN handles the
    // "never connected" case for newly-created accounts.
    const recipientsRow = await this.db.query<{ user_id: string }>(
      `
      SELECT cp.user_id
      FROM chat_participants cp
      LEFT JOIN presence p ON p.user_id = cp.user_id
      WHERE cp.chat_id = $1
        AND cp.user_id <> $2
        AND (p.status IS NULL OR p.status <> 'online')
      `,
      [message.chatId, senderId],
    );

    if (recipientsRow.rows.length === 0) return;

    const body = previewForPush(message.ciphertext, message.messageType);
    const payload = {
      title: senderName,
      body,
      chatId: message.chatId,
      avatarUrl: sender.avatar_url,
    };

    await Promise.all(
      recipientsRow.rows.map((r) => this.push.sendToUser(r.user_id, payload)),
    );
  }

  async updateStatus(
    messageId: string,
    userId: string,
    status: MessageStatus.DELIVERED | MessageStatus.READ,
  ): Promise<MessageStatusDTO> {
    // Resolve chat for this message
    const msgResult = await this.db.query<{ chat_id: string }>(
      'SELECT chat_id FROM messages WHERE id = $1 AND deleted_at IS NULL',
      [messageId],
    );

    if (!msgResult.rows[0]) {
      throw new NotFoundException({
        code: ErrorCode.MESSAGE_NOT_FOUND,
        message: 'Message not found.',
      });
    }

    // Verify requester is a participant
    const participantCheck = await this.db.query(
      'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
      [msgResult.rows[0].chat_id, userId],
    );

    if (participantCheck.rows.length === 0) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Not a participant in this chat.',
      });
    }

    // Upsert: only advance status, never downgrade.
    // READ always wins. The WHERE clause compares ranks and skips
    // the update if the stored status is already >= the requested one.
    const upsertResult = await this.db.query<MessageStatusRow>(`
      INSERT INTO message_status (message_id, user_id, status, timestamp)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (message_id, user_id) DO UPDATE
        SET status    = EXCLUDED.status,
            timestamp = NOW()
        WHERE CASE message_status.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 ELSE 1 END
            < CASE EXCLUDED.status      WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 ELSE 1 END
      RETURNING message_id, user_id, status, timestamp
    `, [messageId, userId, status]);

    if (upsertResult.rows.length > 0) {
      return toStatusDTO(upsertResult.rows[0]);
    }

    // Status was already at the same level or higher — return the current row
    const currentResult = await this.db.query<MessageStatusRow>(
      'SELECT message_id, user_id, status, timestamp FROM message_status WHERE message_id = $1 AND user_id = $2',
      [messageId, userId],
    );

    return toStatusDTO(currentResult.rows[0]);
  }

  async deleteForMe(
    messageId: string,
    userId: string,
  ): Promise<DeleteMessageForMeResponse> {
    const msgResult = await this.db.query<{ chat_id: string }>(
      'SELECT chat_id FROM messages WHERE id = $1 AND deleted_at IS NULL',
      [messageId],
    );

    if (!msgResult.rows[0]) {
      throw new NotFoundException({
        code: ErrorCode.MESSAGE_NOT_FOUND,
        message: 'Message not found.',
      });
    }

    const participantCheck = await this.db.query(
      'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
      [msgResult.rows[0].chat_id, userId],
    );

    if (participantCheck.rows.length === 0) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Not a participant in this chat.',
      });
    }

    // Idempotent: if the row exists, the DO UPDATE is a no-op that still returns deleted_at.
    const result = await this.db.query<{ deleted_at: Date }>(`
      INSERT INTO message_deletions (message_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (message_id, user_id) DO UPDATE
        SET deleted_at = message_deletions.deleted_at
      RETURNING deleted_at
    `, [messageId, userId]);

    return {
      messageId,
      deletedAt: result.rows[0].deleted_at.toISOString(),
    };
  }

  async deleteForEveryone(
    messageId: string,
    userId: string,
  ): Promise<DeleteMessageForEveryoneResponse> {
    const msgResult = await this.db.query<{
      chat_id: string;
      sender_id: string;
      deleted_at: Date | null;
    }>(
      'SELECT chat_id, sender_id, deleted_at FROM messages WHERE id = $1',
      [messageId],
    );

    if (!msgResult.rows[0]) {
      throw new NotFoundException({
        code: ErrorCode.MESSAGE_NOT_FOUND,
        message: 'Message not found.',
      });
    }

    const { chat_id: chatId, sender_id: senderId, deleted_at: existingDeletedAt } =
      msgResult.rows[0];

    if (senderId !== userId) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Only the sender can delete this message for everyone.',
      });
    }

    const participantCheck = await this.db.query(
      'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );

    if (participantCheck.rows.length === 0) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Not a participant in this chat.',
      });
    }

    // Idempotent: already deleted — return existing timestamp
    if (existingDeletedAt) {
      return { messageId, chatId, deletedAt: existingDeletedAt.toISOString() };
    }

    const result = await this.db.query<{ deleted_at: Date }>(
      'UPDATE messages SET deleted_at = NOW() WHERE id = $1 RETURNING deleted_at',
      [messageId],
    );

    return { messageId, chatId, deletedAt: result.rows[0].deleted_at.toISOString() };
  }

  async editMessage(
    messageId: string,
    userId: string,
    ciphertext: string,
  ): Promise<EditMessageResponse> {
    const msgResult = await this.db.query<{
      chat_id: string;
      sender_id: string;
      deleted_at: Date | null;
    }>(
      'SELECT chat_id, sender_id, deleted_at FROM messages WHERE id = $1',
      [messageId],
    );

    if (!msgResult.rows[0]) {
      throw new NotFoundException({
        code: ErrorCode.MESSAGE_NOT_FOUND,
        message: 'Message not found.',
      });
    }

    const { chat_id: chatId, sender_id: senderId, deleted_at: deletedAt } = msgResult.rows[0];

    if (senderId !== userId) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Only the sender can edit this message.',
      });
    }

    if (deletedAt) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Cannot edit a deleted message.',
      });
    }

    const participantCheck = await this.db.query(
      'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );

    if (participantCheck.rows.length === 0) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Not a participant in this chat.',
      });
    }

    const result = await this.db.query<{ edited_at: Date }>(
      'UPDATE messages SET ciphertext = $1, edited_at = NOW() WHERE id = $2 RETURNING edited_at',
      [ciphertext, messageId],
    );

    return {
      messageId,
      chatId,
      ciphertext,
      editedAt: result.rows[0].edited_at.toISOString(),
    };
  }

  async setReaction(
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<ReactionResponse> {
    const msgResult = await this.db.query<{ chat_id: string; deleted_at: Date | null }>(
      'SELECT chat_id, deleted_at FROM messages WHERE id = $1',
      [messageId],
    );

    if (!msgResult.rows[0]) {
      throw new NotFoundException({
        code: ErrorCode.MESSAGE_NOT_FOUND,
        message: 'Message not found.',
      });
    }

    const { chat_id: chatId, deleted_at: deletedAt } = msgResult.rows[0];

    if (deletedAt) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Cannot react to a deleted message.',
      });
    }

    const participantCheck = await this.db.query(
      'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );

    if (participantCheck.rows.length === 0) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Not a participant in this chat.',
      });
    }

    await this.db.query(`
      INSERT INTO message_reactions (message_id, user_id, emoji)
      VALUES ($1, $2, $3)
      ON CONFLICT (message_id, user_id) DO UPDATE
        SET emoji = EXCLUDED.emoji, created_at = NOW()
    `, [messageId, userId, emoji]);

    const reactions = await this.getReactionsForMessage(messageId);
    return { messageId, chatId, reactions };
  }

  async removeReaction(
    messageId: string,
    userId: string,
  ): Promise<ReactionResponse> {
    const msgResult = await this.db.query<{ chat_id: string }>(
      'SELECT chat_id FROM messages WHERE id = $1',
      [messageId],
    );

    if (!msgResult.rows[0]) {
      throw new NotFoundException({
        code: ErrorCode.MESSAGE_NOT_FOUND,
        message: 'Message not found.',
      });
    }

    const { chat_id: chatId } = msgResult.rows[0];

    const participantCheck = await this.db.query(
      'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );

    if (participantCheck.rows.length === 0) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Not a participant in this chat.',
      });
    }

    await this.db.query(
      'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2',
      [messageId, userId],
    );

    const reactions = await this.getReactionsForMessage(messageId);
    return { messageId, chatId, reactions };
  }

  /**
   * Case-insensitive substring search over the caller's accessible TEXT
   * messages. Honours per-user message deletions and chat-level visibility
   * cutoffs. Keyset paginates by `created_at DESC`; cursor is base64(ISO).
   */
  async searchMessages(
    userId: string,
    q: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<SearchMessagesResponse> {
    // Escape LIKE metacharacters in user input so a query like "50%" doesn't
    // become a wildcard. The ESCAPE clause on the SQL side pairs with this.
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;

    let beforeTs: string | undefined;
    if (cursor) {
      try {
        beforeTs = Buffer.from(cursor, 'base64').toString('utf-8');
      } catch {
        beforeTs = undefined;
      }
    }

    const params: unknown[] = [userId, pattern];
    let idx = 3;
    let cursorClause = '';
    if (beforeTs) {
      cursorClause = `AND m.created_at < $${idx}::timestamptz`;
      params.push(beforeTs);
      idx += 1;
    }
    params.push(limit + 1);

    interface Row {
      message_id: string;
      chat_id: string;
      chat_type: string;
      chat_label: string | null;
      chat_avatar_url: string | null;
      sender_id: string;
      sender_display_name: string | null;
      sender_username: string;
      sender_avatar_url: string | null;
      ciphertext: string;
      created_at: Date;
    }

    const result = await this.db.query<Row>(
      `
      SELECT
        m.id          AS message_id,
        m.chat_id,
        c.type        AS chat_type,
        CASE
          WHEN c.type = 'group' THEN c.title
          ELSE COALESCE(other_user.display_name, other_user.username)
        END AS chat_label,
        CASE
          WHEN c.type = 'group' THEN c.avatar_url
          ELSE other_user.avatar_url
        END AS chat_avatar_url,
        m.sender_id,
        sender.display_name AS sender_display_name,
        sender.username     AS sender_username,
        sender.avatar_url   AS sender_avatar_url,
        LEFT(m.ciphertext, 280) AS ciphertext,
        m.created_at
      FROM messages m
      JOIN chats c       ON c.id = m.chat_id
      JOIN users sender  ON sender.id = m.sender_id
      LEFT JOIN LATERAL (
        SELECT u.display_name, u.username, u.avatar_url
        FROM chat_participants cp
        JOIN users u ON u.id = cp.user_id
        WHERE cp.chat_id = c.id AND cp.user_id <> $1
        LIMIT 1
      ) other_user ON c.type = 'direct'
      WHERE m.message_type = 'text'
        AND m.deleted_at IS NULL
        AND m.ciphertext ILIKE $2 ESCAPE '\\'
        AND EXISTS (
          SELECT 1 FROM chat_participants cp
          WHERE cp.chat_id = m.chat_id AND cp.user_id = $1
        )
        AND NOT EXISTS (
          SELECT 1 FROM message_deletions md
          WHERE md.message_id = m.id AND md.user_id = $1
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat_deletions cd
          WHERE cd.chat_id = m.chat_id
            AND cd.user_id = $1
            AND m.created_at <= cd.deleted_at
        )
        ${cursorClause}
      ORDER BY m.created_at DESC
      LIMIT $${idx}
      `,
      params,
    );

    const hasMore = result.rows.length > limit;
    const page = hasMore ? result.rows.slice(0, limit) : result.rows;

    const results: MessageSearchResultDTO[] = page.map((row) => ({
      messageId: row.message_id,
      chatId: row.chat_id,
      chatType: row.chat_type as ChatType,
      chatLabel: row.chat_label ?? '',
      ...(row.chat_avatar_url !== null && { chatAvatarUrl: row.chat_avatar_url }),
      senderId: row.sender_id,
      senderName: row.sender_display_name ?? row.sender_username,
      ...(row.sender_avatar_url !== null && { senderAvatarUrl: row.sender_avatar_url }),
      ciphertext: row.ciphertext,
      createdAt: row.created_at.toISOString(),
    }));

    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? Buffer.from(lastRow.created_at.toISOString()).toString('base64')
        : undefined;

    return {
      results,
      pagination: {
        hasMore,
        ...(nextCursor !== undefined && { nextCursor }),
      },
    };
  }

  private async getReactionsForMessage(messageId: string): Promise<MessageReactionDTO[]> {
    const result = await this.db.query<{ emoji: string; user_id: string }>(
      'SELECT emoji, user_id FROM message_reactions WHERE message_id = $1 ORDER BY created_at',
      [messageId],
    );

    const emojiMap = new Map<string, string[]>();
    for (const row of result.rows) {
      const ids = emojiMap.get(row.emoji) ?? [];
      ids.push(row.user_id);
      emojiMap.set(row.emoji, ids);
    }

    return Array.from(emojiMap.entries()).map(([emoji, userIds]) => ({
      emoji,
      count: userIds.length,
      userIds,
    }));
  }
}

function buildDirectPairKey(a: string, b: string): string {
  return [a, b].sort().join(':');
}

function previewForPush(ciphertext: string, type: MessageType): string {
  if (type === MessageType.IMAGE) return '📷 Photo';
  if (type === MessageType.AUDIO) return '🎙️ Voice message';
  if (type === MessageType.FILE) {
    try {
      const parsed = JSON.parse(ciphertext) as { name?: unknown };
      return typeof parsed.name === 'string' ? `📎 ${parsed.name}` : '📎 File';
    } catch {
      return '📎 File';
    }
  }
  const trimmed = ciphertext.trim();
  return trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed;
}

function toStatusDTO(row: MessageStatusRow): MessageStatusDTO {
  return {
    messageId: row.message_id,
    userId: row.user_id,
    status: row.status as MessageStatus,
    timestamp: row.timestamp.toISOString(),
  };
}
