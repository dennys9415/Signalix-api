import { Body, Controller, HttpCode, HttpStatus, Ip, Post } from '@nestjs/common';
import type { ApiResponse, AuthSessionDTO } from '@signalix/contracts';
import { ok } from '../common/response.helper';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
    @Ip() ip: string,
  ): Promise<ApiResponse<AuthSessionDTO>> {
    const session = await this.authService.register(dto, ip);
    return ok(session);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
  ): Promise<ApiResponse<AuthSessionDTO>> {
    const session = await this.authService.login(dto, ip);
    return ok(session);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshDto,
  ): Promise<ApiResponse<AuthSessionDTO>> {
    const session = await this.authService.refresh(dto.refreshToken);
    return ok(session);
  }
}
