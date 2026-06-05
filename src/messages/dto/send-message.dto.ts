import {
  IsBoolean,
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

  @IsIn([MessageType.TEXT, MessageType.IMAGE, MessageType.FILE])
  messageType!: MessageType.TEXT | MessageType.IMAGE | MessageType.FILE;

  @IsOptional()
  @IsString()
  tempId?: string;

  @IsOptional()
  @IsUUID()
  replyToMessageId?: string;

  @IsOptional()
  @IsBoolean()
  isForwarded?: boolean;
}
