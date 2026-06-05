import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { randomUUID } from 'crypto';
import { extname } from 'path';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024;

@Injectable()
export class ProfileService {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
  ) {}

  async uploadAvatar(userId: string, file: Express.Multer.File): Promise<string> {
    if (!file) throw new BadRequestException('No file provided');
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG, and WebP files are allowed');
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('File exceeds 5 MB limit');
    }

    const old = await this.db.query<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM users WHERE id = $1',
      [userId],
    );

    const ext = extname(file.originalname).toLowerCase() || `.${file.mimetype.split('/')[1]}`;
    const key = `avatars/${userId}/${randomUUID()}${ext}`;
    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    await this.db.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [url, userId]);

    const oldUrl = old.rows[0]?.avatar_url;
    if (oldUrl) {
      const oldKey = this.keyFromUrl(oldUrl);
      if (oldKey) await this.storage.delete(oldKey).catch(() => {});
    }

    return url;
  }

  async removeAvatar(userId: string): Promise<void> {
    const res = await this.db.query<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM users WHERE id = $1',
      [userId],
    );
    const url = res.rows[0]?.avatar_url;
    await this.db.query('UPDATE users SET avatar_url = NULL WHERE id = $1', [userId]);
    if (url) {
      const key = this.keyFromUrl(url);
      if (key) await this.storage.delete(key).catch(() => {});
    }
  }

  private keyFromUrl(url: string): string | null {
    try {
      const u = new URL(url);
      // path is /<bucket>/<key> — strip leading slash and bucket segment
      const parts = u.pathname.slice(1).split('/');
      return parts.slice(1).join('/') || null;
    } catch {
      return null;
    }
  }
}
