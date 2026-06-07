import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import type { SearchInChatRequest } from '@signalix/contracts';

/**
 * GET /chats/:chatId/search query params. `q` is required (≥2 chars to
 * keep ILIKE scans bounded). `limit` defaults higher than the global
 * search since in-chat results are expected to fit on a single screen
 * and the user wants "X of Y" navigation across all matches at once.
 */
export class SearchInChatDto implements SearchInChatRequest {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 100;

  @IsOptional()
  @IsString()
  cursor?: string;
}
