import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Readable } from 'stream';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { StorageService } from '../storage/storage.service';

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.csv', '.zip']);
const MAX_BYTES = 25 * 1024 * 1024;

export interface FileUploadResult {
  fileUrl: string;
  fileName: string;
  fileSize: number;
}

export interface FileStreamResult {
  body: Readable;
  contentType: string;
  contentLength: number;
  fileName: string;
}

@Injectable()
export class FilesService {
  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly storage: StorageService,
  ) {}

  async uploadFile(userId: string, file: Express.Multer.File): Promise<FileUploadResult> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('File exceeds 25 MB limit');
    }

    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(
        'File type not allowed. Supported: pdf, docx, xlsx, pptx, txt, csv, zip',
      );
    }

    const key = `files/${userId}/${randomUUID()}${ext}`;
    const fileUrl = await this.storage.upload(
      key,
      file.buffer,
      file.mimetype,
      this.config.minioFilesBucket,
    );

    return {
      fileUrl,
      fileName: file.originalname,
      fileSize: file.size,
    };
  }

  async getFileStream(messageId: string, userId: string): Promise<FileStreamResult> {
    const { rows } = await this.db.query<{
      chat_id: string;
      ciphertext: string;
      message_type: string;
      deleted_at: string | null;
    }>(
      `SELECT chat_id, ciphertext, message_type, deleted_at FROM messages WHERE id = $1`,
      [messageId],
    );

    if (!rows.length) throw new NotFoundException('Message not found');
    const msg = rows[0];
    if (msg.message_type !== 'file') throw new BadRequestException('Message is not a file');
    if (msg.deleted_at) throw new NotFoundException('File not available');

    const { rows: participant } = await this.db.query(
      `SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2`,
      [msg.chat_id, userId],
    );
    if (!participant.length) throw new ForbiddenException('Access denied');

    let fileInfo: { url: string; name: string; size: number };
    try {
      fileInfo = JSON.parse(msg.ciphertext) as { url: string; name: string; size: number };
    } catch {
      throw new BadRequestException('Invalid file data');
    }

    const prefix = `${this.config.minioPublicUrl}/${this.config.minioFilesBucket}/`;
    const key = fileInfo.url.startsWith(prefix) ? fileInfo.url.slice(prefix.length) : fileInfo.url;

    const stream = await this.storage.getObject(key, this.config.minioFilesBucket);
    return { ...stream, fileName: fileInfo.name };
  }
}
