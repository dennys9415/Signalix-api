import { BadRequestException, Injectable } from '@nestjs/common';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { ConfigService } from '../config/config.service';
import { StorageService } from '../storage/storage.service';

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

// MediaRecorder emits webm/opus on Chrome/Edge/Firefox; Safari uses
// audio/mp4 (AAC). audio/ogg, audio/mpeg, audio/wav, audio/x-m4a are
// accepted defensively. iOS may report audio/x-m4a or audio/aac for
// the same data; both map cleanly to .m4a.
const ALLOWED_AUDIO_MIME = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
]);

const MAX_BYTES = 10 * 1024 * 1024;
// v0.11.0 — encrypted blob ceiling. Same as files (25 MB) so the
// encrypted variant covers everything the plaintext file path used to.
// AES-GCM adds 16 bytes of auth tag, negligible at this scale.
const MAX_ENCRYPTED_BYTES = 25 * 1024 * 1024;

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
    if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG, WebP, and GIF images are allowed');
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('File exceeds 10 MB limit');
    }

    const ext = extname(file.originalname).toLowerCase() || `.${file.mimetype.split('/')[1]}`;
    const key = `messages/${userId}/${randomUUID()}${ext}`;
    return this.storage.upload(key, file.buffer, file.mimetype, this.config.minioMediaBucket);
  }

  async uploadVoice(userId: string, file: Express.Multer.File): Promise<string> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    if (!ALLOWED_AUDIO_MIME.has(file.mimetype)) {
      throw new BadRequestException('Unsupported audio format');
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('Voice message exceeds 10 MB limit');
    }

    const ext = pickAudioExt(file);
    const key = `voice/${userId}/${randomUUID()}${ext}`;
    return this.storage.upload(key, file.buffer, file.mimetype, this.config.minioMediaBucket);
  }

  /**
   * v0.11.0 — accept a pre-encrypted blob (AES-GCM ciphertext produced
   * client-side, opaque to the server). MIME validation is skipped on
   * purpose: the stored bytes are random-looking ciphertext, not the
   * original image/audio/document. The size cap covers the largest
   * attachment kind (files at 25 MB pre-encryption + auth tag).
   *
   * Object key uses `encrypted/{userId}/{uuid}.bin` so the encrypted
   * objects are visibly distinct from the legacy plaintext paths in
   * MinIO. Returns the public URL — the URL itself is non-sensitive
   * (knowing it only grants access to ciphertext, which is useless
   * without the media key carried in the per-recipient envelope).
   */
  async uploadEncryptedBlob(
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ url: string; size: number }> {
    if (!file) {
      throw new BadRequestException('No blob provided');
    }
    if (file.size > MAX_ENCRYPTED_BYTES) {
      throw new BadRequestException(
        `Encrypted blob exceeds ${MAX_ENCRYPTED_BYTES / (1024 * 1024)} MB limit`,
      );
    }
    const key = `encrypted/${userId}/${randomUUID()}.bin`;
    const url = await this.storage.upload(
      key,
      file.buffer,
      'application/octet-stream',
      this.config.minioMediaBucket,
    );
    return { url, size: file.size };
  }
}

function pickAudioExt(file: Express.Multer.File): string {
  const fromName = extname(file.originalname).toLowerCase();
  if (fromName) return fromName;
  switch (file.mimetype) {
    case 'audio/webm':
      return '.webm';
    case 'audio/ogg':
      return '.ogg';
    case 'audio/mp4':
    case 'audio/aac':
    case 'audio/x-m4a':
      return '.m4a';
    case 'audio/mpeg':
      return '.mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    default:
      return '.bin';
  }
}
