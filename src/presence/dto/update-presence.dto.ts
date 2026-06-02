import { IsIn } from 'class-validator';
import { PresenceStatus } from '@signalix/contracts';

export class UpdatePresenceDto {
  @IsIn([PresenceStatus.ONLINE, PresenceStatus.OFFLINE, PresenceStatus.AWAY])
  status!: PresenceStatus;
}
