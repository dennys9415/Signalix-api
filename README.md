# Signalix API

**Version: v0.2.0**

NestJS REST API for Signalix. Handles authentication, user management, chats, messages, presence, and transactional email.

## Stack

- **NestJS 10** — TypeScript, strict mode
- **PostgreSQL 16** via `pg` pool (no ORM)
- **Flyway** — SQL migrations in `migrations/`
- **JWT** — access token (1 h), refresh token (30 d, max 5 active devices per user)
- **Resend** — transactional email for password reset and email verification
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

### Chats (JWT required)

| Method | Path | Description |
|---|---|---|
| GET | `/chats` | All chats for the current user |
| GET | `/chats/:chatId/messages` | Paginated (newest-first). Query: `limit`, `cursor` |

### Messages (JWT required)

| Method | Path | Description |
|---|---|---|
| POST | `/messages/send` | `{ chatId?, recipientUsername?, ciphertext, messageType }` |
| POST | `/messages/:messageId/status` | `{ status: delivered\|read }` |
| POST | `/messages/:messageId/delete-for-me` | Soft-deletes the message for the caller only |

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
  chats/
    chats.controller.ts        # List chats, message history
    ...
  messages/
    messages.controller.ts     # Send, status update, delete-for-me
    ...
  presence/
    presence.controller.ts     # Lookup, status update
    ...
migrations/
  V1__init.sql
  V2__auth.sql
  V3__chat.sql
  V4__message_deletions.sql
  V5__password_reset.sql
  V6__email_verification.sql
```

## Docker

Build from the **monorepo root** (required — the Dockerfile needs both `Signalix-contracts/` and `Signalix-api/` in the build context):

```bash
# From proyect/
docker build -f Signalix-api/Dockerfile -t signalix-api .
```

The preferred way for local development is `Signalix-infra` Docker Compose, which handles the build context, service dependencies, and Flyway migrations automatically.

## v0.2.0 changelog

### Added
- **Google OAuth** — `GET /auth/google` + `GET /auth/google/callback`
- **GitHub OAuth** — `GET /auth/github` + `GET /auth/github/callback`; private email fallback via `GET /user/emails`
- **Apple OAuth** — `GET /auth/apple` + `POST /auth/apple/callback` (form_post); ES256 client secret via `@nestjs/jwt`
- **Password reset** — `POST /auth/forgot-password` + `POST /auth/reset-password`; 32-byte random token, SHA-256 hash stored, 15-min TTL
- **Email verification** — `POST /auth/verify-email` + `POST /auth/resend-verification`; 32-byte random token, SHA-256 hash stored, 24-hour TTL; new local registrations start as unverified
- **Resend email integration** — `EmailService` with `sendPasswordReset` and `sendEmailVerification`; graceful fallback to console log when `RESEND_API_KEY` is absent
- **Partial username search** — `GET /users/search?q=&limit=`; case-insensitive `ILIKE` contains match, excludes caller
- **Delete for me** — `POST /messages/:messageId/delete-for-me`; stored in `message_deletions`; excluded from history for the requesting user
- **User profile endpoint** — `GET /users/me`; returns user fields + list of connected OAuth providers
- **Display name** — `display_name` surface exposed through `UserDTO`

### Fixed
- OAuth link case: linking a provider to an existing unverified local account now sets `is_verified = true`

## Known limitations

- **No email required for login blocking** — users with `is_verified = false` can still log in. Blocking unverified logins is a future policy decision.
- **Max 5 active devices per user** — oldest device session is evicted on the 6th login.
- **`ciphertext` stored as plain text** — Signal Protocol is not implemented.
- **No group chats** — `ChatType.DIRECT` only.
- **No media uploads** — text messages only.
- **No push notifications** — delivery requires an active WebSocket connection.
- **Apple callback must be HTTPS** — plain HTTP is rejected by Apple.

## Planned

- Block login for unverified email (configurable)
- Message edit (`PUT /messages/:id`)
- Delete for everyone
- Group chats
- Media uploads
- Push notification delivery
