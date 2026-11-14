# Recollect backend

Express 5 + Prisma 7 on PostgreSQL, with a Hocuspocus (Yjs) server for live docs.
Conventions for changing or adding modules: [docs/MIGRATION_CONVENTIONS.md](docs/MIGRATION_CONVENTIONS.md).

## Run locally

Needs Node 22+. No MongoDB or Redis.

```bash
npm install                # also runs `prisma generate`
npm run db:start           # local Postgres 17 on 127.0.0.1:5433 (data in .devdb/); keep it running
npm run db:migrate         # apply prisma/migrations to recollect_dev
npm run db:seed            # dev login: dev@recollect.local / devpass123 (local databases only)
npm run dev                # API on $PORT, live collaboration on $COLLAB_PORT (default 1234)
```

`backend/.env` needs at least `DATABASE_URL` (e.g. `postgresql://postgres:postgres@127.0.0.1:5433/recollect_dev`),
`TEST_DATABASE_URL` (`…/recollect_test`), `PORT`, `JWT_SECRET`, `JWT_EXPIRE`, `JWT_COOKIE_EXPIRE` and `FRONTEND_URL`.
Email (`EMAIL_*`), Cloudinary (`CLOUDINARY_*`), Google login (`GOOGLE_*`) and the AI keys (`GROQ_API_KEY`,
`GEMINI_API_KEY`, `COHERE_API_KEY`) are only needed for those features.
Recall mode (the Claude API) needs `CLAUDE_API_KEY` (without it `/api/recall` and `/api/ai` answer 503
`AI_NOT_CONFIGURED`); optional: `RECALL_MODEL` (default `claude-opus-5-5`) and `RECALL_NIGHTLY_BATCH=off` to stop the
02:30 question batch.

On a server: `npm run build`, `npm run db:deploy` (migrate without prompts), then `pm2 reload ecosystem.config.js --env production`.

## Tests

```bash
npm run typecheck                                  # src + tests + seed
npm run test:unit                                  # pure logic, no database
npm run test:int                                   # API + Hocuspocus against Postgres (TEST_DATABASE_URL)
TEST_DB_NAME=recollect_test_me npm run test:int    # your own test database (created + migrated automatically)
npm test                                           # both projects
```

PowerShell: `$env:TEST_DB_NAME='recollect_test_me'; npm run test:int`. Integration tests truncate every table,
so the test database name must contain `test` and can never be the dev database.
