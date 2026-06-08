import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MessageType,
  type GroupRecipientPayloadDTO,
  type SendMessageRequest,
  type SendableMessageType,
} from '@signalix/contracts';

export class GroupRecipientPayloadDto implements GroupRecipientPayloadDTO {
  @IsUUID()
  recipientUserId!: string;

  @IsUUID()
  recipientDeviceId!: string;

  @IsString()
  @IsNotEmpty()
  // Wire envelope is `JSON.stringify({v,c,iv,eph})` — comfortably under 4 KB
  // for any realistic message, even with very long ciphertext.
  @MaxLength(16_384)
  ciphertext!: string;

  @IsInt()
  @Min(1)
  @Max(255)
  encryptionVersion!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  preKeyId?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  signedPreKeyId?: number;
}

export class SendMessageDto implements SendMessageRequest {
  @IsOptional()
  @IsUUID()
  chatId?: string;

  @IsOptional()
  @IsString()
  recipientUsername?: string;

  // Allow empty string for group encrypted sends where the body lives entirely
  // in `recipients[]`; non-group / plaintext sends still require non-empty.
  @IsString()
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

  // v0.10.0 — per-recipient encrypted payloads for group E2EE. Empty by
  // default; if present and the chat is a group, the service splits the
  // payload into `group_message_recipients` rows.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => GroupRecipientPayloadDto)
  recipients?: GroupRecipientPayloadDto[];
}
