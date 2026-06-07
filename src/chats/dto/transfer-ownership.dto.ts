import { IsNotEmpty, IsUUID } from 'class-validator';
import type { TransferGroupOwnershipRequest } from '@signalix/contracts';

export class TransferOwnershipDto implements TransferGroupOwnershipRequest {
  @IsUUID()
  @IsNotEmpty()
  newOwnerId!: string;
}
