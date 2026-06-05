import { Controller, Get, Param, Post, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { ApiResponse } from '@signalix/contracts';
import { JwtAuthGuard, JwtPayload } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ok } from '../common/response.helper';
import { FilesService, type FileUploadResult } from './files.service';

@Controller('files')
@UseGuards(JwtAuthGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadFile(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ApiResponse<FileUploadResult>> {
    const result = await this.files.uploadFile(user.sub, file);
    return ok(result);
  }

  @Get(':messageId/download')
  async downloadFile(
    @CurrentUser() user: JwtPayload,
    @Param('messageId') messageId: string,
  ): Promise<StreamableFile> {
    const { body, contentType, contentLength, fileName } = await this.files.getFileStream(messageId, user.sub);
    const encoded = encodeURIComponent(fileName);
    return new StreamableFile(body, {
      type: contentType,
      disposition: `attachment; filename="${encoded}"`,
      length: contentLength,
    });
  }
}
