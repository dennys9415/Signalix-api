import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type {
  ApiResponse,
  ChatDTO,
  GetMessagesResponse,
} from '@signalix/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ok } from '../common/response.helper';
import { GetMessagesDto } from './dto/get-messages.dto';
import { ChatsService } from './chats.service';

@Controller('chats')
@UseGuards(JwtAuthGuard)
export class ChatsController {
  constructor(private readonly chatsService: ChatsService) {}

  @Get()
  async getChats(
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<{ chats: ChatDTO[] }>> {
    const chats = await this.chatsService.getUserChats(user.sub);
    return ok({ chats });
  }

  @Get(':chatId/messages')
  async getMessages(
    @Param('chatId') chatId: string,
    @CurrentUser() user: JwtPayload,
    @Query() query: GetMessagesDto,
  ): Promise<ApiResponse<GetMessagesResponse>> {
    const { messages, nextCursor, hasMore } = await this.chatsService.getMessages(
      chatId,
      user.sub,
      query.limit,
      query.cursor,
      query.before,
    );
    return ok({
      messages,
      pagination: {
        hasMore,
        ...(nextCursor !== undefined && { nextCursor }),
      },
    });
  }
}
