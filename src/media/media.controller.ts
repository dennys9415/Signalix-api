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
}
