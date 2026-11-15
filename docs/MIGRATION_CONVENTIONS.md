# Porting a module from Mongo to Postgres (Prisma 7)

Branch `pg-migration`. Read this before you change or add a module. The auth/users/OTP module is the reference port: copy its patterns.

**Status (2026-10-21).** Every kept module runs on Postgres (Prisma 7): auth/users/OTP/Google, docs + share links + access requests, uploads, live collaboration (Hocuspocus), personal todos + AI + tags + reminders, notifications, recent visits, workspaces (members, spaces, invites, assign, workspace todos, activity). **MongoDB is gone:** the Mongoose models, `src/server/db.ts` and the `mongoose`/`mongodb` packages were removed, and the server no longer reads `MONGO_URL`. The BullMQ/Redis reminder mode was removed too (it was hard-disabled; reminders are sent by the in-process cron). The whiteboard (drawings) was cut on 2026-11-14 (code in `_archive/drawing/`). Run it locally: see `backend/README.md`.

---

## 1. Where things live

| What | Where |
|---|---|
| Schema (all 13 kept models + 6 child/join tables) | `prisma/schema.prisma`. **Don't edit it in a module port.** If you really need to, ask the supervisor. |
| Migrations | `prisma/migrations/` (`npm run db:migrate` locally, `npm run db:deploy` on servers) |
| Prisma client singleton | `src/db/prisma.ts`: `prisma`, `DbClient`, `TxClient`, `disconnectPrisma()` |
| Prisma error → HTTP mapping | `src/db/errors.ts` (used by `src/middlwares/errorHandler.ts`), plus `isUniqueViolation()` and `isRecordNotFound()` |
| JSON shape helpers | `src/db/serializers/`: `withMongoId`, `serializeUser`, `serializeUserSummary`, `userSummarySelect`, plus one file per module (doc, docSharing, notification, recentVisit, workspace), all re-exported from `src/db/serializers/index.ts`. Todo shapes: `src/services/todos/todoShape.ts` |
| Search helpers | `src/db/filters.ts`: `containsInsensitive()`, `startsWithInsensitive()`, `escapeLike()` |
| Defaults Prisma can't express | `src/db/defaults.ts`: `defaultShareLinkExpiry()`, `generateInviteToken()` |
| Services (all DB access) | `src/services/<module>/<module>.service.ts` |
| Controllers (thin) | `src/controllers/*`: validate input, call services, shape the response |
| Auth | `src/middlwares/auth.ts`: `authMiddleware` (the JWT cookie, or `Authorization: Bearer rcl_…` personal access tokens for agents), `requireUser(req)`, `isTokenRequest(req)`; `req.auth` = cookie (all scopes) or token (scopes, agent name); `src/middlwares/scopes.ts`: `requireScope`, `scopeByMethod`, `cookieOnly`, `authOnce`; `src/types/auth.ts`: `AuthUser`, `ApiScope`, `RequestAuth` |
| Agents (MCP API) | Which endpoints accept a token, with which scope: `src/services/apiTokens/tokenRoutes.ts` (anything else is 403 for tokens). Tokens: `src/services/apiTokens/apiTokens.service.ts`, `/api/tokens` (cookie only). `/api/agent/*`: `src/services/agent/` (docs as Markdown, writes live through Hocuspocus with snapshots, the AgentEdit log + Undo, provenance middlewares for learning routes); `Idempotency-Key`: `src/middlwares/idempotency.ts`. Markdown ⇄ doc: `src/services/docs/markdown/docMarkdown.ts`; the doc schema (mirrors `recollect/lib/editor/docSchema.ts` + callout + details): `src/services/docs/docSchema.ts` |
| Users for other modules | `src/services/users/users.service.ts`: `findUserById`, `findUserByEmail`, `findOrCreatePlaceholderUser`, `createPlaceholderUser`, … |
| App vs server | `src/app.ts` builds the app (tests import it); `src/index.ts` checks `DATABASE_URL`, starts the crons (reminders every minute, expired OTPs every 5 min, expired share links hourly), listens, starts Hocuspocus |
| Live collaboration | `src/collaboration/hocuspocus.ts` (auth, load/store) + `docHandler.ts` (rooms `doc_<id>`). `authorize()` returns `'edit'`, `'view'` or `null`; `'view'` sets Hocuspocus `connectionConfig.readOnly`, so doc viewers can watch live but their Yjs updates are dropped (not applied, broadcast or stored). Every connection needs a login: there are no guest connections |
| AI (Claude API) | `src/services/claude/`: the client (`client.ts`: an injectable `AiClient`, never real under `NODE_ENV=test`; tests use `tests/helpers/claude.ts`), the price table and cost math (`pricing.ts`, the only place prices live), the spend meter and monthly cap (`usage.service.ts`, `AiUsage` / `AiSettings`). Recall mode: `src/services/recall/` (prompts, output schemas, start/answer/finish, the nightly Message Batch + poller crons). Routes `/api/recall/*` and `/api/ai/*`: cookie only, `{ success: false, code, message }` errors (`AiHttpError`). The old Groq/Gemini/Cohere chain in `src/services/ai/` is only for the legacy `@ai` task parsing |
| Cut code | `_archive/` (content, dashboards, expenses, email/Gmail, slides, livekit, the BullMQ content worker) and `_archive/drawing/` (the whiteboard: routes, controllers, drawing AI, service, serializer, Hocuspocus handler, tests, and the removed Prisma models; its tables were dropped by the `drop_whiteboard` migration). Excluded from the build and the test runs. |

