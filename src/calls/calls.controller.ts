import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  ApiResponse,
  CallHistoryResponse,
  CallResponse,
  IceServersResponse,
} from '@signalix/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ok } from '../common/response.helper';
import { CallHistoryQueryDto, CreateCallDto, EndCallDto } from './dto/call.dto';
import { CallsService } from './calls.service';

/**
 * v0.17.0 — call log + ICE servers. Create / accept / end are driven by
 * Signalix-realtime (forwarding the user's own JWT); clients call
 * `ice-servers` and `GET /calls` directly.
 */
@Controller('calls')
@UseGuards(JwtAuthGuard)
export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  @Get('ice-servers')
  @HttpCode(HttpStatus.OK)
  iceServers(@CurrentUser() user: JwtPayload): ApiResponse<IceServersResponse> {
    return ok(this.callsService.iceServers(user.sub));
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async history(
    @Query() query: CallHistoryQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<CallHistoryResponse>> {
    const calls = await this.callsService.history(user.sub, query.limit);
    return ok({ calls });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateCallDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<CallResponse>> {
    const call = await this.callsService.create(user.sub, dto.callId, dto.chatId, dto.callType);
    return ok({ call });
  }

  @Post(':callId/accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('callId', ParseUUIDPipe) callId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<CallResponse>> {
    const call = await this.callsService.accept(callId, user.sub);
    return ok({ call });
  }

  @Post(':callId/end')
  @HttpCode(HttpStatus.OK)
  async end(
    @Param('callId', ParseUUIDPipe) callId: string,
    @Body() dto: EndCallDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<CallResponse>> {
    const call = await this.callsService.end(callId, user.sub, dto.reason);
    return ok({ call });
  }
}
