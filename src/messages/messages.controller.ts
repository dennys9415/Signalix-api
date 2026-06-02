import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type {
  ApiResponse,
  DeleteMessageForMeResponse,
  MessageStatusDTO,
  SendMessageResponse,
} from '@signalix/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ok } from '../common/response.helper';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { MessagesService } from './messages.service';

@Controller('messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post('send')
  @HttpCode(HttpStatus.CREATED)
  async send(
    @Body() dto: SendMessageDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<SendMessageResponse>> {
    const result = await this.messagesService.sendMessage(user.sub, dto);
    return ok(result);
  }

  @Post(':messageId/status')
  @HttpCode(HttpStatus.OK)
  async updateStatus(
    @Param('messageId') messageId: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<MessageStatusDTO>> {
    const result = await this.messagesService.updateStatus(
      messageId,
      user.sub,
      dto.status,
    );
    return ok(result);
  }

  @Post(':messageId/delete-for-me')
  @HttpCode(HttpStatus.OK)
  async deleteForMe(
    @Param('messageId') messageId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<DeleteMessageForMeResponse>> {
    const result = await this.messagesService.deleteForMe(messageId, user.sub);
    return ok(result);
  }
}
