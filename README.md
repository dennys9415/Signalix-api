# Signalix API

NestJS REST API for Signalix v0.1.

## Stack

- NestJS 10, TypeScript
- PostgreSQL + direct `pg` queries
- Flyway migrations
- JWT auth (access 1h / refresh 30d)
- Contracts from `@signalix/contracts`

## Local development

### Prerequisites

- Node 22+
- PostgreSQL running (or use Docker Compose from `Signalix-infra`)

### Setup

```bash
# From the monorepo root (proyect/)
cd Signalix-contracts && npm install && npm run build && cd ..

cd Signalix-api
cp .env.example .env
# Edit .env — set DATABASE_URL and JWT_SECRET
npm install
npm run start:dev
```

### Migrations

Migrations live in `migrations/` and are run by Flyway. In local development,
Flyway runs automatically via Docker Compose in `Signalix-infra`.

To run manually:

```bash
flyway -url=jdbc:postgresql://localhost:5432/signalix \
       -user=signalix -password=signalix \
       -locations=filesystem:./migrations migrate
```

### Build

```bash
npm run build
npm start
```

### Docker

Build from the monorepo root:

```bash
docker build -f Signalix-api/Dockerfile -t signalix-api .
```

## Project structure

```
src/
  main.ts          # Bootstrap
  app.module.ts    # Root module
  config/          # ConfigModule + ConfigService (env vars)
  db/              # DbModule + DbService (pg Pool wrapper)
migrations/
  V1__init.sql     # pgcrypto + users
  V2__auth.sql     # auth_providers + devices + device_sessions
  V3__chat.sql     # chats + messages + message_status + presence
```

## API prefix

All routes are served under `/api/v1`.
