# Signalix API

**Version: v0.7.1**

NestJS REST API for Signalix. Handles authentication, user management, direct + group chats, messages (text / image / file / voice notes), reactions, replies, forwards, edit, delete-for-me / for-everyone, link previews, avatars, presence, transactional email, and Web Push delivery.

## Stack

- **NestJS 10** — TypeScript, strict mode
- **PostgreSQL 16** via `pg` pool (no ORM)
- **Flyway** — SQL migrations in `migrations/`
- **JWT** — access token (1 h), refresh token (30 d, max 5 active devices per user)
- **Resend** — transactional email for password reset and email verification
- **S3-compatible storage** (via `@aws-sdk/client-s3`) — avatars, image messages, file attachments
- **`@signalix/contracts`** — single source of truth for all DTOs and enums

## Architecture

```
Signalix-frontend  ──HTTP──►  Signalix-api  ──SQL──►  PostgreSQL
Signalix-realtime  ──HTTP──►  Signalix-api
```

## Local setup

### Prerequisites

- Node.js 22+
- PostgreSQL 16 running locally, **or** start it via `Signalix-infra` Docker Compose
- Flyway CLI (optional — Docker Compose runs migrations automatically)

### 1. Build contracts

```bash
# From the monorepo root (proyect/)
cd Signalix-contracts
npm install
npm run build
cd ..
```

### 2. Configure env

```bash
cd Signalix-api
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Listen port (default `4000`) |
| `NODE_ENV` | no | `development` or `production` |
| `DATABASE_URL` | **yes** | `postgres://user:pass@host:5432/dbname` |
| `JWT_SECRET` | **yes** | Must match `Signalix-realtime` `JWT_SECRET` |
| `JWT_ACCESS_EXPIRES_IN` | no | Default `1h` |
| `JWT_REFRESH_EXPIRES_IN` | no | Default `30d` |
| `FRONTEND_URL` | **yes** | Origin for OAuth redirects and email links (e.g. `http://localhost:3000`) |
| `GOOGLE_CLIENT_ID` | OAuth | Google OAuth app client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth | Google OAuth app client secret |
| `GOOGLE_CALLBACK_URL` | OAuth | Must be registered in Google Console |
| `GITHUB_CLIENT_ID` | OAuth | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | OAuth | GitHub OAuth app client secret |
| `GITHUB_CALLBACK_URL` | OAuth | Must be registered in GitHub OAuth app settings |
| `APPLE_CLIENT_ID` | OAuth | Apple Service ID (e.g. `com.example.signalix`) |
| `APPLE_TEAM_ID` | OAuth | 10-character Apple Team ID |
| `APPLE_KEY_ID` | OAuth | Key ID from the `.p8` file |
| `APPLE_PRIVATE_KEY` | OAuth | Full `.p8` contents with `\n` replacing real newlines |
| `APPLE_CALLBACK_URL` | OAuth | **Must be HTTPS** — Apple rejects `http://` |
| `RESEND_API_KEY` | Email | Leave empty to skip sending and log URLs to console |
| `EMAIL_FROM` | no | Default `Signalix <onboarding@resend.dev>` |
| `MINIO_ENDPOINT` | **yes** | Internal S3 endpoint reachable by the API process (Docker: `http://minio:9000`) |
| `MINIO_PUBLIC_URL` | **yes** | Externally reachable URL baked into stored avatar / media URLs |
| `MINIO_REGION` | no | Default `us-east-1` |
| `MINIO_ACCESS_KEY` | **yes** | MinIO access key |
| `MINIO_SECRET_KEY` | **yes** | MinIO secret key |
| `MINIO_BUCKET_AVATARS` | no | Default `signalix-avatars` |
| `MINIO_BUCKET_MEDIA` | no | Default `signalix-media` (image messages) |
| `MINIO_BUCKET_FILES` | no | Default `signalix-files` (file attachments) |
| `VAPID_PUBLIC_KEY` | Push | Generated via `npx web-push generate-vapid-keys`. Empty disables push. |
| `VAPID_PRIVATE_KEY` | Push | Pair to the public key. Treat as a secret. |
| `VAPID_SUBJECT` | no | `mailto:` or HTTPS URL identifying the app owner. Default `mailto:admin@signalix.local` |

