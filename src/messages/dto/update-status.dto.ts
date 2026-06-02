import { IsIn } from 'class-validator';
import { MessageStatus } from '@signalix/contracts';

export class UpdateStatusDto {
  @IsIn([MessageStatus.DELIVERED, MessageStatus.READ])
  status!: MessageStatus.DELIVERED | MessageStatus.READ;
}
