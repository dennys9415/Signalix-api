import { IsString, IsNotEmpty } from 'class-validator';
import type { VerifyEmailRequest } from '@signalix/contracts';

export class VerifyEmailDto implements VerifyEmailRequest {
  @IsString()
  @IsNotEmpty()
  token!: string;
}
