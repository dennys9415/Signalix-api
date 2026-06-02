import { IsOptional, IsString } from 'class-validator';
import type { LoginRequest } from '@signalix/contracts';

export class LoginDto implements LoginRequest {
  @IsString()
  identifier!: string;

  @IsString()
  password!: string;

  @IsOptional()
  @IsString()
  deviceName?: string;

  @IsOptional()
  @IsString()
  userAgent?: string;
}
