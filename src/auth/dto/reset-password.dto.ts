import { IsString, MinLength } from 'class-validator';
import type { ResetPasswordRequest } from '@signalix/contracts';

export class ResetPasswordDto implements ResetPasswordRequest {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}
