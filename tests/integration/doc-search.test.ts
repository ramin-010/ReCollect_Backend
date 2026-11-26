// Doc search on Postgres full-text (src/services/docs/docSearch.service.ts, migration
// 20261114250000_doc_search): the words written by search itself and kept current by the trigger,
// word forms and ranking, who sees what, and the library's endpoint GET /api/docs/search.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { docJsonToYjsState } from '../../src/services/docs/docContent';
import { storeDocYjsState } from '../../src/services/docs/docs.service';
import { refreshSearchText, searchDocs } from '../../src/services/docs/docSearch.service';
import { markdownToDocJson } from '../../src/services/docs/markdown/docMarkdown';
import { authCookie, createTestUser } from '../helpers/auth';

const stateOf = (md: string, title?: string) => docJsonToYjsState(markdownToDocJson(md), title ? { title, coverImage: null } : undefined);

/** A doc stored as an editor would store it (no words yet: searchText NULL). */
async function docWith(userId: string, title: string, md: string) {
    return prisma.doc.create({ data: { userId, title, yjsState: stateOf(md) } });
}

async function searchFields(id: string) {
    const [row] = await prisma.$queryRaw<Array<{ searchText: string | null; hasVector: boolean; updatedAt: Date }>>`
        SELECT "searchText", "searchVector" IS NOT NULL AS "hasVector", "updatedAt" FROM "Doc" WHERE "id" = ${id}`;
    return row!;
}

const ids = (hits: ReadonlyArray<{ id: string }>) => hits.map((h) => h.id);

describe('the words (Doc.searchText)', () => {
    it('are written by the next search (updatedAt untouched), dropped by a content change, written again', async () => {
        const user = await createTestUser();
        const doc = await docWith(user.id, 'Caching', 'A cache keeps hot rows in memory.');
        const before = await searchFields(doc.id);
        expect(before.searchText).toBeNull();
        expect(before.hasVector).toBe(true); // the title alone

        expect(ids(await searchDocs(user.id, { query: 'memory' }))).toEqual([doc.id]);
        const written = await searchFields(doc.id);
        expect(written.searchText).toBe('A cache keeps hot rows in memory.');
        expect(written.updatedAt.getTime()).toBe(before.updatedAt.getTime());

        // The live editor's save (Hocuspocus onStoreDocument) brings new content: the old words go.
        await storeDocYjsState(doc.id, { yjsState: stateOf('Eviction: LRU drops the coldest key.'), previewState: null });
        expect((await searchFields(doc.id)).searchText).toBeNull();
        expect(await searchDocs(user.id, { query: 'memory' })).toEqual([]);
        expect(ids(await searchDocs(user.id, { query: 'coldest' }))).toEqual([doc.id]);

        // A title change alone is found at once (the trigger weighs the title in).
        await prisma.doc.update({ where: { id: doc.id }, data: { title: 'Eviction policies' } });
        expect(ids(await searchDocs(user.id, { query: 'policies' }))).toEqual([doc.id]);
        expect((await searchFields(doc.id)).searchText).toBe('Eviction: LRU drops the coldest key.');
    });

    it("the server's pass writes every doc's words, across users", async () => {
        const [a, b] = await Promise.all([createTestUser(), createTestUser()]);
        const docs = await Promise.all([docWith(a.id, 'One', 'first words'), docWith(b.id, 'Two', 'second words'), prisma.doc.create({ data: { userId: b.id, title: 'Empty' } })]);
        expect(await refreshSearchText({}, Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(3);
        expect(await Promise.all(docs.map((d) => searchFields(d.id).then((f) => f.searchText)))).toEqual(['first words', 'second words', '']);
    });
});

describe('matching and order', () => {
    it('every word must match, as a stem or a word start; best match first', async () => {
        const user = await createTestUser();
        const limiter = await docWith(user.id, 'Rate limiter design', 'A token bucket refills at a fixed rate.');
        const caching = await docWith(user.id, 'Caching', 'Caches keep hot rows close. Redis is one.');
        const notes = await docWith(user.id, 'Week notes', 'Read about the rate limiter of the gateway.');
        const cpp = await docWith(user.id, 'C++ templates', 'Generic code.');

        // Stems: "cache" finds "Caches" and "Caching"; a word start: "lim" finds "limiter".
        expect(ids(await searchDocs(user.id, { query: 'cache' }))).toEqual([caching.id]);
        expect(ids(await searchDocs(user.id, { query: 'rate lim' }))).toEqual([limiter.id, notes.id]);
        // Every word: "gateway" only in the notes.
        expect(ids(await searchDocs(user.id, { query: 'limiter gateway' }))).toEqual([notes.id]);
        // The whole query inside a title, for what words drop.
        expect(ids(await searchDocs(user.id, { query: 'c++' }))[0]).toBe(cpp.id);
        expect(await searchDocs(user.id, { query: 'kubernetes' })).toEqual([]);

        // The snippet marks the matched words.
        const [hit] = await searchDocs(user.id, { query: 'gateway' });
        expect(hit!.snippet).toBe('Read about the rate limiter of the gateway');
        expect(hit!.marks.map(([s, e]) => hit!.snippet.slice(s, e))).toEqual(['gateway']);
    });

    it('own and shared docs only: not a stranger’s, not one you were removed from, not archived', async () => {
        const [me, friend, stranger] = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
        const mine = await docWith(me.id, 'Kafka partitions', 'ordering per key');
        const shared = await docWith(friend.id, 'Kafka consumers', 'groups');
        await prisma.docCollaborator.create({ data: { docId: shared.id, userId: me.id, role: 'viewer' } });
        const removed = await docWith(friend.id, 'Kafka retention', 'days');
        await prisma.docCollaborator.create({ data: { docId: removed.id, userId: me.id, role: 'editor' } });
        await prisma.docCollaborator.delete({ where: { docId_userId: { docId: removed.id, userId: me.id } } });
        await docWith(stranger.id, 'Kafka internals', 'log segments');
        const archived = await docWith(me.id, 'Kafka old', 'x');
        await prisma.doc.update({ where: { id: archived.id }, data: { isArchived: true } });

        expect(ids(await searchDocs(me.id, { query: 'kafka' })).sort()).toEqual([mine.id, shared.id].sort());
        expect(ids(await searchDocs(me.id, {})).sort()).toEqual([mine.id, shared.id].sort());
    });
});

describe('GET /api/docs/search', () => {
    it('answers the library: _id, title, snippet with marks; 401 logged out; 400 for a bad limit', async () => {
        const user = await createTestUser();
        const doc = await docWith(user.id, 'Consistent hashing', 'Keys move to the next node on the ring.');
        const res = await request(app).get('/api/docs/search').query({ q: 'ring nodes' }).set('Cookie', authCookie(user));
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([
            { _id: doc.id, title: 'Consistent hashing', updatedAt: expect.any(String), snippet: 'Keys move to the next node on the ring', marks: [[22, 26], [34, 38]], path: [] },
        ]);
        expect((await request(app).get('/api/docs/search').query({ q: 'ring' })).status).toBe(401);
        expect((await request(app).get('/api/docs/search').query({ q: 'ring', limit: 0 }).set('Cookie', authCookie(user))).status).toBe(400);
    });
});
