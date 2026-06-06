# Claude Instructions — Signalix API

This is `Signalix-api`, the NestJS REST API for Signalix v0.1.

## Absolute Rules

1. Use `@signalix/contracts` for all DTOs, enums, and response shapes. Never invent local duplicates.
2. All API responses must use `ApiResponse<T>` from contracts.
3. Use direct SQL with `pg` via `DbService`. Never use Prisma or an ORM.
4. Do not implement real E2EE, OAuth, password reset, or group chats in v0.1.
5. Always use `ciphertext` — never `content` — for message text.
6. JWT: access token 1h, refresh token 30d, max 5 active devices per user.
7. Do not invent new migrations without first updating this file.
8. `READ` always wins over `DELIVERED`/`SENT`. Message status must never revert.

## Technology

- NestJS 10
- TypeScript (strict)
- PostgreSQL + `pg` Pool
- Flyway migrations in `migrations/`
- JWT via `@nestjs/jwt`

## Module conventions

- Each domain feature gets its own NestJS module: `AuthModule`, `UsersModule`, `ChatsModule`, `MessagesModule`, `PresenceModule`.
- `ConfigModule` and `DbModule` are global — do not re-import them.
- Services inject `DbService` for all database access.
- Controllers are thin: validate input, call service, return `ApiResponse<T>`.
- Use `class-validator` decorators on DTO classes for request validation.

## Migration naming

```
V1__init.sql              — pgcrypto + users
V2__auth.sql              — auth_providers + devices + device_sessions
V3__chat.sql              — chats + messages + message_status + presence
V4__message_deletions.sql — per-user message deletions
V5__password_reset.sql    — password reset tokens
V6__email_verification.sql — email verification tokens
V7__chat_deletions.sql    — per-user chat deletions
V8__message_reactions.sql — emoji reactions
V9__message_reply_forward.sql — reply/forward metadata
V10__link_preview.sql     — link_preview JSONB column on messages
V11__read_state.sql       — chat_read_state table for persistent unread counts
```

Never edit a deployed migration. Always add a new file.

## Error handling

Throw NestJS `HttpException` subclasses with `ErrorCode` values from contracts:

```ts
import { ErrorCode } from '@signalix/contracts';
throw new ConflictException({ code: ErrorCode.USERNAME_TAKEN, message: '...' });
```

## What is NOT implemented in v0.1

- OAuth
- Password reset
- Media uploads
- Real E2EE / Signal Protocol
- Push notifications
- Advanced multi-device sync
- Redis / Kafka / NATS
