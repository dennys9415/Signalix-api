import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type {
  ApiResponse,
  KeyBundleResponse,
  RegisterDeviceKeysResponse,
  RotateSignedPreKeyResponse,
  UploadPreKeysResponse,
} from '@signalix/contracts';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ok } from '../common/response.helper';
import { CryptoService } from './crypto.service';
import {
  RegisterDeviceKeysDto,
  RotateSignedPreKeyDto,
  UploadPreKeysDto,
} from './dto/key-material.dto';

/**
 * v0.8.0 encryption-foundation endpoints. The deviceId for write paths
 * is always read from the caller's JWT, never from the request body —
 * a device can only publish/rotate its own keys.
 */
@Controller('crypto')
@UseGuards(JwtAuthGuard)
export class CryptoController {
  constructor(private readonly cryptoService: CryptoService) {}

  @Post('devices/keys')
  @HttpCode(HttpStatus.CREATED)
  async registerDeviceKeys(
    @Body() dto: RegisterDeviceKeysDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<RegisterDeviceKeysResponse>> {
    const result = await this.cryptoService.registerDeviceKeys(user.deviceId, dto);
    return ok(result);
  }

  @Patch('devices/keys/signed-pre-key')
  @HttpCode(HttpStatus.OK)
  async rotateSignedPreKey(
    @Body() dto: RotateSignedPreKeyDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<RotateSignedPreKeyResponse>> {
    const result = await this.cryptoService.rotateSignedPreKey(user.deviceId, dto);
    return ok(result);
  }

  @Post('devices/keys/pre-keys')
  @HttpCode(HttpStatus.OK)
  async uploadPreKeys(
    @Body() dto: UploadPreKeysDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ApiResponse<UploadPreKeysResponse>> {
    const result = await this.cryptoService.uploadPreKeys(user.deviceId, dto);
    return ok(result);
  }

  @Get('users/:userId/key-bundle')
  async getKeyBundle(
    @Param('userId') userId: string,
  ): Promise<ApiResponse<KeyBundleResponse>> {
    const result = await this.cryptoService.getKeyBundle(userId);
    return ok(result);
  }
}
