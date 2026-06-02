import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';

export class GetMessagesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  // Base64-encoded ISO timestamp from the previous page's nextCursor.
  // Takes precedence over `before` when both are supplied.
  @IsOptional()
  @IsString()
  cursor?: string;

  // Load messages created strictly before this ISO timestamp.
  @IsOptional()
  @IsISO8601()
  before?: string;
}
