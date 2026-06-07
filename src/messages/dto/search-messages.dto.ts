import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import type { SearchMessagesRequest } from '@signalix/contracts';

/**
 * GET /messages/search query params. `q` must be at least 2 chars to keep
 * ILIKE scans bounded; the cap mirrors the message ciphertext column.
 * `limit` defaults to 20 (overridable up to 50); `cursor` is the base64
 * ISO timestamp of the previous page's last result.
 */
export class SearchMessagesDto implements SearchMessagesRequest {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;

  @IsOptional()
  @IsString()
  cursor?: string;
}
