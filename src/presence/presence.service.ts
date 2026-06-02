import { Injectable } from '@nestjs/common';
import {
  PresenceDTO,
  PresenceLookupResponse,
  PresenceStatus,
} from '@signalix/contracts';
import { DbService } from '../db/db.service';

interface PresenceRow {
  user_id: string;
  device_id: string | null;
  status: string;
  last_seen: Date;
}

@Injectable()
export class PresenceService {
  constructor(private readonly db: DbService) {}

  async lookupPresence(userIds: string[]): Promise<PresenceLookupResponse> {
    if (userIds.length === 0) {
      return { presence: [] };
    }

    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(', ');
    const result = await this.db.query<PresenceRow>(
      `SELECT user_id, device_id, status, last_seen
       FROM presence
       WHERE user_id IN (${placeholders})`,
      userIds,
    );

    const presence: PresenceDTO[] = result.rows.map((row) => ({
      userId: row.user_id,
      deviceId: row.device_id ?? '',
      status: row.status as PresenceStatus,
      lastSeen: row.last_seen.toISOString(),
    }));

    return { presence };
  }

  async updateStatus(
    userId: string,
    deviceId: string,
    status: PresenceStatus,
  ): Promise<PresenceDTO> {
    const result = await this.db.query<PresenceRow>(`
      INSERT INTO presence (user_id, device_id, status, last_seen)
      VALUES ($1, $2::uuid, $3, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET device_id = EXCLUDED.device_id,
            status    = EXCLUDED.status,
            last_seen = NOW()
      RETURNING user_id, device_id, status, last_seen
    `, [userId, deviceId, status]);

    const row = result.rows[0];
    return {
      userId: row.user_id,
      deviceId: row.device_id ?? '',
      status: row.status as PresenceStatus,
      lastSeen: row.last_seen.toISOString(),
    };
  }
}
