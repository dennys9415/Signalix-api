import {
  Controller,
  Delete,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { ApiResponse } from '@signalix/contracts';
import { JwtAuthGuard, JwtPayload } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ok } from '../common/response.helper';
import { ProfileService } from './profile.service';

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Post('avatar')
  @UseInterceptors(FileInterceptor('avatar', { storage: memoryStorage() }))
  async uploadAvatar(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ApiResponse<{ avatarUrl: string }>> {
    const avatarUrl = await this.profile.uploadAvatar(user.sub, file);
    return ok({ avatarUrl });
  }

  @Delete('avatar')
  async removeAvatar(
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<Record<string, never>>> {
    await this.profile.removeAvatar(user.sub);
    return ok({});
  }
}
