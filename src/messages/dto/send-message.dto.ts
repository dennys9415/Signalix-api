import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { MessageType, type SendMessageRequest } from '@signalix/contracts';

export class SendMessageDto implements SendMessageRequest {
  @IsOptional()
  @IsUUID()
  chatId?: string;

  @IsOptional()
  @IsString()
  recipientUsername?: string;

  @IsString()
  @IsNotEmpty()
  ciphertext!: string;

  // v0.1 supports text only
  @IsIn([MessageType.TEXT])
  messageType!: MessageType.TEXT;

  @IsOptional()
  @IsString()
  tempId?: string;
}
