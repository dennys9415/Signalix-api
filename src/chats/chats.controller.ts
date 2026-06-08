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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type {
  ApiResponse,
  ChatDTO,
  CreateGroupChatResponse,
  DeleteChatForMeResponse,
  GetMessagesResponse,
  GroupAvatarUploadResponse,
  GroupMemberUpdateResponse,
  MarkChatReadResponse,
  RemoveGroupMemberResponse,
  SearchInChatResponse,
  TransferGroupOwnershipResponse,
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
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import { SearchInChatDto } from './dto/search-in-chat.dto';
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

  @Get(':chatId')
  async getChatById(
    @Param('chatId') chatId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<{ chat: ChatDTO }>> {
    const chat = await this.chatsService.getChatById(chatId, user.sub);
    return ok({ chat });
  }

  @Get(':chatId/search')
  async searchInChat(
    @Param('chatId') chatId: string,
    @CurrentUser() user: JwtPayload,
    @Query() query: SearchInChatDto,
  ): Promise<ApiResponse<SearchInChatResponse>> {
    const result = await this.chatsService.searchInChat(chatId, user.sub, query.q, query.limit, query.cursor);
    return ok(result);
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
      user.deviceId,
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
    const result = await this.chatsService.updateGroupChat(chatId, user.sub, dto);
    return ok(result);
  }

  @Post(':chatId/avatar')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('avatar', { storage: memoryStorage() }))
  async uploadGroupAvatar(
    @Param('chatId') chatId: string,
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ApiResponse<GroupAvatarUploadResponse>> {
    const result = await this.chatsService.uploadGroupAvatar(chatId, user.sub, file);
    return ok(result);
  }

  @Delete(':chatId/avatar')
  @HttpCode(HttpStatus.OK)
  async removeGroupAvatar(
    @Param('chatId') chatId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<{ chatId: string }>> {
    await this.chatsService.removeGroupAvatar(chatId, user.sub);
    return ok({ chatId });
  }

  @Post(':chatId/transfer-ownership')
  @HttpCode(HttpStatus.OK)
  async transferOwnership(
    @Param('chatId') chatId: string,
    @Body() dto: TransferOwnershipDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<TransferGroupOwnershipResponse>> {
    const result = await this.chatsService.transferOwnership(chatId, user.sub, dto.newOwnerId);
    return ok(result);
  }
}
