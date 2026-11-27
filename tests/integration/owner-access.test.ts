// TRUST_PLAN T3, T4 (11-27): Settings › Your data. The owner-access log: the People page writes one row for each person
// it shows (at most one an hour, never for the owner), every action on an account writes its own, a person reads only
// their own, the export carries them, a year prunes them, deleting the account deletes them. The summary: what an
// account keeps, counted, and who can see it. Both are cookie only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { forgetOwnerForTests } from '../../src/services/claude/allowance';
import { logViews, ownerAccessOf, pruneOwnerAccess } from '../../src/services/owner/ownerAccess.service';
import { authCookie, createTestUser } from '../helpers/auth';
import { createTestToken } from '../helpers/agent';

type User = Awaited<ReturnType<typeof createTestUser>>;
const env = { ...process.env };
const stamp = Date.now();
let owner: User;
let friend: User;
let other: User;

beforeAll(async () => {
    owner = await createTestUser({ email: `owner-${stamp}@trust.test` });
    friend = await createTestUser({ email: `friend-${stamp}@trust.test` });
    other = await createTestUser({ email: `other-${stamp}@trust.test` });
    process.env.OWNER_EMAIL = owner.email;
    forgetOwnerForTests();
});
afterAll(() => {
    if (env.OWNER_EMAIL === undefined) delete process.env.OWNER_EMAIL;
    else process.env.OWNER_EMAIL = env.OWNER_EMAIL;
    forgetOwnerForTests();
});

const get = (u: User, path: string) => request(app).get(path).set('Cookie', authCookie(u));
const as = (u: User) => ({
    post: (path: string, body: object = {}) => request(app).post(path).set('Cookie', authCookie(u)).send(body),
    patch: (path: string, body: object) => request(app).patch(path).set('Cookie', authCookie(u)).send(body),
});

describe('the owner-access log', () => {
    it('the People page writes one row for each person it shows, at most one an hour, never for the owner', async () => {
        expect((await get(owner, '/api/owner/people')).status).toBe(200);
        expect((await get(owner, '/api/owner/people')).status).toBe(200); // again, within the hour
        const mine = (await get(friend, '/api/account/owner-access')).body.data;
        expect(mine.isOwner).toBe(false);
        expect(mine.rows).toHaveLength(1);
        expect(mine.rows[0]).toMatchObject({ kind: 'viewed', details: { shown: expect.arrayContaining(['your name', 'email', 'the AI you used and its cost']) } });
        expect(await prisma.ownerAccess.count({ where: { userId: owner.id } })).toBe(0);
        expect((await get(owner, '/api/account/owner-access')).body.data).toEqual({ isOwner: true, rows: [] });
        // An hour later the page writes again.
        expect(await logViews([friend.id], new Date(Date.now() + 3_600_001))).toBe(1);
        expect(await prisma.ownerAccess.count({ where: { userId: friend.id, kind: 'viewed' } })).toBe(2);
    });

    it('each action on an account is a row in its log; a person reads only their own; the export carries them', async () => {
        expect((await as(owner).post(`/api/owner/people/${friend.id}/top-up`, { amountUsd: 2 })).status).toBe(200);
        expect((await as(owner).patch(`/api/owner/people/${friend.id}`, { dailyCapUsd: 0.5 })).status).toBe(200);
        expect((await as(owner).post(`/api/owner/people/${friend.id}/end-access`)).status).toBe(200);
        expect((await as(owner).post(`/api/owner/people/${friend.id}/restore-access`)).status).toBe(200);
        const rows = (await get(friend, '/api/account/owner-access')).body.data.rows as Array<{ kind: string; details: unknown }>;
        // (the view the first test dated an hour ahead sorts before them)
        expect(rows.filter((r) => r.kind !== 'viewed').map((r) => r.kind)).toEqual(['access_restored', 'access_ended', 'limit_set', 'topped_up']);
        expect(rows.find((r) => r.kind === 'topped_up')?.details).toEqual({ usd: 2 });
        expect(rows.find((r) => r.kind === 'limit_set')?.details).toEqual({ limitUsd: 0.5 });
        // Someone else's log holds none of these.
        const theirs = (await get(other, '/api/account/owner-access')).body.data.rows as Array<{ kind: string }>;
        expect(theirs.every((r) => r.kind === 'viewed')).toBe(true);
        // Download everything carries them.
        const exported = (await get(friend, '/api/account/export')).body.data;
        expect(exported.ownerAccess.map((r: { kind: string }) => r.kind)).toEqual(expect.arrayContaining(['topped_up', 'limit_set', 'access_ended', 'access_restored', 'viewed']));
        // Cookie only.
        const token = (await createTestToken(friend, ['read'])).token;
        expect((await request(app).get('/api/account/owner-access').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    });

    it('a year prunes the rows; deleting the account deletes them', async () => {
        const gone = await createTestUser();
        await logViews([gone.id], new Date(Date.now() - 366 * 24 * 3_600_000));
        await logViews([gone.id]);
        expect(await pruneOwnerAccess()).toBeGreaterThanOrEqual(1);
        expect((await ownerAccessOf(gone.id)).map((r) => r.kind)).toEqual(['viewed']);
        await prisma.user.delete({ where: { id: gone.id } });
        expect(await prisma.ownerAccess.count({ where: { userId: gone.id } })).toBe(0);
    });
});

describe('what Kaaga keeps, and who can see it', () => {
    it('counts what an account keeps (the trash left out), its shares, its agents; cookie only', async () => {
        const u = await createTestUser();
        const shared = await prisma.doc.create({ data: { userId: u.id, title: 'Shared notes', cloudImages: [{ imageId: 'p/a.csv', cloudUrl: 'https://cdn/a.csv', cloudPublicId: 'p/a.csv', resourceType: 'raw' }] } });
        await prisma.doc.create({ data: { userId: u.id, title: 'Published', publishedAt: new Date() } });
        await prisma.doc.create({ data: { userId: u.id, title: 'In the trash', trashedAt: new Date() } });
        await prisma.docCollaborator.create({ data: { docId: shared.id, userId: other.id, role: 'viewer' } });
        const token = (await createTestToken(u, ['read'], 'Claude Code')).token;
        const s = (await get(u, '/api/account/summary')).body.data;
        const count = (kind: string) => s.keeps.find((k: { kind: string }) => k.kind === kind)?.count;
        expect([count('docs'), count('files'), count('tasks')]).toEqual([2, 1, 0]);
        expect(s.shares).toMatchObject({ shared: 1, people: 1, published: 1 });
        expect(s.shares.docs.map((d: { title: string }) => d.title).sort()).toEqual(['Published', 'Shared notes']);
        expect(s.shares.docs.find((d: { title: string }) => d.title === 'Shared notes')).toMatchObject({ people: 1, published: false });
        expect(s.agents.map((a: { name: string }) => a.name)).toEqual(['Claude Code']);
        expect(s.isOwner).toBe(false);
        expect((await get(owner, '/api/account/summary')).body.data.isOwner).toBe(true);
        expect((await request(app).get('/api/account/summary').set('Authorization', `Bearer ${token}`)).status).toBe(403);
        expect((await request(app).get('/api/account/summary')).status).toBe(401);
    });
});
