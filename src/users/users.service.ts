import { Injectable, NotFoundException } from '@nestjs/common';
import type { PublicUserDTO, UserDTO, UserProfileResponse } from '@signalix/contracts';
import { DbService } from '../db/db.service';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

interface FullUserRow {
  id: string;
  email: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  is_verified: boolean;
  created_at: Date;
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

    return this.toPublicDTO(row);
  }

  async searchUsers(
    query: string,
    limit: number,
    excludeUserId: string,
  ): Promise<PublicUserDTO[]> {
    const result = await this.db.query<UserRow>(`
      SELECT id, username, display_name, avatar_url
      FROM users
      WHERE username ILIKE $1
        AND id != $2
      ORDER BY username
      LIMIT $3
    `, [`%${query}%`, excludeUserId, limit]);

    return result.rows.map((row) => this.toPublicDTO(row));
  }

  async getProfile(userId: string): Promise<UserProfileResponse> {
    const userResult = await this.db.query<FullUserRow>(
      `SELECT id, email, username, display_name, avatar_url, bio, is_verified, created_at
       FROM users WHERE id = $1`,
      [userId],
    );

    const row = userResult.rows[0];
    if (!row) {
      throw new NotFoundException({ message: 'User not found.' });
    }

    const providerResult = await this.db.query<{ provider: string }>(
      'SELECT provider FROM auth_providers WHERE user_id = $1',
      [userId],
    );

    const user: UserDTO = {
      id: row.id,
      email: row.email,
      username: row.username,
      ...(row.display_name !== null && { displayName: row.display_name }),
      ...(row.avatar_url !== null && { avatarUrl: row.avatar_url }),
      ...(row.bio !== null && { bio: row.bio }),
      isVerified: row.is_verified,
      createdAt: row.created_at.toISOString(),
    };

    return {
      user,
      providers: providerResult.rows.map((r) => r.provider),
    };
  }

  private toPublicDTO(row: UserRow): PublicUserDTO {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      ...(row.avatar_url !== null && { avatarUrl: row.avatar_url }),
    };
  }
}
