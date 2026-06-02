import { IsString } from 'class-validator';
import type { RefreshTokenRequest } from '@signalix/contracts';

export class RefreshDto implements RefreshTokenRequest {
  @IsString()
  refreshToken!: string;
}