> **Apple callback URL:** Apple does not permit plain HTTP redirect URIs. Use a tunnel (e.g. ngrok) for local development.
>
> **Resend in development:** leave `RESEND_API_KEY` empty. The API will log password reset and verification URLs to the console so you can test the flow without sending real emails.

### 3. Run

```bash
npm install
npm run start:dev     # ts-node-dev watch mode
# or
npm run build && npm start
```

API is available at `http://localhost:4000/api/v1`.

### Typecheck

```bash
npm run typecheck   # tsc --noEmit
```

### Build

```bash
npm run build   # tsc → dist/
```

## Migrations

Migrations live in `migrations/` and are run by Flyway. In Docker Compose (`Signalix-infra`) Flyway runs automatically before the API starts.

**To apply manually** against a local Postgres:

```bash
flyway \
  -url=jdbc:postgresql://localhost:5432/signalix \
  -user=signalix \
  -password=signalix \
  -locations=filesystem:./migrations \
  migrate
```

| Migration | Contents |
|---|---|
| `V1__init.sql` | `pgcrypto` extension + `users` table |
| `V2__auth.sql` | `auth_providers`, `devices`, `device_sessions` |
| `V3__chat.sql` | `chats`, `chat_participants`, `messages`, `message_status`, `presence` |
| `V4__message_deletions.sql` | `message_deletions` for delete-for-me |
| `V5__password_reset.sql` | `password_reset_tokens` |
| `V6__email_verification.sql` | `email_verification_tokens` |
| `V7__chat_deletions.sql` | `chat_deletions` — per-user visibility cutoff for chat history |
| `V8__message_reactions.sql` | `message_reactions` — emoji reactions |
| `V9__message_reply_forward.sql` | `reply_to_message_id` + `is_forwarded` on `messages` |
| `V10__link_preview.sql` | `link_preview` JSONB column on `messages` |
| `V11__read_state.sql` | `chat_read_state` — persistent unread counters per chat per user |
| `V12__push_subscriptions.sql` | `push_subscriptions` — one row per (user, browser endpoint) for Web Push |
| `V13__chats_avatar_description.sql` | `chats.avatar_url` + `chats.description` — group avatar URL (MinIO public URL) and editable group description (max 500 chars enforced by API DTO) |

Never edit a deployed migration file — always add a new one.

## Endpoint reference

All routes are prefixed `/api/v1`.

### Auth (public)

| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | `{ email, username, password }` → `AuthSessionDTO` |
| POST | `/auth/login` | `{ identifier, password }` — identifier is email **or** username |
| POST | `/auth/refresh` | `{ refreshToken }` → new `AuthSessionDTO` |
| POST | `/auth/forgot-password` | `{ email }` — always returns success (anti-enumeration) |
| POST | `/auth/reset-password` | `{ token, newPassword }` — revokes all device sessions on success |
| POST | `/auth/verify-email` | `{ token }` — marks user as verified |
| POST | `/auth/resend-verification` | `{ email }` — always returns success (anti-enumeration) |
| GET | `/auth/google` | Redirects browser to Google OAuth consent |
| GET | `/auth/google/callback` | Handles Google authorization code; redirects to frontend |
| GET | `/auth/github` | Redirects browser to GitHub OAuth consent |
| GET | `/auth/github/callback` | Handles GitHub authorization code; redirects to frontend |
| GET | `/auth/apple` | Redirects browser to Apple sign-in |
| POST | `/auth/apple/callback` | Handles Apple `form_post` callback; redirects to frontend |

### Users (JWT required)

