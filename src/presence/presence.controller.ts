import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  ApiResponse,
  PresenceDTO,
  PresenceLookupResponse,
} from '@signalix/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ok } from '../common/response.helper';
import { UpdatePresenceDto } from './dto/update-presence.dto';
import { PresenceService } from './presence.service';

@Controller('presence')
@UseGuards(JwtAuthGuard)
export class PresenceController {
  constructor(private readonly presenceService: PresenceService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async lookup(
    @Query('userIds') userIdsParam: string,
  ): Promise<ApiResponse<PresenceLookupResponse>> {
    const userIds = userIdsParam
      ? userIdsParam.split(',').map((id) => id.trim()).filter(Boolean)
      : [];
    const result = await this.presenceService.lookupPresence(userIds);
    return ok(result);
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  async updateStatus(
    @Body() dto: UpdatePresenceDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<PresenceDTO>> {
    const result = await this.presenceService.updateStatus(
      user.sub,
      user.deviceId,
      dto.status,
    );
    return ok(result);
  }
}
