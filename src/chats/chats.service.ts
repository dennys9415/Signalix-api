import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ChatDTO,
  ChatType,
  DeleteChatForMeResponse,
  ErrorCode,
  LinkPreviewDTO,
  MarkChatReadResponse,
  MessageDTO,
  MessageLifecycleState,
  MessageReactionDTO,
  MessageType,
  ParticipantRole,
  ReplyPreviewDTO,
} from '@signalix/contracts';
import { DbService } from '../db/db.service';

interface ChatRow {
  chat_id: string;
  chat_type: string;
  created_by: string;
  chat_created_at: Date;
  participant_user_id: string;
  participant_role: string;
  joined_at: Date;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

interface MessageRow {
  id: string;
  chat_id: string;
  sender_id: string;
  ciphertext: string;
  message_type: string;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  is_forwarded: boolean;
  reply_to_id: string | null;
  reply_sender_id: string | null;
  reply_ciphertext: string | null;
  reply_deleted_at: Date | null;
  // pg returns the CASE aggregate as string; cast with Number()
  status_rank: string;
  // pg auto-parses json columns
  reactions_raw: Array<{ emoji: string; user_id: string }> | null;
  link_preview: Record<string, unknown> | null;
}

@Injectable()
export class ChatsService {
  constructor(private readonly db: DbService) {}

  async getUserChats(userId: string): Promise<ChatDTO[]> {
    const result = await this.db.query<ChatRow>(`
      SELECT
        c.id         AS chat_id,
        c.type       AS chat_type,
        c.created_by,
        c.created_at AS chat_created_at,
        cp.user_id   AS participant_user_id,
        cp.role      AS participant_role,
        cp.joined_at,
        u.username,
        u.display_name,
        u.avatar_url
      FROM chats c
      JOIN chat_participants cp ON cp.chat_id = c.id
      JOIN users u              ON u.id = cp.user_id
      WHERE c.id IN (
        SELECT chat_id FROM chat_participants WHERE user_id = $1
      )
      AND NOT EXISTS (
        SELECT 1 FROM chat_deletions cd WHERE cd.chat_id = c.id AND cd.user_id = $1
      )
      ORDER BY c.updated_at DESC, c.id
    `, [userId]);

    // Group rows by chat, preserving the ORDER BY updated_at DESC order.
    const chatsMap = new Map<string, ChatDTO>();

    for (const row of result.rows) {
      if (!chatsMap.has(row.chat_id)) {
        chatsMap.set(row.chat_id, {
          id: row.chat_id,
          type: row.chat_type as ChatType,
          createdBy: row.created_by,
          createdAt: row.chat_created_at.toISOString(),
          participants: [],
          unreadCount: 0,
        });
      }

      chatsMap.get(row.chat_id)!.participants.push({
        chatId: row.chat_id,
        userId: row.participant_user_id,
        role: row.participant_role as ParticipantRole,
        joinedAt: row.joined_at.toISOString(),
        user: {
          id: row.participant_user_id,
          username: row.username,
          displayName: row.display_name,
          ...(row.avatar_url !== null && { avatarUrl: row.avatar_url }),
        },
      });
    }

    if (chatsMap.size === 0) return [];

    // Compute server-side unread counts for all chats in one query.
    const chatIds = Array.from(chatsMap.keys());
    const unreadResult = await this.db.query<{ chat_id: string; unread_count: string }>(`
      SELECT m.chat_id, COUNT(*)::text AS unread_count
      FROM messages m
      WHERE m.chat_id = ANY($1::uuid[])
        AND m.sender_id != $2
        AND m.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM message_deletions md WHERE md.message_id = m.id AND md.user_id = $2
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat_deletions cd WHERE cd.chat_id = m.chat_id AND cd.user_id = $2
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM chat_read_state crs WHERE crs.chat_id = m.chat_id AND crs.user_id = $2
          )
          OR m.created_at > (
            SELECT crs.last_read_at FROM chat_read_state crs
            WHERE crs.chat_id = m.chat_id AND crs.user_id = $2
          )
        )
      GROUP BY m.chat_id
    `, [chatIds, userId]);

    for (const row of unreadResult.rows) {
      const chat = chatsMap.get(row.chat_id);
      if (chat) chat.unreadCount = Number(row.unread_count);
    }

    return Array.from(chatsMap.values());
  }

