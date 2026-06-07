import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { ApiResponse } from '@signalix/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ok } from '../common/response.helper';
import { SubscribePushDto, UnsubscribePushDto } from './dto/subscribe.dto';
import { PushService } from './push.service';

@Controller('push')
export class PushController {
  constructor(private readonly pushService: PushService) {}

  // Public so the frontend can hydrate the VAPID key before the user signs in
  // (e.g. to decide whether to render the "enable push" UI at all).
  @Get('public-key')
  @HttpCode(HttpStatus.OK)
  getPublicKey(): ApiResponse<{ publicKey: string }> {
    return ok({ publicKey: this.pushService.getPublicKey() });
  }

  @Post('subscribe')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async subscribe(
    @Body() dto: SubscribePushDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<{ subscribed: true }>> {
    await this.pushService.subscribe(user.sub, dto.endpoint, dto.keys.p256dh, dto.keys.auth);
    return ok({ subscribed: true });
  }

  @Delete('unsubscribe')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async unsubscribe(
    @Body() dto: UnsubscribePushDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<{ subscribed: false }>> {
    await this.pushService.unsubscribe(user.sub, dto.endpoint);
    return ok({ subscribed: false });
  }
}
