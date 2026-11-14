// GET /api/tagQuery/search and the tags service used by the todo endpoints.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { resolveTagIds } from '../../src/services/tags/tags.service';
import { authCookie, createTestUser } from '../helpers/auth';

describe('GET /api/tagQuery/search', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).get('/api/tagQuery/search').query({ q: 'a' })).status).toBe(401);
    });

    it('returns no tags for an empty or missing q', async () => {
        const user = await createTestUser();
        for (const query of [{}, { q: '   ' }]) {
            const res = await request(app).get('/api/tagQuery/search').query(query).set('Cookie', authCookie(user));
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, data: [], count: 0 });
        }
    });

    it('prefix match, case-insensitive, at most 5, shape { _id, name }', async () => {
        const user = await createTestUser();
        await prisma.tag.createMany({
            data: ['Design', 'design-system', 'designer', 'deploy', 'redesign', 'des1', 'des2', 'des3'].map((name) => ({ name })),
        });

        const res = await request(app).get('/api/tagQuery/search').query({ q: ' DESIGN ' }).set('Cookie', authCookie(user));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.map((t: any) => t.name).sort()).toEqual(['Design', 'design-system', 'designer']);
        expect(res.body.count).toBe(3);
        for (const tag of res.body.data) expect(Object.keys(tag).sort()).toEqual(['_id', 'name']);

        const many = await request(app).get('/api/tagQuery/search').query({ q: 'de' }).set('Cookie', authCookie(user));
        expect(many.body.data).toHaveLength(5);
        expect(many.body.count).toBe(5);
    });

    it('treats regex/LIKE characters literally (the old RegExp was escaped too)', async () => {
        const user = await createTestUser();
        await prisma.tag.createMany({ data: [{ name: 'c++' }, { name: 'c_sharp' }, { name: 'cxsharp' }, { name: '50%off' }] });

        const search = async (q: string) =>
            (await request(app).get('/api/tagQuery/search').query({ q }).set('Cookie', authCookie(user))).body.data.map((t: any) => t.name);

        expect(await search('c+')).toEqual(['c++']);
        expect(await search('c_')).toEqual(['c_sharp']);
        expect(await search('50%')).toEqual(['50%off']);
        expect(await search('.*')).toEqual([]);
    });
});

describe('tags service: resolveTagIds', () => {
    it('creates missing names once (trimmed, unique), returns ids in input order, works in a transaction', async () => {
        await prisma.tag.create({ data: { name: 'kept' } });
        const ids = await prisma.$transaction((tx) => resolveTagIds([' fresh ', 'kept', 'fresh', '', 42], tx));
        const tags = await prisma.tag.findMany({ where: { id: { in: ids } } });
        const byId = new Map(tags.map((t) => [t.id, t.name]));
        expect(ids.map((id) => byId.get(id))).toEqual(['fresh', 'kept', '42']);

        // Running it again (and concurrently) never duplicates a name.
        await Promise.all([resolveTagIds(['fresh', 'brand']), resolveTagIds(['brand', 'fresh'])]);
        expect(await prisma.tag.count({ where: { name: { in: ['fresh', 'brand', 'kept', '42'] } } })).toBe(4);
    });
});
