import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { MessageType, type SendMessageRequest, type SendableMessageType } from '@signalix/contracts';

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

  @IsIn([MessageType.TEXT, MessageType.IMAGE, MessageType.FILE, MessageType.AUDIO])
  messageType!: SendableMessageType;

  @IsOptional()
  @IsString()
  tempId?: string;

  @IsOptional()
  @IsUUID()
  replyToMessageId?: string;

  @IsOptional()
  @IsBoolean()
  isForwarded?: boolean;

  // Encryption envelope (v0.8.0 foundation). Optional; 0 == plaintext.
  // Once v0.9.0 ships, the frontend's crypto layer will start populating
  // these. Server today just persists them.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(255)
  encryptionVersion?: number;

  @IsOptional()
  @IsUUID()
  senderDeviceId?: string;

  @IsOptional()
  @IsUUID()
  recipientDeviceId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  preKeyId?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  signedPreKeyId?: number;
}
