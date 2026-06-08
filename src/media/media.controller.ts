import { Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { ApiResponse } from '@signalix/contracts';
import { JwtAuthGuard, JwtPayload } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ok } from '../common/response.helper';
import { MediaService } from './media.service';

@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('media', { storage: memoryStorage() }))
  async uploadMedia(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ApiResponse<{ mediaUrl: string }>> {
    const mediaUrl = await this.media.uploadMedia(user.sub, file);
    return ok({ mediaUrl });
  }

  @Post('voice')
  @UseInterceptors(FileInterceptor('audio', { storage: memoryStorage() }))
  async uploadVoice(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ApiResponse<{ voiceUrl: string }>> {
    const voiceUrl = await this.media.uploadVoice(user.sub, file);
    return ok({ voiceUrl });
  }

  /**
   * v0.11.0 — encrypted-blob upload. The client encrypts an
   * image/file/voice locally with a per-attachment AES-GCM key and
   * uploads the resulting ciphertext as opaque bytes. Authorization is
   * still JWT-based (the user must be authenticated to push bytes into
   * their bucket prefix), but content validation is skipped — the bytes
   * are random-looking ciphertext, not a media file. The returned URL
   * is public; access control is moot because the bytes are useless
   * without the media key, which only the per-recipient envelope holds.
   */
  @Post('encrypted-blob')
  @UseInterceptors(FileInterceptor('blob', { storage: memoryStorage() }))
  async uploadEncryptedBlob(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ApiResponse<{ url: string; size: number }>> {
    const result = await this.media.uploadEncryptedBlob(user.sub, file);
    return ok(result);
  }
}