## 2. Rules that bite

1. **`undefined` in a Prisma `where` means "no filter".** `prisma.doc.findMany({ where: { userId: undefined } })` returns **every user's docs**. (Mongo turned `undefined` into `null`, so it matched nothing.) After `authMiddleware`, get the user with `const user = requireUser(req)` and use `user.id`. Never pass `req.user?._id` into a `where`. Validate route params and query values before they reach a query.
2. **Keep the response shapes.** The frontend reads `_id` everywhere, plus nested user objects (owner, members, assignees, collaborators, sender…). Rename only at the top level of a row (`withMongoId`) and map relations explicitly. **Never write a recursive id → _id transform**: Json columns (TipTap docs, subtasks, references, metadata) contain their own `id` keys.
3. **Foreign keys were renamed.** Mongo `doc.user` (an ObjectId, or a populated object) became `doc.userId` plus the relation `doc.user`. The serializer must put the old key back: `user: row.userId` when unpopulated, or `user: serializeUserSummary(row.user)` when the old code populated it. See §5 for the full list.
4. **Do the Mongoose model's hidden work in the service.** Prisma has no hooks or setters:
   - `trim` / `lowercase`: trim names and titles; lowercase where the old code or schema did.
   - `maxlength`: `User.name` is 50, `Workspace.name` 100, `Space.name` 50. The DB enforces these too (VARCHAR) and answers 400. Validate first to give the old message.
   - pre-save hooks: the bcrypt hash (users service), `Todo.completedAt` when status becomes `'complete'` (todos service), and `reminderEmail = email` (users service).
   - JS defaults: `ShareLink.expiresAt` (`defaultShareLinkExpiry()`, a required column) and `WorkspaceInviteLink.token` (`generateInviteToken()`).
   - `select: false` on the password is now the client's global `omit`. To opt in: `omit: { password: false }`.
5. **IDs are plain strings.** Delete `new mongoose.Types.ObjectId(x)` and `mongoose.Types.ObjectId.isValid()`. Comparisons like `a.toString() === req.user._id` keep working. An id that doesn't exist simply isn't found (no CastError), so keep the handler's own 404 message.
6. **Errors.** Throw `ErrorResponse(status, message)` with the old message. Prisma errors are mapped centrally: P2002 → 400 `Duplicate field value entered: <fields>`, P2025 → 404 `Resource not found`, P2003 → 404 `Related resource not found`, validation → 400. Where the old handler returned its own 404 text after `findByIdAndUpdate`, catch `isRecordNotFound(err)` and throw that text instead (see `updateUserOrNull` in the users service).
7. **Unique constraints exist now on child tables:** `DocCollaborator(docId,userId)`, `DocBannedUser(docId,userId)`, `WorkspaceMember(workspaceId,userId)`, `TodoAssignee(todoId,userId)`, `TodoTag(todoId,tagId)`, `RecentVisit(userId,itemId)`, `AccessRequest(userId,docId)`. Use `upsert` or `createMany({ skipDuplicates: true })` where Mongo used `$addToSet` or pushed blindly.
8. **Cascades are automatic.** Deleting a user, doc, workspace or todo deletes its child rows: collaborators, members, spaces, share links, access requests, assignees, tag links, reminders, invite links, activity. Optional references are SET NULL: `Todo.spaceId`, `ActivityLog.targetTaskId`/`targetUserId`, `Notification.senderId`. Explicit cleanup code from the Mongo version is harmless, but check that the order still works inside a transaction.
9. **Transactions.** Mongo sessions become `prisma.$transaction(async (tx) => { … })`. Pass `tx` into every service call (`db: DbClient = prisma` parameter). Don't send emails or notifications inside the callback: do it after it resolves. A failed query aborts the whole Postgres transaction, so you can't catch a unique violation and retry inside it.
10. **`findByIdAndUpdate` returns the OLD document** unless the old code passed `{ new: true }`. Check which one the handler relied on (the avatar upload relied on the old one).
11. **Never `include` 2+ relations on a write or on a transaction client.** `create/update/upsert({ include: { a, b } })` (Prisma wraps it in an implicit transaction) and any `include`/`select` of 2+ relations on `tx` make Prisma send the relation queries concurrently on ONE pg connection. pg 8 deprecates that ("client is already executing a query") and pg 9 will reject it. Instead: write with `select: { id: true }`, then load the relations after the transaction (`loadTodoOrThrow(id)` after commit) or one query at a time (`loadDocRow` in `docs.service.ts`). Reads on the root `prisma` client outside a transaction are fine (each relation query gets its own pooled connection). The integration tests fail when this happens (`tests/helpers/pgConcurrencyGuard.ts`).

