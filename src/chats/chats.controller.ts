import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type {
  ApiResponse,
  ChatDTO,
  CreateGroupChatResponse,
  DeleteChatForMeResponse,
  GetMessagesResponse,
  GroupMemberUpdateResponse,
  MarkChatReadResponse,
  RemoveGroupMemberResponse,
  UpdateGroupChatResponse,
} from '@signalix/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ok } from '../common/response.helper';
import { GetMessagesDto } from './dto/get-messages.dto';
import { CreateGroupChatDto } from './dto/create-group-chat.dto';
import { AddGroupMembersDto } from './dto/add-group-members.dto';
import { UpdateGroupChatDto } from './dto/update-group-chat.dto';
import { ChatsService } from './chats.service';

@Controller('chats')
@UseGuards(JwtAuthGuard)
export class ChatsController {
  constructor(private readonly chatsService: ChatsService) {}

  @Post('group')
  @HttpCode(HttpStatus.CREATED)
  async createGroupChat(
    @Body() dto: CreateGroupChatDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<CreateGroupChatResponse>> {
    const chat = await this.chatsService.createGroupChat(user.sub, dto.title, dto.memberIds);
    return ok({ chat });
  }

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

  @Post(':chatId/read')
  @HttpCode(HttpStatus.OK)
  async markChatRead(
    @Param('chatId') chatId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<MarkChatReadResponse>> {
    const result = await this.chatsService.markChatRead(chatId, user.sub);
    return ok(result);
  }

  @Post(':chatId/delete-for-me')
  @HttpCode(HttpStatus.OK)
  async deleteChatForMe(
    @Param('chatId') chatId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<DeleteChatForMeResponse>> {
    const result = await this.chatsService.deleteChatForMe(chatId, user.sub);
    return ok(result);
  }

  @Post(':chatId/members')
  @HttpCode(HttpStatus.OK)
  async addGroupMembers(
    @Param('chatId') chatId: string,
    @Body() dto: AddGroupMembersDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<GroupMemberUpdateResponse>> {
    const result = await this.chatsService.addGroupMembers(chatId, user.sub, dto.userIds);
    return ok(result);
  }

  @Delete(':chatId/members/:userId')
  @HttpCode(HttpStatus.OK)
  async removeGroupMember(
    @Param('chatId') chatId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<RemoveGroupMemberResponse>> {
    const result = await this.chatsService.removeGroupMember(chatId, user.sub, userId);
    return ok(result);
  }

  @Patch(':chatId')
  @HttpCode(HttpStatus.OK)
  async updateGroupChat(
    @Param('chatId') chatId: string,
    @Body() dto: UpdateGroupChatDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<UpdateGroupChatResponse>> {
    const result = await this.chatsService.updateGroupChat(chatId, user.sub, dto.title);
    return ok(result);
  }
}
