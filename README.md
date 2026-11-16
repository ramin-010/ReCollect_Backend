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

On a server: `npm run build`, `npm run db:deploy` (migrate without prompts), then one `node dist/index.js` process with
the settings below. It stops cleanly on SIGTERM or SIGINT (it stops accepting, ends the background jobs, stores every
live document and closes the database pool, within 20 s).

### Settings for a hosted server

Every one is optional; unset, the server behaves as in development. With `NODE_ENV=production` it refuses to start
(and says why) when `JWT_SECRET` is under 32 characters, `ALLOWED_ORIGINS` or `RECOLLECT_SELF_URL` (https) is unset,
`HOST` is not a loopback address, `SIGNUP_MODE` is unset or `open`, `ASSISTANT_FAKE` is set, or a `DATABASE_URL` on
another host lacks `sslmode=verify-full` (`src/config/productionCheck.ts`).

| Setting | What it does |
|---|---|
| `HOST` | The interface the API listens on (`127.0.0.1` behind a tunnel). Unset: every interface |
| `COLLAB_ATTACH=1` | Live editing on the API's own listener at `/collab` (the frontend's `NEXT_PUBLIC_COLLAB_URL` ends with it). Unset: its own port, `COLLAB_PORT` (1234) |
| `PG_POOL_MAX` | Database connections (10). The pool gives up a connect after 10 s and closes idle ones after 60 s |
| `SCHEDULER_MODE=quiet` | Background jobs touch the database only when something is due (timers, pokes from the services that change what is due, a sweep every `SWEEP_MINUTES`, 180), so a database that sleeps when idle can sleep. Unset (`poll`): the crons as in development |
| `RECOLLECT_STATE_DIR` | Where the quiet mode's awake-time meter keeps its file (default `.devdb/state`) |
| `OWNER_EMAIL` | The account that may call `GET /api/health/db` and gets the awake meter's alerts. Unset: any signed-in account may check, no alert is sent |
| `SIGNUP_MODE` / `SIGNUP_ALLOWLIST` | `open` (default), `allowlist` (the listed emails) or `closed`: every way an account is made, a placeholder's claim too |
| `TRUST_CF_IP=1` | Read the visitor's address from `CF-Connecting-IP` when the request comes from loopback (for the limits on login, signup, codes, OAuth and `/mcp`) |
| `AI_ALLOWED_EMAILS` | Only these accounts use the AI. Unset: everyone |
| `AI_MAX_CAP_USD` | The highest monthly AI cap an account may set (default 1000) |
| `COOKIE_SAMESITE` | `lax`, `strict` or `none` for the login cookie. Unset: `none` in production, `lax` in development |
| `BUDDY_OFFICE_CAPTURE=off` | Words a hook marks as office work are dropped on arrival (counted) |
| `REMINDER_EMAIL=off` | No reminder emails at all (the phone app rings for them) |

`GET /healthz` answers 200 while the process is up and never touches the database.

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