### Mongo → Prisma cheat sheet

| Mongoose | Prisma |
|---|---|
| `find({ $or: [{ user: id }, { 'collaborators.user': id }] })` | `findMany({ where: { OR: [{ userId: id }, { collaborators: { some: { userId: id } } }] } })` |
| `populate('owner', 'name email avatar')` | `include: { owner: { select: userSummarySelect } }`, then `serializeUserSummary(row.owner)` |
| `populate('members.user', 'name email avatar')` | `include: { members: { include: { user: { select: userSummarySelect } }, orderBy: { joinedAt: 'asc' } } }` |
| `$push` / `$addToSet` into an embedded array | `tx.<child>.create` / `upsert` / `createMany({ skipDuplicates: true })` |
| `$pull: { collaborators: { user } }` | `deleteMany({ where: { docId, userId } })` |
| positional `$` update (`'members.$.role'`) | `update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { role } })` |
| `references: { $elemMatch: { type, refId } }` | `references: { array_contains: [{ type, refId }] }` (GIN index) |
| `'metadata.workspaceId': id` | `metadata: { path: ['workspaceId'], equals: id }` |
| `new RegExp(q, 'i')` | `containsInsensitive(q)` (escapes `%` and `_`; Prisma does NOT) |
| `new RegExp('^' + q, 'i')` | `startsWithInsensitive(q)` |
| `insertMany(docs)` | `createMany({ data, skipDuplicates? })` (returns a count, not the rows) |
| `findOneAndUpdate(..., { upsert: true })` | `upsert({ where: <unique>, create, update })` |
| `countDocuments(q)` | `count({ where })` |
| `.lean()` | nothing: Prisma rows are already plain objects |
| `.sort({ updatedAt: -1 }).limit(n)` | `orderBy: { updatedAt: 'desc' }, take: n` |
| array order of an embedded array | `orderBy: { createdAt / addedAt / joinedAt: 'asc' }` on the child table |

## 3. Checklist: port one module

