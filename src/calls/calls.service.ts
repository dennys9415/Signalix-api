import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  CallDTO,
  CallEndReason,
  CallStatus,
  CallType,
  ErrorCode,
  IceServerDTO,
  IceServersResponse,
} from '@signalix/contracts';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { PushService } from '../push/push.service';

interface CallRow {
  id: string;
  chat_id: string;
  caller_id: string;
  callee_id: string;
  call_type: string;
  status: string;
  end_reason: string | null;
  started_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
}

const CALL_COLUMNS = `id, chat_id, caller_id, callee_id, call_type, status,
  end_reason, started_at, answered_at, ended_at`;

const DEFAULT_HISTORY_LIMIT = 50;

function toDto(row: CallRow): CallDTO {
  return {
    id: row.id,
    chatId: row.chat_id,
    callerId: row.caller_id,
    calleeId: row.callee_id,
    callType: row.call_type as CallType,
    status: row.status as CallStatus,
    endReason: row.end_reason as CallEndReason | null,
    startedAt: row.started_at.toISOString(),
    answeredAt: row.answered_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    durationSeconds:
      row.answered_at && row.ended_at
        ? Math.max(0, Math.round((row.ended_at.getTime() - row.answered_at.getTime()) / 1000))
        : null,
  };
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    private readonly push: PushService,
  ) {}

  /**
   * Create a ringing call in a direct chat. The callee is the other
   * participant; group chats are rejected (group calls need an SFU).
   */
  async create(
    callerId: string,
    callId: string,
    chatId: string,
    callType: CallType,
  ): Promise<CallDTO> {
    const chat = await this.db.query<{ type: string; user_id: string }>(
      `SELECT c.type, cp.user_id
       FROM chats c
       JOIN chat_participants cp ON cp.chat_id = c.id
       WHERE c.id = $1`,
      [chatId],
    );

    if (chat.rows.length === 0) {
      throw new NotFoundException({ code: ErrorCode.CHAT_NOT_FOUND, message: 'Chat not found.' });
    }
    if (!chat.rows.some((r) => r.user_id === callerId)) {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Not a participant of this chat.' });
    }
    if (chat.rows[0].type !== 'direct') {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Calls are only supported in direct chats.',
      });
    }
    const callee = chat.rows.find((r) => r.user_id !== callerId);
    if (!callee) {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'Direct chat has no other participant.' });
    }

    const result = await this.db.query<CallRow>(
      `INSERT INTO calls (id, chat_id, caller_id, callee_id, call_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING
       RETURNING ${CALL_COLUMNS}`,
      [callId, chatId, callerId, callee.user_id, callType],
    );
    if (result.rows.length === 0) {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'Call id already exists.' });
    }
    return toDto(result.rows[0]);
  }

  async accept(callId: string, userId: string): Promise<CallDTO> {
    const result = await this.db.query<CallRow>(
      `UPDATE calls
       SET status = 'active', answered_at = NOW()
       WHERE id = $1 AND callee_id = $2 AND status = 'ringing'
       RETURNING ${CALL_COLUMNS}`,
      [callId, userId],
    );
    if (result.rows.length > 0) return toDto(result.rows[0]);

    const existing = await this.findForParticipant(callId, userId);
    if (existing.callee_id !== userId) {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Only the callee can accept.' });
    }
    throw new ConflictException({ code: ErrorCode.CONFLICT, message: `Call is ${existing.status}.` });
  }

  /**
   * End a call. Idempotent: ending an already-ended call returns the
   * stored row. The reason is normalised against the current state so a
   * stale client can't record e.g. `missed` for an answered call.
   */
  async end(callId: string, userId: string, reason: CallEndReason): Promise<CallDTO> {
    const result = await this.db.query<CallRow>(
      `UPDATE calls
       SET status = 'ended',
           ended_at = NOW(),
           end_reason = CASE
             WHEN status = 'active' AND $3::text NOT IN ('completed', 'failed') THEN 'completed'
             WHEN status = 'ringing' AND $3::text = 'completed' THEN 'cancelled'
             ELSE $3::text
           END
       WHERE id = $1 AND (caller_id = $2 OR callee_id = $2) AND status <> 'ended'
       RETURNING ${CALL_COLUMNS}`,
      [callId, userId, reason],
    );

    if (result.rows.length === 0) {
      return toDto(await this.findForParticipant(callId, userId));
    }

    const call = toDto(result.rows[0]);
    if (call.endReason === CallEndReason.MISSED || call.endReason === CallEndReason.UNAVAILABLE) {
      void this.notifyMissed(call).catch((err: Error) =>
        this.logger.warn(`Missed-call push failed for ${call.id}: ${err.message}`),
      );
    }
    return call;
  }

  async history(userId: string, limit = DEFAULT_HISTORY_LIMIT): Promise<CallDTO[]> {
    const result = await this.db.query<CallRow>(
      `SELECT ${CALL_COLUMNS}
       FROM calls
       WHERE caller_id = $1 OR callee_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map(toDto);
  }

  /**
   * STUN + TURN servers for RTCPeerConnection. TURN credentials follow
   * the TURN REST API scheme coturn understands with `use-auth-secret`:
   * username = "<expiry-unix>:<userId>", credential = base64(HMAC-SHA1).
   */
  iceServers(userId: string): IceServersResponse {
    const ttlSeconds = this.config.turnTtlSeconds;
    const iceServers: IceServerDTO[] = [];

    const stunUrls = this.config.iceStunUrls;
    if (stunUrls.length > 0) iceServers.push({ urls: stunUrls });

    const turnUrls = this.config.turnUrls;
    const secret = this.config.turnSecret;
    if (turnUrls.length > 0 && secret) {
      const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${userId}`;
      const credential = createHmac('sha1', secret).update(username).digest('base64');
      iceServers.push({ urls: turnUrls, username, credential });
    }

    return { iceServers, ttlSeconds };
  }

  private async findForParticipant(callId: string, userId: string): Promise<CallRow> {
    const result = await this.db.query<CallRow>(
      `SELECT ${CALL_COLUMNS} FROM calls WHERE id = $1`,
      [callId],
    );
    const row = result.rows[0];
    if (!row || (row.caller_id !== userId && row.callee_id !== userId)) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Call not found.' });
    }
    return row;
  }

  private async notifyMissed(call: CallDTO): Promise<void> {
    const caller = await this.db.query<{ display_name: string | null; username: string; avatar_url: string | null }>(
      'SELECT display_name, username, avatar_url FROM users WHERE id = $1',
      [call.callerId],
    );
    const row = caller.rows[0];
    if (!row) return;

    await this.push.sendToUser(call.calleeId, {
      title: row.display_name ?? row.username,
      body: call.callType === CallType.VIDEO ? 'Missed video call' : 'Missed voice call',
      chatId: call.chatId,
      avatarUrl: row.avatar_url,
    });
  }
}
