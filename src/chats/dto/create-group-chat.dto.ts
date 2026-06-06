import { ArrayMinSize, IsArray, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateGroupChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title!: string;

  @IsArray()
  @ArrayMinSize(2)
  @IsUUID('4', { each: true })
  memberIds!: string[];
}
