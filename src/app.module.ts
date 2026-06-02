import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ChatsModule } from './chats/chats.module';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { MessagesModule } from './messages/messages.module';
import { PresenceModule } from './presence/presence.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [ConfigModule, DbModule, AuthModule, UsersModule, ChatsModule, MessagesModule, PresenceModule],
})
export class AppModule {}
