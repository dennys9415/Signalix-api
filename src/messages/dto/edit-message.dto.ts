import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { EditMessageRequest } from '@signalix/contracts';
import { GroupRecipientPayloadDto } from './send-message.dto';

export class EditMessageDto implements EditMessageRequest {
  // For group encrypted edits the top-level body is empty and the per-recipient
  // payloads carry the ciphertext, so we accept empty here. Length cap stays
  // permissive enough for a normal-sized direct E2EE envelope.
  @IsString()
  @MaxLength(16_384)
  ciphertext!: string;

  // v0.10.0 — envelope re-routing on edit (direct E2EE re-encrypt path).
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

  // v0.10.0 — per-recipient re-encrypted payloads for group E2EE edits.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => GroupRecipientPayloadDto)
  recipients?: GroupRecipientPayloadDto[];
}
