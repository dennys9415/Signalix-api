import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import {
  ChatDTO,
  ChatParticipantDTO,
  ChatType,
  DeleteChatForMeResponse,
  ErrorCode,
  GroupAvatarUploadResponse,
  GroupMemberUpdateResponse,
  InChatSearchMatchDTO,
  LinkPreviewDTO,
  MarkChatReadResponse,
  MessageDTO,
  MessageLifecycleState,
  MessageReactionDTO,
  MessageType,
  ParticipantRole,
  RemoveGroupMemberResponse,
  ReplyPreviewDTO,
  SearchInChatResponse,
  TransferGroupOwnershipResponse,
  UpdateGroupChatRequest,
  UpdateGroupChatResponse,
} from '@signalix/contracts';
import { DbService } from '../db/db.service';
import { StorageService } from '../storage/storage.service';

const ALLOWED_AVATAR_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

interface ChatRow {
  chat_id: string;
  chat_type: string;
  chat_title: string | null;
  chat_avatar_url: string | null;
  chat_description: string | null;
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
  // v0.8.0 encryption envelope columns. encryption_version is NOT NULL
  // (default 0) so it always comes back as an integer.
  encryption_version: number;
  sender_device_id: string | null;
  recipient_device_id: string | null;
  pre_key_id: number | null;
  signed_pre_key_id: number | null;
}

