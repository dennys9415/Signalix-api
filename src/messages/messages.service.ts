import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ErrorCode,
  MessageDTO,
  MessageLifecycleState,
  MessageStatus,
  MessageStatusDTO,
  MessageType,
  SendMessageResponse,
} from '@signalix/contracts';
import { DbService } from '../db/db.service';
import type { SendMessageDto } from './dto/send-message.dto';

interface MessageStatusRow {
  message_id: string;
  user_id: string;
  status: string;
  timestamp: Date;
}

@Injectable()
export class MessagesService {
  constructor(private readonly db: DbService) {}

  async sendMessage(
    senderId: string,
    dto: SendMessageDto,
  ): Promise<SendMessageResponse> {
    return this.db.transaction(async (client) => {
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

      const msgId = randomUUID();
      const now = new Date();

      await client.query(`
        INSERT INTO messages (id, chat_id, sender_id, ciphertext, message_type)
        VALUES ($1, $2, $3, $4, 'text')
      `, [msgId, chatId, senderId, dto.ciphertext]);

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
        messageType: MessageType.TEXT,
        state: MessageLifecycleState.SENT,
        createdAt: now.toISOString(),
      };

      return {
        message,
        chatId,
        ...(dto.tempId ? { tempId: dto.tempId } : {}),
      };
    });
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
}

function buildDirectPairKey(a: string, b: string): string {
  return [a, b].sort().join(':');
}

function toStatusDTO(row: MessageStatusRow): MessageStatusDTO {
  return {
    messageId: row.message_id,
    userId: row.user_id,
    status: row.status as MessageStatus,
    timestamp: row.timestamp.toISOString(),
  };
}
