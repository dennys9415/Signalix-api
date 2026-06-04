import { IsEmail } from 'class-validator';
import type { ForgotPasswordRequest } from '@signalix/contracts';

export class ForgotPasswordDto implements ForgotPasswordRequest {
  @IsEmail()
  email!: string;
}
