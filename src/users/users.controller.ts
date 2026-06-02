import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { ApiResponse, ExactUsernameLookupResponse } from '@signalix/contracts';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ok } from '../common/response.helper';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('lookup/:username')
  async lookup(
    @Param('username') username: string,
  ): Promise<ApiResponse<ExactUsernameLookupResponse>> {
    const user = await this.usersService.findByUsername(username);
    return ok({ user });
  }
}
