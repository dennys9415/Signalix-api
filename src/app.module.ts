import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ChatsModule } from './chats/chats.module';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { FilesModule } from './files/files.module';
import { LinkPreviewModule } from './link-preview/link-preview.module';
import { MediaModule } from './media/media.module';
import { MessagesModule } from './messages/messages.module';
import { PresenceModule } from './presence/presence.module';
import { ProfileModule } from './profile/profile.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [ConfigModule, DbModule, AuthModule, UsersModule, ChatsModule, MessagesModule, PresenceModule, ProfileModule, MediaModule, FilesModule, LinkPreviewModule],
})
export class AppModule {}
