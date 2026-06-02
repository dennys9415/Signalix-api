import { Injectable } from '@nestjs/common';
import type { PublicUserDTO } from '@signalix/contracts';
import { DbService } from '../db/db.service';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService) {}

  async findByUsername(username: string): Promise<PublicUserDTO | null> {
    const result = await this.db.query<UserRow>(`
      SELECT id, username, display_name, avatar_url
      FROM users
      WHERE username = $1
    `, [username.toLowerCase()]);

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      ...(row.avatar_url !== null && { avatarUrl: row.avatar_url }),
    };
  }
}
