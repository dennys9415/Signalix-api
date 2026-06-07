import { IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { UpdateGroupChatRequest } from '@signalix/contracts';

/**
 * PATCH /chats/:chatId
 * At least one of title / description must be present. Description may be
 * set to `null` (or empty string) to clear the field.
 */
export class UpdateGroupChatDto implements UpdateGroupChatRequest {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title?: string;

  // ValidateIf lets null pass while still running IsString when defined.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;
}
