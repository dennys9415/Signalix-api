import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LinkPreviewModule } from '../link-preview/link-preview.module';
import { PushModule } from '../push/push.module';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  imports: [AuthModule, LinkPreviewModule, PushModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
