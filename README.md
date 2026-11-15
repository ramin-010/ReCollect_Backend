# Recollect backend

Express 5 + Prisma 7 on PostgreSQL, with a Hocuspocus (Yjs) server for live docs.
Conventions for changing or adding modules: [docs/MIGRATION_CONVENTIONS.md](docs/MIGRATION_CONVENTIONS.md).

## Run locally

Needs Node 22+. No MongoDB or Redis.

```bash
npm install                # also runs `prisma generate`
npm run db:start           # local Postgres 17 on 127.0.0.1:5433 (data in .devdb/); keep it running
npm run db:deploy          # apply prisma/migrations (new migrations: docs/MIGRATION_CONVENTIONS.md, never `migrate dev`)
npm run db:seed            # the QA login qa@recollect.local / qapass123 with a sample (local databases only)
npm run dev                # API on $PORT, live collaboration on $COLLAB_PORT (default 1234)
```

`backend/.env` needs at least `DATABASE_URL` (e.g. `postgresql://postgres:postgres@127.0.0.1:5433/recollect_dev`),
`TEST_DATABASE_URL` (`…/recollect_test`), `PORT`, `JWT_SECRET`, `JWT_EXPIRE`, `JWT_COOKIE_EXPIRE` and `FRONTEND_URL`.
Email (`EMAIL_*`), Cloudinary (`CLOUDINARY_*`) and Google login (`GOOGLE_*`) are only needed for those features.
The app's AI (Recall, the practice note, the coach, the `@ai` task line) is the Claude API: `CLAUDE_API_KEY` (without
it `/api/recall` and `/api/ai` answer 503 `AI_NOT_CONFIGURED`, and the task line keeps the text as a plain task);
optional: `RECALL_MODEL` (default `claude-opus-5-5`), `TASK_AI_MODEL` (default `claude-haiku-5-5`) and
`RECALL_NIGHTLY_BATCH=off` to stop the 02:30 question batch.

**Doc search** runs on Postgres full-text (`src/services/docs/docSearch.service.ts`). A doc's words (`Doc.searchText`)
are written by the search itself and at the server's start; `npm run search:reindex` writes any missing ones now, and
`npm run search:reindex -- --all` writes every doc's again (after a change to how words are read from a doc).

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