@Injectable()
export class ChatsService {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
  ) {}

  async getUserChats(userId: string): Promise<ChatDTO[]> {
    const result = await this.db.query<ChatRow>(`
      SELECT
        c.id          AS chat_id,
        c.type        AS chat_type,
        c.title       AS chat_title,
        c.avatar_url  AS chat_avatar_url,
        c.description AS chat_description,
        c.created_by,
        c.created_at  AS chat_created_at,
        cp.user_id    AS participant_user_id,
        cp.role       AS participant_role,
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
        SELECT 1 FROM chat_deletions cd
        WHERE cd.chat_id = c.id
          AND cd.user_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM messages m2
            WHERE m2.chat_id = c.id AND m2.created_at > cd.deleted_at
          )
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
          ...(row.chat_title !== null && { title: row.chat_title }),
          ...(row.chat_avatar_url !== null && { avatarUrl: row.chat_avatar_url }),
          ...(row.chat_description !== null && { description: row.chat_description }),
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
        AND NOT (
          EXISTS (SELECT 1 FROM chat_deletions cd WHERE cd.chat_id = m.chat_id AND cd.user_id = $2)
          AND m.created_at <= (
            SELECT cd2.deleted_at FROM chat_deletions cd2
            WHERE cd2.chat_id = m.chat_id AND cd2.user_id = $2 LIMIT 1
          )
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
    // Honor chat_deletions.deleted_at as a visibility cutoff for this user.
    const conditions: string[] = [
      'm.chat_id = $1',
      '(m.deleted_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM message_deletions md WHERE md.message_id = m.id AND md.user_id = $2))',
      '(NOT EXISTS (SELECT 1 FROM chat_deletions cd WHERE cd.chat_id = $1 AND cd.user_id = $2) OR m.created_at > (SELECT cd2.deleted_at FROM chat_deletions cd2 WHERE cd2.chat_id = $1 AND cd2.user_id = $2 LIMIT 1))',
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
        m.encryption_version,
        m.sender_device_id,
        m.recipient_device_id,
        m.pre_key_id,
        m.signed_pre_key_id,
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
        // Encryption envelope (v0.8.0). Only attached when non-default so
        // plaintext rows stay clean in the JSON.
        ...(row.encryption_version > 0 && { encryptionVersion: row.encryption_version }),
        ...(row.sender_device_id !== null && { senderDeviceId: row.sender_device_id }),
        ...(row.recipient_device_id !== null && { recipientDeviceId: row.recipient_device_id }),
        ...(row.pre_key_id !== null && { preKeyId: row.pre_key_id }),
        ...(row.signed_pre_key_id !== null && { signedPreKeyId: row.signed_pre_key_id }),
      };
    });

    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? Buffer.from(lastRow.created_at.toISOString()).toString('base64')
        : undefined;

    return { messages, nextCursor, hasMore };
  }

  async createGroupChat(
    creatorId: string,
    title: string,
    memberIds: string[],
  ): Promise<ChatDTO> {
    const deduped = [...new Set(memberIds.filter((id) => id !== creatorId))];
    if (deduped.length < 2) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'A group chat requires at least 2 other members.',
      });
    }

    // Verify all member IDs exist in one query
    const memberCheck = await this.db.query<{ id: string }>(
      'SELECT id FROM users WHERE id = ANY($1::uuid[])',
      [deduped],
    );
    if (memberCheck.rows.length !== deduped.length) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'One or more member IDs are invalid.',
      });
    }

    return this.db.transaction(async (client) => {
      const chatResult = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO chats (type, title, created_by)
         VALUES ('group', $1, $2)
         RETURNING id, created_at`,
        [title.trim(), creatorId],
      );
      const { id: chatId, created_at } = chatResult.rows[0];

      // Insert creator as owner
      await client.query(
        `INSERT INTO chat_participants (chat_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [chatId, creatorId],
      );

      // Insert all other members
      for (const memberId of deduped) {
        await client.query(
          `INSERT INTO chat_participants (chat_id, user_id, role) VALUES ($1, $2, 'member')`,
          [chatId, memberId],
        );
      }

      // Fetch full participant data including user info
      const participantsResult = await client.query<{
        user_id: string; role: string; joined_at: Date;
        username: string; display_name: string; avatar_url: string | null;
      }>(
        `SELECT cp.user_id, cp.role, cp.joined_at, u.username, u.display_name, u.avatar_url
         FROM chat_participants cp
         JOIN users u ON u.id = cp.user_id
         WHERE cp.chat_id = $1`,
        [chatId],
      );

      const participants: ChatParticipantDTO[] = participantsResult.rows.map((r) => ({
        chatId,
        userId: r.user_id,
        role: r.role as ParticipantRole,
        joinedAt: r.joined_at.toISOString(),
        user: {
          id: r.user_id,
          username: r.username,
          displayName: r.display_name,
          ...(r.avatar_url !== null && { avatarUrl: r.avatar_url }),
        },
      }));

      return {
        id: chatId,
        type: ChatType.GROUP,
        title: title.trim(),
        createdBy: creatorId,
        createdAt: created_at.toISOString(),
        participants,
        unreadCount: 0,
      };
    });
  }

  async addGroupMembers(
    chatId: string,
    requesterId: string,
    userIds: string[],
  ): Promise<GroupMemberUpdateResponse> {
    const requesterRow = await this.db.query<{ role: string; chat_type: string }>(
      `SELECT cp.role, c.type AS chat_type
       FROM chat_participants cp
       JOIN chats c ON c.id = cp.chat_id
       WHERE cp.chat_id = $1 AND cp.user_id = $2`,
      [chatId, requesterId],
    );

    if (requesterRow.rows.length === 0) {
      throw new NotFoundException({ code: ErrorCode.CHAT_NOT_FOUND, message: 'Chat not found.' });
    }
    if (requesterRow.rows[0].chat_type !== 'group') {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_ERROR, message: 'Not a group chat.' });
    }
    const role = requesterRow.rows[0].role;
    if (role !== ParticipantRole.OWNER && role !== ParticipantRole.ADMIN) {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Only the owner or admin can add members.' });
    }

    const deduped = [...new Set(userIds)];
    for (const uid of deduped) {
      await this.db.query(
        `INSERT INTO chat_participants (chat_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (chat_id, user_id) DO NOTHING`,
        [chatId, uid],
      );
    }

    const result = await this.db.query<{
      user_id: string; role: string; joined_at: Date;
      username: string; display_name: string; avatar_url: string | null;
    }>(
      `SELECT cp.user_id, cp.role, cp.joined_at, u.username, u.display_name, u.avatar_url
       FROM chat_participants cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.chat_id = $1`,
      [chatId],
    );

    const participants: ChatParticipantDTO[] = result.rows.map((r) => ({
      chatId,
      userId: r.user_id,
      role: r.role as ParticipantRole,
      joinedAt: r.joined_at.toISOString(),
      user: {
        id: r.user_id,
        username: r.username,
        displayName: r.display_name,
        ...(r.avatar_url !== null && { avatarUrl: r.avatar_url }),
      },
    }));

    return { chatId, participants };
  }

  async removeGroupMember(
    chatId: string,
    requesterId: string,
    targetUserId: string,
  ): Promise<RemoveGroupMemberResponse> {
    const requesterRow = await this.db.query<{ role: string; chat_type: string }>(
      `SELECT cp.role, c.type AS chat_type
       FROM chat_participants cp
       JOIN chats c ON c.id = cp.chat_id
       WHERE cp.chat_id = $1 AND cp.user_id = $2`,
      [chatId, requesterId],
    );

    if (requesterRow.rows.length === 0) {
      throw new NotFoundException({ code: ErrorCode.CHAT_NOT_FOUND, message: 'Chat not found.' });
    }
    if (requesterRow.rows[0].chat_type !== 'group') {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_ERROR, message: 'Not a group chat.' });
    }

    const requesterRole = requesterRow.rows[0].role;
    const isSelf = requesterId === targetUserId;

    if (!isSelf) {
      if (requesterRole !== ParticipantRole.OWNER && requesterRole !== ParticipantRole.ADMIN) {
        throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Only the owner or admin can remove members.' });
      }
      // Cannot remove the owner
      const targetRow = await this.db.query<{ role: string }>(
        'SELECT role FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
        [chatId, targetUserId],
      );
      if (targetRow.rows[0]?.role === ParticipantRole.OWNER) {
        throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Cannot remove the group owner.' });
      }
    }

    await this.db.query(
      'DELETE FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
      [chatId, targetUserId],
    );

    return { chatId, userId: targetUserId };
  }

  async updateGroupChat(
    chatId: string,
    userId: string,
    dto: UpdateGroupChatRequest,
  ): Promise<UpdateGroupChatResponse> {
    await this.assertManager(chatId, userId, 'edit the group');

    if (dto.title === undefined && dto.description === undefined) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'At least one of title or description must be provided.',
      });
    }

    // Build the UPDATE dynamically so we only touch the fields that were
    // explicitly sent. `null` on description clears the column.
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;
    let trimmedTitle: string | undefined;
    let normalizedDescription: string | null | undefined;

    if (dto.title !== undefined) {
      trimmedTitle = dto.title.trim();
      sets.push(`title = $${idx}`);
      params.push(trimmedTitle);
      idx += 1;
    }
    if (dto.description !== undefined) {
      // Empty string is treated as clearing the description.
      const trimmed = dto.description === null ? null : dto.description.trim();
      normalizedDescription = trimmed === '' ? null : trimmed;
      sets.push(`description = $${idx}`);
      params.push(normalizedDescription);
      idx += 1;
    }

    params.push(chatId);
    await this.db.query(
      `UPDATE chats SET ${sets.join(', ')} WHERE id = $${idx}`,
      params,
    );

    return {
      chatId,
      ...(trimmedTitle !== undefined && { title: trimmedTitle }),
      ...(normalizedDescription !== undefined && { description: normalizedDescription }),
    };
  }

  async uploadGroupAvatar(
    chatId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<GroupAvatarUploadResponse> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    if (!ALLOWED_AVATAR_MIME.has(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG, and WebP files are allowed');
    }
    if (file.size > MAX_AVATAR_BYTES) {
      throw new BadRequestException('File exceeds 5 MB limit');
    }

    await this.assertManager(chatId, userId, 'change the group avatar');

    // Snapshot the prior avatar URL so we can prune the old object after the
    // new one is committed to the DB. Failure to prune is logged but never
    // propagated — the upload still succeeded.
    const old = await this.db.query<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM chats WHERE id = $1',
      [chatId],
    );

    const ext = extname(file.originalname).toLowerCase() || `.${file.mimetype.split('/')[1]}`;
    const key = `chats/${chatId}/${randomUUID()}${ext}`;
    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    await this.db.query(
      'UPDATE chats SET avatar_url = $1, updated_at = NOW() WHERE id = $2',
      [url, chatId],
    );

    const oldUrl = old.rows[0]?.avatar_url;
    if (oldUrl) {
      const oldKey = this.keyFromUrl(oldUrl);
      if (oldKey) await this.storage.delete(oldKey).catch(() => {});
    }

    return { chatId, avatarUrl: url };
  }

  async removeGroupAvatar(chatId: string, userId: string): Promise<void> {
    await this.assertManager(chatId, userId, 'remove the group avatar');

    const res = await this.db.query<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM chats WHERE id = $1',
      [chatId],
    );
    const url = res.rows[0]?.avatar_url;
    await this.db.query(
      'UPDATE chats SET avatar_url = NULL, updated_at = NOW() WHERE id = $1',
      [chatId],
    );
    if (url) {
      const key = this.keyFromUrl(url);
      if (key) await this.storage.delete(key).catch(() => {});
    }
  }

  async transferOwnership(
    chatId: string,
    currentOwnerId: string,
    newOwnerId: string,
  ): Promise<TransferGroupOwnershipResponse> {
    if (currentOwnerId === newOwnerId) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'You already own this group.',
      });
    }

    return this.db.transaction(async (client) => {
      const chatRow = await client.query<{ type: string }>(
        'SELECT type FROM chats WHERE id = $1',
        [chatId],
      );
      if (chatRow.rows.length === 0) {
        throw new NotFoundException({ code: ErrorCode.CHAT_NOT_FOUND, message: 'Chat not found.' });
      }
      if (chatRow.rows[0].type !== 'group') {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_ERROR, message: 'Not a group chat.' });
      }

      const requesterRow = await client.query<{ role: string }>(
        'SELECT role FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
        [chatId, currentOwnerId],
      );
      if (requesterRow.rows.length === 0 || requesterRow.rows[0].role !== ParticipantRole.OWNER) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: 'Only the current owner can transfer ownership.',
        });
      }

      const targetRow = await client.query<{ role: string }>(
        'SELECT role FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
        [chatId, newOwnerId],
      );
      if (targetRow.rows.length === 0) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'New owner must already be a member of the group.',
        });
      }

      // Atomic role swap: previous owner → admin, new member → owner.
      // The chat_participants PK is (chat_id, user_id) so we update by both keys.
      await client.query(
        `UPDATE chat_participants SET role = 'admin' WHERE chat_id = $1 AND user_id = $2`,
        [chatId, currentOwnerId],
      );
      await client.query(
        `UPDATE chat_participants SET role = 'owner' WHERE chat_id = $1 AND user_id = $2`,
        [chatId, newOwnerId],
      );
      await client.query(
        `UPDATE chats SET updated_at = NOW() WHERE id = $1`,
        [chatId],
      );

      const participants = await this.fetchParticipants(client, chatId);
      return {
        chatId,
        ownerId: newOwnerId,
        previousOwnerId: currentOwnerId,
        participants,
      };
    });
  }

  /**
   * Search messages within a single chat. Honours participant access,
   * per-user deletions and the chat_deletions cutoff. Matches against
   * `ciphertext` for TEXT messages and against the JSON-stringified
   * payload for FILE messages (the filename lives inside the JSON).
   * Image and audio messages aren't searchable — their ciphertext is a
   * URL or `{url, duration}` blob with no user-facing string.
   */
  async searchInChat(
    chatId: string,
    userId: string,
    q: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<SearchInChatResponse> {
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

    // Escape LIKE metacharacters so "50%" doesn't become a wildcard.
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;

    let beforeTs: string | undefined;
    if (cursor) {
      try { beforeTs = Buffer.from(cursor, 'base64').toString('utf-8'); }
      catch { beforeTs = undefined; }
    }

    const params: unknown[] = [chatId, userId, pattern];
    let idx = 4;
    let cursorClause = '';
    if (beforeTs) {
      cursorClause = `AND m.created_at < $${idx}::timestamptz`;
      params.push(beforeTs);
      idx += 1;
    }
    params.push(limit + 1);

    interface Row {
      id: string;
      sender_id: string;
      ciphertext: string;
      message_type: string;
      created_at: Date;
      sender_display_name: string | null;
      sender_username: string;
    }

    const result = await this.db.query<Row>(
      `
      SELECT
        m.id,
        m.sender_id,
        LEFT(m.ciphertext, 280) AS ciphertext,
        m.message_type,
        m.created_at,
        u.display_name AS sender_display_name,
        u.username     AS sender_username
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id = $1
        AND m.deleted_at IS NULL
        AND m.message_type IN ('text', 'file')
        AND m.ciphertext ILIKE $3 ESCAPE '\\'
        AND NOT EXISTS (
          SELECT 1 FROM message_deletions md
          WHERE md.message_id = m.id AND md.user_id = $2
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat_deletions cd
          WHERE cd.chat_id = $1
            AND cd.user_id = $2
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

    const matches: InChatSearchMatchDTO[] = page.map((row) => ({
      messageId: row.id,
      senderId: row.sender_id,
      senderName: row.sender_display_name ?? row.sender_username,
      ciphertext: row.ciphertext,
      messageType: row.message_type as MessageType,
      createdAt: row.created_at.toISOString(),
    }));

    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? Buffer.from(lastRow.created_at.toISOString()).toString('base64')
        : undefined;

    return {
      chatId,
      matches,
      pagination: {
        hasMore,
        ...(nextCursor !== undefined && { nextCursor }),
      },
    };
  }

  /**
   * Verifies the caller is currently OWNER or ADMIN of the group chat.
   * Centralises the role check used by update/avatar/etc. so error messages
   * stay consistent and we avoid drift between endpoints.
   */
  private async assertManager(chatId: string, userId: string, action: string): Promise<void> {
    const row = await this.db.query<{ role: string; chat_type: string }>(
      `SELECT cp.role, c.type AS chat_type
       FROM chat_participants cp
       JOIN chats c ON c.id = cp.chat_id
       WHERE cp.chat_id = $1 AND cp.user_id = $2`,
      [chatId, userId],
    );

    if (row.rows.length === 0) {
      throw new NotFoundException({ code: ErrorCode.CHAT_NOT_FOUND, message: 'Chat not found.' });
    }
    if (row.rows[0].chat_type !== 'group') {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_ERROR, message: 'Not a group chat.' });
    }
    const role = row.rows[0].role;
    if (role !== ParticipantRole.OWNER && role !== ParticipantRole.ADMIN) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: `Only the owner or admin can ${action}.`,
      });
    }
  }

  /**
   * Re-fetches the full participant list for `chatId` using the supplied
   * pg client (lets us share the connection with an enclosing transaction).
   */
  private async fetchParticipants(
    client: import('pg').PoolClient,
    chatId: string,
  ): Promise<ChatParticipantDTO[]> {
    const result = await client.query<{
      user_id: string; role: string; joined_at: Date;
      username: string; display_name: string; avatar_url: string | null;
    }>(
      `SELECT cp.user_id, cp.role, cp.joined_at, u.username, u.display_name, u.avatar_url
       FROM chat_participants cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.chat_id = $1`,
      [chatId],
    );
    return result.rows.map((r) => ({
      chatId,
      userId: r.user_id,
      role: r.role as ParticipantRole,
      joinedAt: r.joined_at.toISOString(),
      user: {
        id: r.user_id,
        username: r.username,
        displayName: r.display_name,
        ...(r.avatar_url !== null && { avatarUrl: r.avatar_url }),
      },
    }));
  }

  private keyFromUrl(url: string): string | null {
    try {
      const u = new URL(url);
      // Storage URLs look like `{publicUrl}/{bucket}/{key}`.
      const parts = u.pathname.slice(1).split('/');
      return parts.slice(1).join('/') || null;
    } catch {
      return null;
    }
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
        SET deleted_at = NOW()
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