| Method | Path | Description |
|---|---|---|
| GET | `/users/me` | Returns `UserProfileResponse` — user fields + connected providers |
| GET | `/users/search?q=&limit=` | Partial case-insensitive username search; max 25 results |
| GET | `/users/lookup/:username` | Exact username match |

### Profile (JWT required)

| Method | Path | Description |
|---|---|---|
| POST | `/profile/avatar` | `multipart/form-data` upload; returns updated `UserDTO` |
| DELETE | `/profile/avatar` | Removes the avatar; returns updated `UserDTO` |

### Chats (JWT required)

| Method | Path | Description |
|---|---|---|
| GET | `/chats` | All chats for the current user (direct + group) |
| GET | `/chats/:chatId/messages` | Paginated (newest-first). Query: `limit`, `cursor`. Filters by `chat_deletions.deleted_at` for the caller. |
| POST | `/chats/:chatId/read` | Marks chat as read; clears persistent unread counter |
| POST | `/chats/:chatId/delete-for-me` | Sets `chat_deletions.deleted_at` cutoff for the caller |
| POST | `/chats/group` | `{ title, memberIds }` — creates a group chat |
| PATCH | `/chats/:chatId` | `{ title?, description? }` — renames a group and/or sets the description (owner or admin). Pass `description: null` to clear. At least one field required. |
| POST | `/chats/:chatId/avatar` | `multipart/form-data` (field `avatar`) — uploads a group avatar (JPEG / PNG / WebP, max 5 MB). Owner or admin. Returns `{ chatId, avatarUrl }`. Stored under `chats/{chatId}/` in the `signalix-avatars` bucket. |
| DELETE | `/chats/:chatId/avatar` | Removes the group avatar. Owner or admin. |
| POST | `/chats/:chatId/transfer-ownership` | `{ newOwnerId }` — atomic role swap: caller (current owner) is demoted to admin, target member becomes owner. Owner only. |
| POST | `/chats/:chatId/members` | `{ userIds }` — adds group members (owner or admin) |
| DELETE | `/chats/:chatId/members/:userId` | Removes member or self-leaves the group |

### Messages (JWT required)

| Method | Path | Description |
|---|---|---|
| POST | `/messages/send` | `{ chatId?, recipientUsername?, ciphertext, messageType, replyToMessageId?, isForwarded? }` |
| GET | `/messages/search?q=&limit=&cursor=` | ILIKE substring search over the caller's TEXT messages (≥2 chars, max 50/page). Returns `MessageSearchResultDTO[]` with chat label / avatar, sender, snippet, and keyset `nextCursor`. |
| GET | `/chats/:chatId/search?q=&limit=&cursor=` | ILIKE substring search scoped to one chat. Participant-only. Matches TEXT bodies and FILE filenames (the JSON-stringified payload is substring-matched). Default `limit` 100 (max 200) since in-chat UX needs all matches at once for "X of Y" navigation. |
| POST | `/messages/:messageId/status` | `{ status: delivered\|read }` |
| POST | `/messages/:messageId/delete-for-me` | Soft-deletes the message for the caller only |
| POST | `/messages/:messageId/delete-for-everyone` | Marks message as deleted for all participants |
| PATCH | `/messages/:messageId` | `{ ciphertext }` — edits a text message (sender only) |
| POST | `/messages/:messageId/reaction` | `{ emoji }` — sets/replaces the caller's reaction |
| DELETE | `/messages/:messageId/reaction` | Removes the caller's reaction |

### Files & media (JWT required)

| Method | Path | Description |
|---|---|---|
| POST | `/files/upload` | `multipart/form-data` — uploads a file attachment; returns metadata used in `ciphertext` for `MessageType.FILE` |
| GET | `/files/:messageId/download` | Streams the attachment back; authorization checked against chat participants |
| POST | `/media/upload` | `multipart/form-data` — uploads an image; returns URL used in `ciphertext` for `MessageType.IMAGE` |
| POST | `/media/voice` | `multipart/form-data` (field `audio`) — uploads a voice note (audio/webm, /ogg, /mp4, /aac, /x-m4a, /mpeg, /wav); returns `{ voiceUrl }` baked into `ciphertext` for `MessageType.AUDIO`. Max 10 MB. |

