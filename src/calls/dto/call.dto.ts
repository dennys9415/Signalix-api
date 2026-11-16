import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CallEndReason, CallType } from '@signalix/contracts';

export class CreateCallDto {
  @IsUUID('4')
  callId!: string;

  @IsUUID('4')
  chatId!: string;

  @IsEnum(CallType)
  callType!: CallType;
}

export class EndCallDto {
  @IsEnum(CallEndReason)
  reason!: CallEndReason;
}

export class CallHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
