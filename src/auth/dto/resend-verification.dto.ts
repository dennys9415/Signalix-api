import { IsEmail } from 'class-validator';
import type { ResendVerificationRequest } from '@signalix/contracts';

export class ResendVerificationDto implements ResendVerificationRequest {
  @IsEmail()
  email!: string;
}