### Web Push (v0.6.0)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/push/public-key` | public | Returns `{ publicKey }` — the VAPID public key (empty string if push is disabled server-side) |
| POST | `/push/subscribe` | JWT | `{ endpoint, keys: { p256dh, auth } }` — upserts the device subscription for the caller |
| DELETE | `/push/unsubscribe` | JWT | `{ endpoint }` — removes the subscription for the caller |

Dispatch: when `MessagesService.sendMessage()` finishes its transaction, it fire-and-forgets a push to every other participant whose `presence.status` is not `online` (or who has no `presence` row). Subscriptions returning **404** or **410** from the push service are pruned automatically by `PushService`.

### Presence (JWT required)

| Method | Path | Description |
|---|---|---|
| GET | `/presence` | Query: `userIds=id1,id2` (comma-separated) |
| POST | `/presence/status` | `{ status: online\|offline\|away }` |

## Project structure

```
src/
  main.ts                      # Bootstrap — ValidationPipe, CORS, /api/v1 prefix
  app.module.ts                # Root module
  config/
    config.module.ts           # Global ConfigModule
    config.service.ts          # Typed env var accessors
  db/
    db.module.ts               # Global DbModule
    db.service.ts              # pg Pool + transaction helper
  common/
    http-exception.filter.ts   # Maps HttpExceptions → ApiResponse<never>
    response.helper.ts         # ok() helper — wraps data in ApiResponse
  email/
    email.module.ts            # EmailModule (exported to AuthModule)
    email.service.ts           # Resend client; sendPasswordReset(), sendEmailVerification()
  auth/
    auth.module.ts
    auth.controller.ts         # All auth endpoints including OAuth callbacks
    auth.service.ts            # Registration, login, refresh, OAuth, password reset, verification
    dto/                       # Input validation DTOs
  users/
    users.module.ts
    users.controller.ts        # me, search, lookup endpoints
    users.service.ts
    dto/
  profile/
    profile.controller.ts      # Avatar upload / remove
    profile.service.ts
  chats/
    chats.controller.ts        # List chats, message history, group create/rename/members, delete-for-me, mark-read
    chats.service.ts
  messages/
    messages.controller.ts     # Send, status update, delete-for-me, delete-for-everyone, edit, reactions
    messages.service.ts
  files/
    files.controller.ts        # File attachment upload + download
    files.service.ts
  media/
    media.controller.ts        # Image upload
    media.service.ts
  link-preview/
    link-preview.service.ts    # Server-side OG/Twitter metadata fetch
  storage/
    storage.service.ts         # S3-compatible client wrapper
  presence/
    presence.controller.ts     # Lookup, status update
    presence.service.ts
  push/
    push.controller.ts         # GET /push/public-key, POST /push/subscribe, DELETE /push/unsubscribe
    push.service.ts            # web-push dispatch + stale-subscription cleanup
migrations/
  V1__init.sql
  V2__auth.sql
  V3__chat.sql
  V4__message_deletions.sql
  V5__password_reset.sql
  V6__email_verification.sql
  V7__chat_deletions.sql
  V8__message_reactions.sql
  V9__message_reply_forward.sql
  V10__link_preview.sql
  V11__read_state.sql
  V12__push_subscriptions.sql
```

## Docker

Build from the **monorepo root** (required — the Dockerfile needs both `Signalix-contracts/` and `Signalix-api/` in the build context):

```bash
# From proyect/
docker build -f Signalix-api/Dockerfile -t signalix-api .
```

The preferred way for local development is `Signalix-infra` Docker Compose, which handles the build context, service dependencies, and Flyway migrations automatically.

## v0.7.1 changelog

