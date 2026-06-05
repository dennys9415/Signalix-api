import { BadRequestException, Injectable } from '@nestjs/common';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { ConfigService } from '../config/config.service';
import { StorageService } from '../storage/storage.service';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const MAX_BYTES = 10 * 1024 * 1024;

@Injectable()
export class MediaService {
  constructor(
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  async uploadMedia(userId: string, file: Express.Multer.File): Promise<string> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG, WebP, and GIF images are allowed');
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('File exceeds 10 MB limit');
    }

    const ext = extname(file.originalname).toLowerCase() || `.${file.mimetype.split('/')[1]}`;
    const key = `messages/${userId}/${randomUUID()}${ext}`;
    return this.storage.upload(key, file.buffer, file.mimetype, this.config.minioMediaBucket);
  }
}