  async markChatRead(chatId: string, userId: string): Promise<MarkChatReadResponse> {
    const memberCheck = await this.db.query(
      'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );

    if (memberCheck.rows.length === 0) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Not a participant in this chat.',
      });
    }

    const result = await this.db.query<{ last_read_message_id: string | null; last_read_at: Date }>(`
      INSERT INTO chat_read_state (chat_id, user_id, last_read_message_id, last_read_at, updated_at)
      SELECT $1, $2,
        (
          SELECT id FROM messages
          WHERE chat_id = $1
            AND deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM message_deletions WHERE message_id = messages.id AND user_id = $2
            )
          ORDER BY created_at DESC
          LIMIT 1
        ),
        NOW(), NOW()
      ON CONFLICT (chat_id, user_id) DO UPDATE
        SET last_read_message_id = EXCLUDED.last_read_message_id,
            last_read_at         = EXCLUDED.last_read_at,
            updated_at           = NOW()
      RETURNING last_read_message_id, last_read_at
    `, [chatId, userId]);

    const row = result.rows[0];
    return {
      chatId,
      ...(row.last_read_message_id !== null && { lastReadMessageId: row.last_read_message_id }),
      lastReadAt: row.last_read_at.toISOString(),
    };
  }

  // Messages ordered DESC (newest first) per page.
  // `cursor`  — base64-encoded ISO timestamp from the previous page's nextCursor.
  // `before`  — plain ISO timestamp; used when cursor is absent.
  // `nextCursor` in the response is base64(last_message.created_at.toISOString()).
  async getMessages(
    chatId: string,
    userId: string,
    limit: number,
    cursor: string | undefined,
    before: string | undefined,
  ): Promise<{ messages: MessageDTO[]; nextCursor: string | undefined; hasMore: boolean }> {
    const memberCheck = await this.db.query(
      'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );

    if (memberCheck.rows.length === 0) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Not a participant in this chat.',
      });
    }

    // Resolve the upper-bound timestamp for keyset pagination
    let beforeTs: string | undefined;
    if (cursor) {
      beforeTs = Buffer.from(cursor, 'base64').toString('utf-8');
    } else if (before) {
      beforeTs = before;
    }

    // $1 = chatId, $2 = userId (for message_deletions exclusion)
    // Include messages deleted for everyone (shown as placeholders).
    // Exclude only personal deletions on messages that are NOT globally deleted.
    const conditions: string[] = [
      'm.chat_id = $1',
      '(m.deleted_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM message_deletions md WHERE md.message_id = m.id AND md.user_id = $2))',
    ];
    const params: unknown[] = [chatId, userId];
    let nextIdx = 3;

    if (beforeTs) {
      conditions.push(`m.created_at < $${nextIdx}::timestamptz`);
      params.push(beforeTs);
      nextIdx++;
    }

    params.push(limit + 1);

    const result = await this.db.query<MessageRow>(`
      SELECT
        m.id,
        m.chat_id,
        m.sender_id,
        m.ciphertext,
        m.message_type,
        m.created_at,
        m.edited_at,
        m.deleted_at,
        m.is_forwarded,
        m.link_preview,
        m.reply_to       AS reply_to_id,
        rm.sender_id     AS reply_sender_id,
        rm.ciphertext    AS reply_ciphertext,
        rm.deleted_at    AS reply_deleted_at,
        COALESCE(MAX(CASE ms.status
          WHEN 'read'      THEN 3
          WHEN 'delivered' THEN 2
          WHEN 'sent'      THEN 1
          ELSE 0
        END), 0) AS status_rank,
        (
          SELECT json_agg(json_build_object('emoji', r.emoji, 'user_id', r.user_id))
          FROM message_reactions r
          WHERE r.message_id = m.id
        ) AS reactions_raw
      FROM messages m
      LEFT JOIN messages rm ON rm.id = m.reply_to
      LEFT JOIN message_status ms ON ms.message_id = m.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY m.id, rm.sender_id, rm.ciphertext, rm.deleted_at
      ORDER BY m.created_at DESC
      LIMIT $${nextIdx}
    `, params);

    const hasMore = result.rows.length > limit;
    const page = hasMore ? result.rows.slice(0, limit) : result.rows;

    const messages: MessageDTO[] = page.map((row) => {
      const isDeletedForEveryone = row.deleted_at !== null;
      const reactions = buildReactions(row.reactions_raw);
      const replyTo: ReplyPreviewDTO | undefined =
        row.reply_to_id && row.reply_sender_id && !row.reply_deleted_at
          ? { messageId: row.reply_to_id, senderId: row.reply_sender_id, ciphertext: row.reply_ciphertext! }
          : undefined;
      return {
        id: row.id,
        chatId: row.chat_id,
        senderId: row.sender_id,
        // Censor content for globally-deleted messages; client shows a placeholder
        ciphertext: isDeletedForEveryone ? '' : row.ciphertext,
        messageType: row.message_type as MessageType,
        state: rankToLifecycleState(Number(row.status_rank)),
        createdAt: row.created_at.toISOString(),
        ...(row.edited_at !== null && !isDeletedForEveryone && { editedAt: row.edited_at.toISOString() }),
        ...(isDeletedForEveryone && { deletedAt: row.deleted_at!.toISOString() }),
        ...(reactions.length > 0 && { reactions }),
        ...(replyTo && !isDeletedForEveryone && { replyTo }),
        ...(row.is_forwarded && { isForwarded: true }),
        ...(row.link_preview && !isDeletedForEveryone && { linkPreview: row.link_preview as unknown as LinkPreviewDTO }),
      };
    });

    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? Buffer.from(lastRow.created_at.toISOString()).toString('base64')
        : undefined;

    return { messages, nextCursor, hasMore };
  }

  async deleteChatForMe(chatId: string, userId: string): Promise<DeleteChatForMeResponse> {
    const memberCheck = await this.db.query(
      'SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );

    if (memberCheck.rows.length === 0) {
      throw new NotFoundException({
        code: ErrorCode.CHAT_NOT_FOUND,
        message: 'Chat not found.',
      });
    }

    const result = await this.db.query<{ deleted_at: Date }>(`
      INSERT INTO chat_deletions (chat_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (chat_id, user_id) DO UPDATE
        SET deleted_at = chat_deletions.deleted_at
      RETURNING deleted_at
    `, [chatId, userId]);

    return { chatId, deletedAt: result.rows[0].deleted_at.toISOString() };
  }
}

function rankToLifecycleState(rank: number): MessageLifecycleState {
  if (rank >= 3) return MessageLifecycleState.READ;
  if (rank === 2) return MessageLifecycleState.DELIVERED;
  if (rank === 1) return MessageLifecycleState.SENT;
  return MessageLifecycleState.CREATED;
}

function buildReactions(
  raw: Array<{ emoji: string; user_id: string }> | null,
): MessageReactionDTO[] {
  if (!raw || raw.length === 0) return [];
  const map = new Map<string, string[]>();
  for (const r of raw) {
    const ids = map.get(r.emoji) ?? [];
    ids.push(r.user_id);
    map.set(r.emoji, ids);
  }
  return Array.from(map.entries()).map(([emoji, userIds]) => ({
    emoji,
    count: userIds.length,
    userIds,
  }));
}