### Added
- **`GET /api/v1/messages/search?q=&limit=&cursor=`** — case-insensitive substring lookup over the caller's accessible TEXT messages. `q` is required (2–200 chars); `limit` defaults to 20 (max 50); `cursor` is the base64-ISO of the previous page's last row. Implementation: `messages.ciphertext ILIKE $pat ESCAPE '\\'`, joined against `chat_participants` for access control, with `message_deletions` and `chat_deletions.deleted_at` cutoffs applied. Cursor is keyset on `created_at DESC`. Returns `MessageSearchResultDTO[]` enriched with the chat label (group title or other participant's display name for direct chats), avatar URL, sender info, and a `ciphertext` already truncated server-side via `LEFT(..., 280)`.
- **`GET /api/v1/chats/:chatId/search?q=&limit=&cursor=`** — same ILIKE machinery but scoped to a single chat. Participant-only. Matches `message_type IN ('text', 'file')` — the JSON-stringified FILE payload is substring-matched so filenames embedded inside the JSON are searchable without a JSON cast. Default `limit` 100 (max 200) so the in-chat UX has every match upfront for "X of Y" navigation. Returns `InChatSearchMatchDTO[]` (messageId, sender, ciphertext, messageType, createdAt) + keyset `nextCursor`.

### Not changed
- No new migration. No realtime or contracts breaks.

## v0.7.0 changelog

### Added
- **Group avatar** — `POST /chats/:chatId/avatar` (multipart `avatar`, JPEG/PNG/WebP, ≤5 MB) and `DELETE /chats/:chatId/avatar`. Owner/admin only. `ChatsService.uploadGroupAvatar()` reuses `StorageService` against the existing `signalix-avatars` bucket under a `chats/{chatId}/{uuid}.{ext}` key prefix — no new bucket. Stale objects are pruned in-band when replaced. `ChatsModule` now imports `StorageModule`.
- **Group description** — `chats.description` column (V13). `PATCH /chats/:chatId` accepts `{ title?, description? }`. Description is plain text, max 500 chars, owner/admin editable. `null` clears the field; empty string is normalized to `null`.
- **Transfer ownership** — `POST /chats/:chatId/transfer-ownership` `{ newOwnerId }`. Owner-only. Runs as a single DB transaction: validates the chat type, checks the requester is the current owner, checks the target is a member, demotes the requester to `admin`, promotes the target to `owner`, bumps `chats.updated_at`, returns the full refreshed participant list.
- **`ChatDTO.avatarUrl` and `ChatDTO.description`** — surfaced from `getUserChats()` so chat list rendering and message-view headers pick them up without an extra fetch.

### Changed
- `ChatsService.updateGroupChat` signature changed from `(chatId, userId, title)` to `(chatId, userId, dto)` to accept the new optional title/description shape. PATCH endpoint now rejects bodies with no fields with a 400.
- `assertManager(chatId, userId, action)` helper centralises the owner-or-admin role check used by update/avatar endpoints — keeps error messages and behaviour consistent across surfaces.

### Not changed
- Migration is purely additive — no realtime, no contracts breaks, no existing endpoint signatures changed except for the optional widening of PATCH body.

## v0.6.1 changelog

### Added
- **Voice messages** — `POST /api/v1/media/voice`. Accepts `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/aac`, `audio/x-m4a`, `audio/mpeg`, `audio/wav`, `audio/x-wav`. Max 10 MB. Object key `voice/{userId}/{uuid}.{ext}` in the `signalix-media` bucket (no new bucket). Returns `{ voiceUrl }` which the frontend wraps into `ciphertext = JSON.stringify({ url, duration, size })` and sends as `MessageType.AUDIO`.
- **Push preview for AUDIO** — `previewForPush()` returns `🎙️ Voice message` for `MessageType.AUDIO`, so offline-recipient pushes show a sensible body.

### Fixed
- **`SendMessageDto` accepts AUDIO** — `@IsIn(...)` previously only allowed TEXT, IMAGE, FILE. AUDIO messages from the frontend were rejected with 400 by `class-validator` even though MinIO already had the upload. Widened to include `MessageType.AUDIO`; TS type bound to the new `SendableMessageType` alias from contracts. This is the breaker that made v0.6.1's voice send round-trip work end-to-end.

### Not changed
- DB schema — `V3__chat.sql`'s `CHECK (message_type IN ('text', 'image', 'video', 'audio', 'file'))` already permitted 'audio'.

## v0.6.0 changelog

### Added
- **Web Push** — `PushModule` (controller + service + DTOs). New table `push_subscriptions` (V12). Endpoints: `GET /push/public-key`, `POST /push/subscribe`, `DELETE /push/unsubscribe`. `web-push` dependency. VAPID env vars (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). `PushService.sendToUser()` prunes stale subscriptions on 404/410.
- **Offline-recipient push trigger** — `MessagesService.sendMessage()` queries `presence` for non-sender participants and dispatches a push to anyone not currently `online`. Fire-and-forget; failure never blocks the response.

### Not changed
- Realtime (`Signalix-realtime`) untouched — the offline check uses the `presence` table only.

## v0.5.0 changelog

### Added since v0.2.0
- **Group chats** — `POST /chats/group`, `PATCH /chats/:chatId` (rename), `POST /chats/:chatId/members` (add), `DELETE /chats/:chatId/members/:userId` (remove or self-leave); owner role enforced
- **Delete chat for me** — `POST /chats/:chatId/delete-for-me`; stored in `chat_deletions`; `getMessages()` filters by visibility cutoff
- **Mark chat as read** — `POST /chats/:chatId/read`; persistent unread counters via `chat_read_state`
- **Edit message** — `PATCH /messages/:messageId` (text only, sender only); emits `server.message.edited`
- **Delete for everyone** — `POST /messages/:messageId/delete-for-everyone`; placeholder shown for all participants; emits `server.message.deleted_for_everyone`
- **Reactions** — `POST /messages/:messageId/reaction` + `DELETE /messages/:messageId/reaction`; one reaction per user per message; emits `server.message.reaction_updated`
- **Reply / Forward** — `replyToMessageId` and `isForwarded` accepted on send; embedded `ReplyPreviewDTO` returned on reads
- **Link previews** — `LinkPreviewService` extracts OG/Twitter metadata on first send; stored as JSONB
- **Avatar upload** — `POST /profile/avatar` and `DELETE /profile/avatar` (S3-backed via `StorageService`)
- **Image messages** — `POST /media/upload`; `ciphertext` carries the public URL with `messageType: IMAGE`
- **File attachments** — `POST /files/upload` + `GET /files/:messageId/download`; `ciphertext` carries `{ url, name, size }` JSON with `messageType: FILE`

### v0.5.0 stabilization
- New users now receive `avatarUrl: null` (no provider-default fallback)
- Old messages no longer reappear after delete-and-restart of a direct chat — `chat_deletions.deleted_at` is updated to `NOW()` on re-delete and `messages.service.ts` no longer clears `chat_deletions` for other participants
- Direct chat reopen now matches `ChatType.DIRECT` only — group chats can no longer be reopened by username
- First message sent from a draft chat carries only `recipientUsername` (no client-side `draft:<id>` chatId), so realtime correctly creates the chat and delivers `server.message.new` to the recipient

## Known limitations

- **No email required for login blocking** — users with `is_verified = false` can still log in. Blocking unverified logins is a future policy decision.
- **Max 5 active devices per user** — oldest device session is evicted on the 6th login.
- **`ciphertext` stored as plain text** — Signal Protocol is not implemented.
- **No push notifications** — delivery requires an active WebSocket connection.
- **Group read receipts collapsed** — only one `READ` state per message (no per-participant matrix yet).
- **Apple callback must be HTTPS** — plain HTTP is rejected by Apple.

## Planned

- Block login for unverified email (configurable)
- Per-participant read receipts in group chats
- Push notification delivery
- Search inside conversations
- Signal Protocol / E2EE
