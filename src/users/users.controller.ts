import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type {
  ApiResponse,
  ExactUsernameLookupResponse,
  UserSearchResponse,
} from '@signalix/contracts';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ok } from '../common/response.helper';
import { SearchUsersDto } from './dto/search-users.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('search')
  async search(
    @Query() dto: SearchUsersDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<UserSearchResponse>> {
    const users = await this.usersService.searchUsers(dto.q, dto.limit ?? 10, user.sub);
    return ok({ users });
  }

  @Get('lookup/:username')
  async lookup(
    @Param('username') username: string,
  ): Promise<ApiResponse<ExactUsernameLookupResponse>> {
    const user = await this.usersService.findByUsername(username);
    return ok({ user });
  }
}
