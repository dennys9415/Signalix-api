import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  ApiResponse,
  DeleteMessageForEveryoneResponse,
  DeleteMessageForMeResponse,
  EditMessageResponse,
  MessageStatusDTO,
  ReactionResponse,
  SearchMessagesResponse,
  SendMessageResponse,
} from '@signalix/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ok } from '../common/response.helper';
import { AddReactionDto } from './dto/add-reaction.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { SearchMessagesDto } from './dto/search-messages.dto';
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

  @Get('search')
  async search(
    @Query() query: SearchMessagesDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<SearchMessagesResponse>> {
    const result = await this.messagesService.searchMessages(
      user.sub,
      query.q,
      query.limit,
      query.cursor,
    );
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

  @Post(':messageId/delete-for-everyone')
  @HttpCode(HttpStatus.OK)
  async deleteForEveryone(
    @Param('messageId') messageId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<DeleteMessageForEveryoneResponse>> {
    const result = await this.messagesService.deleteForEveryone(messageId, user.sub);
    return ok(result);
  }

  @Patch(':messageId')
  @HttpCode(HttpStatus.OK)
  async edit(
    @Param('messageId') messageId: string,
    @Body() dto: EditMessageDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<EditMessageResponse>> {
    const result = await this.messagesService.editMessage(messageId, user.sub, dto);
    return ok(result);
  }

  @Post(':messageId/reaction')
  @HttpCode(HttpStatus.OK)
  async setReaction(
    @Param('messageId') messageId: string,
    @Body() dto: AddReactionDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<ReactionResponse>> {
    const result = await this.messagesService.setReaction(messageId, user.sub, dto.emoji);
    return ok(result);
  }

  @Delete(':messageId/reaction')
  @HttpCode(HttpStatus.OK)
  async removeReaction(
    @Param('messageId') messageId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<ReactionResponse>> {
    const result = await this.messagesService.removeReaction(messageId, user.sub);
    return ok(result);
  }
}
