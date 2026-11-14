// /api/recent-visits (POST track, GET list, DELETE one).
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { authCookie, createTestUser } from '../helpers/auth';

describe('POST /api/recent-visits', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).post('/api/recent-visits').send({ itemId: 'x', itemType: 'doc', route: '/x' })).status).toBe(401);
    });

    it('400 when itemId, itemType or route is missing', async () => {
        const user = await createTestUser();
        for (const body of [{ itemType: 'doc', route: '/d' }, { itemId: 'd1', route: '/d' }, { itemId: 'd1', itemType: 'doc' }]) {
            const res = await request(app).post('/api/recent-visits').set('Cookie', authCookie(user)).send(body);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, message: 'itemId, itemType, and route are required' });
        }
    });

    it('400 for an itemType the database cannot store', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/recent-visits').set('Cookie', authCookie(user)).send({ itemId: 'c1', itemType: 'content', route: '/c' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ success: false, message: 'Invalid itemType' });
    });

    it('upserts on (user, itemId): a revisit updates title, route, type and visitedAt', async () => {
        const user = await createTestUser();
        const first = await request(app)
            .post('/api/recent-visits')
            .set('Cookie', authCookie(user))
            .send({ itemId: 'doc-1', itemType: 'doc', title: 'Draft', route: '/docs/doc-1' });
        expect(first.status).toBe(200);
        expect(first.body).toEqual({ success: true });
        const before = await prisma.recentVisit.findFirstOrThrow({ where: { userId: user.id, itemId: 'doc-1' } });

        await new Promise((r) => setTimeout(r, 5));
        await request(app).post('/api/recent-visits').set('Cookie', authCookie(user)).send({ itemId: 'doc-1', itemType: 'doc', route: '/docs/doc-1?v=2' });

        const rows = await prisma.recentVisit.findMany({ where: { userId: user.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: before.id, title: 'Untitled', route: '/docs/doc-1?v=2' });
        expect(rows[0]!.visitedAt.getTime()).toBeGreaterThan(before.visitedAt.getTime());
    });

    it('keeps only the newest 20 visits per user', async () => {
        const user = await createTestUser();
        const other = await createTestUser();
        await prisma.recentVisit.create({ data: { userId: other.id, itemId: 'theirs', itemType: 'doc', route: '/t' } });
        await prisma.recentVisit.createMany({
            data: Array.from({ length: 20 }, (_, i) => ({
                userId: user.id,
                itemId: `old-${i}`,
                itemType: 'doc' as const,
                route: `/d/${i}`,
                visitedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
            })),
        });

        const res = await request(app).post('/api/recent-visits').set('Cookie', authCookie(user)).send({ itemId: 'new', itemType: 'workspace', route: '/w' });
        expect(res.status).toBe(200);

        const rows = await prisma.recentVisit.findMany({ where: { userId: user.id } });
        expect(rows).toHaveLength(20);
        expect(rows.map((r) => r.itemId)).not.toContain('old-0'); // the oldest one went
        expect(rows.map((r) => r.itemId)).toContain('new');
        expect(await prisma.recentVisit.count({ where: { userId: other.id } })).toBe(1);
    });
});

describe('GET /api/recent-visits', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).get('/api/recent-visits')).status).toBe(401);
    });

    it('my visits, newest first, in the old shape', async () => {
        const user = await createTestUser();
        const other = await createTestUser();
        await prisma.recentVisit.createMany({
            data: [
                { userId: user.id, itemId: 'a', itemType: 'doc', title: 'A', route: '/a', visitedAt: new Date('2026-10-01T00:00:00Z') },
                { userId: user.id, itemId: 'b', itemType: 'slide', title: 'B', route: '/b', visitedAt: new Date('2026-10-03T00:00:00Z') },
                { userId: other.id, itemId: 'c', itemType: 'doc', title: 'C', route: '/c' },
            ],
        });

        const res = await request(app).get('/api/recent-visits').set('Cookie', authCookie(user));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.map((v: any) => v.itemId)).toEqual(['b', 'a']);
        expect(res.body.data[0]).toEqual({
            _id: expect.any(String),
            user: user.id,
            itemId: 'b',
            itemType: 'slide',
            title: 'B',
            route: '/b',
            visitedAt: '2026-10-03T00:00:00.000Z',
        });
    });
});

describe('DELETE /api/recent-visits/:itemId', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).delete('/api/recent-visits/x')).status).toBe(401);
    });

    it("removes only my visit of that item, and is fine when there is none", async () => {
        const user = await createTestUser();
        const other = await createTestUser();
        await prisma.recentVisit.createMany({
            data: [
                { userId: user.id, itemId: 'shared-item', itemType: 'doc', route: '/s' },
                { userId: other.id, itemId: 'shared-item', itemType: 'doc', route: '/s' },
            ],
        });

        const res = await request(app).delete('/api/recent-visits/shared-item').set('Cookie', authCookie(user));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(await prisma.recentVisit.count({ where: { itemId: 'shared-item' } })).toBe(1);
        expect(await prisma.recentVisit.count({ where: { userId: other.id, itemId: 'shared-item' } })).toBe(1);

        const none = await request(app).delete('/api/recent-visits/never-visited').set('Cookie', authCookie(user));
        expect(none.status).toBe(200);
    });
});
