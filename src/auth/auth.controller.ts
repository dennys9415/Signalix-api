import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post, Query, Req, Res } from '@nestjs/common';
import type { ApiResponse, AuthSessionDTO, ForgotPasswordResponse, ResendVerificationResponse, ResetPasswordResponse, VerifyEmailResponse } from '@signalix/contracts';
import type { Request, Response } from 'express';
import { ok } from '../common/response.helper';
import { ConfigService } from '../config/config.service';
import { AuthService } from './auth.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

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

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<ApiResponse<ForgotPasswordResponse>> {
    const result = await this.authService.forgotPassword(dto.email);
    return ok(result);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
  ): Promise<ApiResponse<ResetPasswordResponse>> {
    await this.authService.resetPassword(dto.token, dto.newPassword);
    return ok({} as ResetPasswordResponse);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
  ): Promise<ApiResponse<VerifyEmailResponse>> {
    await this.authService.verifyEmail(dto.token);
    return ok({ message: 'Email verified successfully.' });
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  async resendVerification(
    @Body() dto: ResendVerificationDto,
  ): Promise<ApiResponse<ResendVerificationResponse>> {
    await this.authService.resendVerification(dto.email);
    return ok({ message: 'If your email is registered and unverified, a new link has been sent.' });
  }

  // ─── Google OAuth ─────────────────────────────────────────────────────────

  @Get('google')
  googleAuth(@Res() res: Response): void {
    res.redirect(this.authService.getGoogleAuthUrl());
  }

  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string,
    @Query('error') oauthError: string,
    @Ip() ip: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const frontendUrl = this.config.frontendUrl;

    if (!code || oauthError) {
      res.redirect(`${frontendUrl}/login?error=oauth_cancelled`);
      return;
    }

    try {
      const session = await this.authService.loginWithGoogle(
        code,
        req.headers['user-agent'],
        ip,
      );

      const params = new URLSearchParams({
        userId: session.userId,
        deviceId: session.deviceId,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
        refreshTokenExpiresAt: session.refreshTokenExpiresAt,
      });

      res.redirect(`${frontendUrl}/oauth/callback?${params.toString()}`);
    } catch (err) {
      console.error('[Google OAuth]', err);
      res.redirect(`${frontendUrl}/login?error=oauth_failed`);
    }
  }

  // ─── GitHub OAuth ─────────────────────────────────────────────────────────

  @Get('github')
  githubAuth(@Res() res: Response): void {
    res.redirect(this.authService.getGitHubAuthUrl());
  }

  @Get('github/callback')
  async githubCallback(
    @Query('code') code: string,
    @Query('error') oauthError: string,
    @Ip() ip: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const frontendUrl = this.config.frontendUrl;

    if (!code || oauthError) {
      res.redirect(`${frontendUrl}/login?error=oauth_cancelled`);
      return;
    }

    try {
      const session = await this.authService.loginWithGitHub(
        code,
        req.headers['user-agent'],
        ip,
      );

      const params = new URLSearchParams({
        userId: session.userId,
        deviceId: session.deviceId,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
        refreshTokenExpiresAt: session.refreshTokenExpiresAt,
      });

      res.redirect(`${frontendUrl}/oauth/callback?${params.toString()}`);
    } catch (err) {
      console.error('[GitHub OAuth]', err);
      res.redirect(`${frontendUrl}/login?error=oauth_failed`);
    }
  }

  // ─── Apple OAuth ──────────────────────────────────────────────────────────

  @Get('apple')
  appleAuth(@Res() res: Response): void {
    res.redirect(this.authService.getAppleAuthUrl());
  }

  // Apple uses response_mode=form_post — it POSTs the authorization code to
  // the callback URL as application/x-www-form-urlencoded, not a GET redirect.
  @Post('apple/callback')
  @HttpCode(HttpStatus.OK)
  async appleCallback(
    @Body('code') code: string,
    @Body('user') userJson: string | undefined,
    @Body('error') oauthError: string | undefined,
    @Ip() ip: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const frontendUrl = this.config.frontendUrl;

    if (!code || oauthError) {
      res.redirect(`${frontendUrl}/login?error=oauth_cancelled`);
      return;
    }

    try {
      const session = await this.authService.loginWithApple(
        code,
        userJson,
        req.headers['user-agent'],
        ip,
      );

      const params = new URLSearchParams({
        userId: session.userId,
        deviceId: session.deviceId,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
        refreshTokenExpiresAt: session.refreshTokenExpiresAt,
      });

      res.redirect(`${frontendUrl}/oauth/callback?${params.toString()}`);
    } catch (err) {
      console.error('[Apple OAuth]', err);
      res.redirect(`${frontendUrl}/login?error=oauth_failed`);
    }
  }
}