1. **Read the old code completely**: controller(s), router (paths and middleware order), the Mongoose model(s), and every helper they call.
2. **Read the frontend calls**: `recollect/lib/api/*.ts` and the components that use them. Note which fields of the response are actually read, including nested user objects.
3. **Write down each endpoint's contract** before coding: success status and body, every error status and message (typos included), and side effects (emails, notifications, Hocuspocus broadcasts, Cloudinary).
4. **Service** `src/services/<module>/<module>.service.ts`: all Prisma calls, permission helpers (`canEditDoc`, `requireWorkspaceRole`, …) written once, and an optional `db: DbClient = prisma` on every function.
5. **Serializer** `src/db/serializers/<module>.ts`: Prisma row → old JSON. Use `withMongoId`, `serializeUserSummary`, and put the renamed FK keys back. Export it from `src/db/serializers/index.ts`.
6. **Controller**: keep the route, zod schema, status codes and messages. Replace the model calls with service calls, start with `requireUser(req)`, and respond through the serializer.
7. **Transactions** where the old code used sessions or multiple dependent writes.
8. **No Mongoose any more.** The models are deleted; the old ones are in `_archive/` and in git history if you need to check a default or an index.
9. **Tests** (see §4): happy path, auth failure (401 without a cookie), permission failure (403/404 for someone else's resource), validation (400), and every special rule you found in step 3.
10. **Verify**: `npm run typecheck` (0 errors), `npm run test:unit`, `npm run test:int` (use your own `TEST_DB_NAME`).

### Example: service + controller (from the auth port)

```ts
// src/services/users/users.service.ts
export function findUserByEmailWithPassword(email: string, db: DbClient = prisma) {
    return db.user.findUnique({ where: { email }, omit: { password: false } });
}

export async function createUser(input: CreateUserInput, db: DbClient = prisma): Promise<SafeUser> {
    const email = input.email.trim();
    const name = normalizeUserName(input.name);          // trim + maxLength 50, old message
    const password = input.passwordHash ?? (input.password !== undefined ? await hashPassword(input.password) : undefined);
    const data: Prisma.UserCreateInput = { email, name, reminderEmail: input.reminderEmail?.trim() || email };
    if (password !== undefined) data.password = password;   // exactOptionalPropertyTypes: no `x: undefined`
    // …
    return db.user.create({ data });
}
```

```ts
// src/controllers/auth.controller.ts (thin)
export const login = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const result = userLoginSchema.safeParse(req.body);
        if (!result.success) {
            return res.status(400).json({ message: 'Invalid credentails', error: result.error.flatten() });
        }
        const user = await loginWithPassword(result.data);   // throws ErrorResponse(400, 'wrong password') …
        sendTokenResponse(user, 200, res);                     // cookies + { success, data: serializeUser(user) }
    } catch (err) { next(err); }
};
```

```ts
// A transaction (src/services/auth/auth.service.ts, completeEmailSignup)
const user = await prisma.$transaction(async (tx) => {
    const existing = await findUserByEmail(normalizedEmail, tx);
    const result = existing?.isGhost
        ? await claimGhostUser(existing.id, signupData, tx)
        : await createUser({ email: normalizedEmail, name: signupData.name, passwordHash: signupData.passwordHash }, tx);
    await deleteOtp(storedOtp.id, tx);
    return result;
});
```

```ts
// Serializer pattern for a model with an owner and children
export function serializeWorkspace(ws: WorkspaceWithRelations) {
    const { ownerId, owner, members, spaces, ...rest } = ws;
    return {
        ...withMongoId(rest),
        owner: serializeUserSummary(owner),                                   // populated in the old code
        members: members.map((m) => ({ user: serializeUserSummary(m.user), role: m.role, joinedAt: m.joinedAt })),
        spaces: spaces.map((s) => ({ _id: s.id, name: s.name })),
    };
}
```

Placeholder ("ghost") users for invites and assignment: `const { user, created } = await findOrCreatePlaceholderUser(email, tx)`. It lowercases the email, uses the part before `@` as the name, sets a random hashed password, `isGhost: true` and `status: 'pending'`. `created` replaces the old `isNewGhost`.

## 4. Tests

- `tests/unit/**`: pure functions, no database. They must pass with Postgres stopped. The unit project's `DATABASE_URL` points at a closed port on purpose.
- `tests/integration/**`: through the real app with supertest and a real Postgres test database. Files run one after another. **Every file starts with all tables truncated**, and tests within a file share that state, so use unique emails and names.
- Outgoing email is always mocked (`nodemailer`). Read it back with `sentMails()`, `mailsTo(email)` and `lastOtpSentTo(email)`; simulate SMTP failure with `setMailFailure(true)` (`tests/helpers/mail.ts`).
- Auth: `const user = await createTestUser()` and then `.set('Cookie', authCookie(user))`. The cookie is signed by the same `signAuthToken()` as the real login. For a full browser-like flow, use `request.agent(app)` and POST `/api/login`.
- Mock third parties per file with `vi.mock` (see `users.test.ts` for upfly + Cloudinary and `google-auth.test.ts` for Google). Never call real services.
- Two queries at once on one pg connection fail the file (rule 11; `tests/helpers/pgConcurrencyGuard.ts`, installed by `tests/integration/setup.ts`).
- Live collaboration: `collab.test.ts` starts the real Hocuspocus server on a free port (never 1234) and connects real `@hocuspocus/provider` clients (Node's built-in WebSocket) with `signAuthToken(user.id)` as the token.

Template:

```ts
// tests/integration/<module>.test.ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { authCookie, createTestUser } from '../helpers/auth';

describe('GET /api/<thing>', () => {
    it('returns the old shape for the owner', async () => {
        const user = await createTestUser();
        const row = await prisma.doc.create({ data: { userId: user.id, title: 'Hello' } });

        const res = await request(app).get(`/api/docs/${row.id}`).set('Cookie', authCookie(user));

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ _id: row.id, title: 'Hello' });
    });

    it('401 without a cookie', async () => {
        expect((await request(app).get('/api/docs')).status).toBe(401);
    });

    it("404/403 for someone else's resource", async () => {
        const owner = await createTestUser();
        const stranger = await createTestUser();
        const row = await prisma.doc.create({ data: { userId: owner.id, title: 'Private' } });
        const res = await request(app).get(`/api/docs/${row.id}`).set('Cookie', authCookie(stranger));
        expect([403, 404]).toContain(res.status);   // use the exact code the old handler returned
    });
});
```

### Commands

```bash
npm run db:start                                   # local Postgres on 127.0.0.1:5433 (keep it running)
npm run test:unit                                  # no database
npm run test:int                                   # uses TEST_DATABASE_URL (recollect_test)
TEST_DB_NAME=recollect_test_<you> npm run test:int # your own database: created + migrated automatically
npm test                                           # both
npm run typecheck                                  # src (build config) + tests/seed (tsconfig.test.json)
npm run db:migrate                                 # prisma migrate dev on recollect_dev (schema owner only)
npm run db:seed                                    # dev login dev@recollect.local / devpass123 (local only)
```

PowerShell: `$env:TEST_DB_NAME='recollect_test_<you>'; npm run test:int`. The test database name must contain `test`, and it can never be the dev database: the helpers refuse both.

## 5. Schema map (Mongo field → Prisma)

| Mongo | Prisma |
|---|---|
| `User` (password `select:false`, archivedNotes/favoriteNotes/gmail* cut) | `User` (password omitted globally) |
| `OTP` (TTL 180 s) | `Otp` (`purpose` `'password-reset'` is the enum value `password_reset` in TS) |
| `Doc.user`, `collaborators[]`, `bannedUsers[]`, `cloudImages[]` | `Doc.userId`, `DocCollaborator`, `DocBannedUser`, `Doc.cloudImages` (Json) |
| `ShareLink.user/doc` (content/dashboard/slide cut) | `ShareLink.userId/docId`, `type` only `doc`, `expiresAt` required |
| `AccessRequest.user/doc/shareLink` | `AccessRequest.userId/docId/shareLinkId` |
| `Tags` | `Tag` (global, `name` unique) |
| `Todo.user/workspace/spaceId`, `tags[]`, `assignees[]` | `Todo.userId/workspaceId/spaceId`, `TodoTag`, `TodoAssignee` |
| `Todo.subtasks/cloudImages/references/recurrence` | Json columns (same inner shapes; ids inside are strings) |
| `Workspace.owner`, `members[]`, `spaces[]`, `settings` | `Workspace.ownerId`, `WorkspaceMember`, `Space`, `settings` (Json) |
| `WorkspaceInviteLink.workspace/space/createdBy` | `.workspaceId/spaceId/createdById` |
| `ActivityLog.workspace/actor/targetTask/targetUser` | `.workspaceId/actorId/targetTaskId/targetUserId` |
| `Notification.recipient/sender`, `metadata` (Mixed) | `.recipientId/senderId`, `metadata` (Json) |
| `RecentVisit.user` | `RecentVisit.userId` (`itemId` stays a plain string) |
| `Reminder.user/todoId` (note/content/dashboard cut) | `Reminder.userId/todoId`; status gains `processing` |

`Doc.yjsState` (and `DocSnapshot.yjsState` / `agentUpdate`) are bytes since D3 (2026-11-15, migration `20261115130000_doc_state_bytes`): `services/docs/docState.ts` converts where Base64 is still met. The doc JSON does not send the state.

## Making a new migration (2026-11-14)

The migration folders of 14 Nov carry hand-picked names (`20261114180000_…` to `20261114220000_…`) that sort **after** today's UTC time, so `prisma migrate dev` names a new one with an earlier timestamp: it sorts before the tables it needs, and the shadow database fails ("relation … does not exist"). It also applied the migration while doing so. Instead:

1. Change `schema.prisma`, then `npx prisma format`.
2. `mkdir prisma/migrations/<the last name + 1>_<what>` and write the SQL with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script > …/migration.sql`.
3. Read the SQL (only your change in it), then `npm run db:deploy` and `npx prisma generate`.
