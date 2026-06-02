# Signalix API

NestJS REST API for Signalix v0.1.

## Stack

- **NestJS 10** — TypeScript, strict mode
- **PostgreSQL** via `pg` pool (no ORM)
- **Flyway** — SQL migrations in `migrations/`
- **JWT** — access token (1 h), refresh token (30 d, max 5 devices)
- **`@signalix/contracts`** — single source of truth for all DTOs and enums

## Local setup

### Prerequisites

- Node.js 22+
- PostgreSQL 16 running locally, **or** start the DB via `Signalix-infra` Docker Compose

### 1. Build contracts

The API depends on `@signalix/contracts` via a local `file:` reference. Build it first:

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

| Variable                 | Required | Description                                    |
|--------------------------|----------|------------------------------------------------|
| `PORT`                   | no       | Listen port (default `4000`)                   |
| `NODE_ENV`               | no       | `development` or `production`                  |
| `DATABASE_URL`           | **yes**  | `postgres://user:pass@host:5432/dbname`        |
| `JWT_SECRET`             | **yes**  | Must match `Signalix-realtime` JWT_SECRET      |
| `JWT_ACCESS_EXPIRES_IN`  | no       | Default `1h`                                   |
| `JWT_REFRESH_EXPIRES_IN` | no       | Default `30d`                                  |

### 3. Run

```bash
npm install
npm run start:dev     # watch mode
# or
npm run build && npm start
```

API is available at `http://localhost:4000/api/v1`.

### Typecheck

```bash
npm run build   # tsc compilation check
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

Migration naming convention — never edit a deployed file, always add a new one:

```
V1__init.sql     — pgcrypto extension + users table
V2__auth.sql     — auth_providers, devices, device_sessions
V3__chat.sql     — chats, chat_participants, messages, message_status, presence
V4__<name>.sql   — next migration
```

## Endpoint reference

All routes are prefixed `/api/v1`.

### Auth (public)

| Method | Path                    | Body / Notes                          |
|--------|-------------------------|---------------------------------------|
| POST   | `/auth/register`        | `{ email, username, password }`       |
| POST   | `/auth/login`           | `{ identifier, password }` — identifier is email **or** username |
| POST   | `/auth/refresh`         | `{ refreshToken }`                    |

### Chats (JWT required)

| Method | Path                            | Notes                                |
|--------|---------------------------------|--------------------------------------|
| GET    | `/chats`                        | All chats for the current user       |
| GET    | `/chats/:chatId/messages`       | Paginated, newest-first. Query: `limit`, `cursor` |

### Messages (JWT required)

| Method | Path                            | Notes                                |
|--------|---------------------------------|--------------------------------------|
| POST   | `/messages/send`                | `{ chatId?, recipientUsername?, ciphertext, messageType }` |
| POST   | `/messages/:messageId/status`   | `{ messageId, status: delivered\|read }` |

### Users (JWT required)

| Method | Path                            | Notes                              |
|--------|---------------------------------|------------------------------------|
| GET    | `/users/lookup/:username`       | Exact username match               |

### Presence (JWT required)

| Method | Path                   | Notes                                          |
|--------|------------------------|------------------------------------------------|
| GET    | `/presence`            | Query: `userIds=id1,id2` (comma-separated)     |
| POST   | `/presence/status`     | `{ status: online\|offline\|away }`            |

## Project structure

```
src/
  main.ts                    # Bootstrap — ValidationPipe, CORS, /api/v1 prefix
  app.module.ts              # Root module
  config/                    # Global ConfigModule + ConfigService (env vars)
  db/                        # Global DbModule + DbService (pg Pool + transactions)
  common/
    http-exception.filter.ts # Maps HttpExceptions to ApiResponse<never>
    response.helper.ts       # ok() helper — wraps data in ApiResponse
  auth/                      # JWT issuance, refresh, guards
  users/                     # Username lookup
  chats/                     # Chat list, message history
  messages/                  # Send message, update status
  presence/                  # Presence lookup + status update
migrations/
  V1__init.sql
  V2__auth.sql
  V3__chat.sql
```

## Docker

Build image from the **monorepo root** (required — the Dockerfile needs both `Signalix-contracts/` and `Signalix-api/` in build context):

```bash
# From proyect/
docker build -f Signalix-api/Dockerfile -t signalix-api .
```

The preferred way for local development is `Signalix-infra` Docker Compose, which handles build context and service dependencies automatically.

## Known v0.1 limitations

- **No OAuth** — only username/email + password.
- **No password reset** — no email delivery in v0.1.
- **Max 5 active devices per user** — oldest device session is evicted on the 6th login.
- **Ciphertext stored as plain text** — Signal Protocol is not implemented; `ciphertext` is the message body with no encryption applied.
- **No group chats** — `ChatType.DIRECT` only.
- **No media uploads** — text messages only.
- **No push notifications** — delivery requires an active WebSocket connection or polling.
