import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  ChatDTO,
  ChatType,
  ErrorCode,
  MessageDTO,
  MessageLifecycleState,
  MessageType,
  ParticipantRole,
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
  // pg returns the CASE aggregate as string; cast with Number()
  status_rank: string;
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

    return Array.from(chatsMap.values());
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
    const conditions: string[] = [
      'm.chat_id = $1',
      'm.deleted_at IS NULL',
      'NOT EXISTS (SELECT 1 FROM message_deletions md WHERE md.message_id = m.id AND md.user_id = $2)',
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
        COALESCE(MAX(CASE ms.status
          WHEN 'read'      THEN 3
          WHEN 'delivered' THEN 2
          WHEN 'sent'      THEN 1
          ELSE 0
        END), 0) AS status_rank
      FROM messages m
      LEFT JOIN message_status ms ON ms.message_id = m.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY m.id
      ORDER BY m.created_at DESC
      LIMIT $${nextIdx}
    `, params);

    const hasMore = result.rows.length > limit;
    const page = hasMore ? result.rows.slice(0, limit) : result.rows;

    const messages: MessageDTO[] = page.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      ciphertext: row.ciphertext,
      messageType: row.message_type as MessageType,
      state: rankToLifecycleState(Number(row.status_rank)),
      createdAt: row.created_at.toISOString(),
      ...(row.edited_at !== null && { editedAt: row.edited_at.toISOString() }),
      ...(row.deleted_at !== null && { deletedAt: row.deleted_at.toISOString() }),
    }));

    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? Buffer.from(lastRow.created_at.toISOString()).toString('base64')
        : undefined;

    return { messages, nextCursor, hasMore };
  }
}

function rankToLifecycleState(rank: number): MessageLifecycleState {
  if (rank >= 3) return MessageLifecycleState.READ;
  if (rank === 2) return MessageLifecycleState.DELIVERED;
  if (rank === 1) return MessageLifecycleState.SENT;
  return MessageLifecycleState.CREATED;
}
