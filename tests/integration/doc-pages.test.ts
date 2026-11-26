// DOC_PAGES_PLAN §3.5 (stage 1): docs inside docs. A page made inside a doc shows in its parent's pages, in order;
// a deep page has its trail; only the owner adds pages inside a doc; a page made inside a shared doc starts shared
// with the same people.
import { describe, expect, it } from 'vitest';
import { api, createLearner, createSubjectRow } from '../helpers/learning';
import { orderTree } from '../../src/services/docs/docTree.service';
import { trashedDocs } from '../../src/services/docs/trash.service';
import { prisma } from '../../src/db/prisma';
import { asAgent, createTestToken } from '../helpers/agent';

const make = async (user: { id: string }, title: string, parentId?: string) => {
    const res = await api(user).post('/api/docs', { title, ...(parentId ? { parentId } : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data as { _id: string; parentId: string | null; position: number };
};

describe('pages inside docs (DOC_PAGES_PLAN stage 1)', () => {
    it('A > B > C: C has the trail A, B; A lists B with its one page; the list carries parentId', async () => {
        const user = await createLearner();
        const a = await make(user, 'System Design');
        const b = await make(user, 'Caching', a._id);
        const c = await make(user, 'Eviction', b._id);
        expect(b.parentId).toBe(a._id);
        const gotC = await api(user).get(`/api/docs/${c._id}`);
        expect(gotC.body.data.trail).toEqual([
            { _id: a._id, title: 'System Design' },
            { _id: b._id, title: 'Caching' },
        ]);
        const gotA = await api(user).get(`/api/docs/${a._id}`);
        expect(gotA.body.data.trail).toEqual([]);
        expect(gotA.body.data.pages).toEqual([{ _id: b._id, title: 'Caching', position: 1024, pages: 1 }]);
        const list = await api(user).get('/api/docs');
        const row = (list.body.data as Array<{ _id: string; parentId: string | null }>).find((d) => d._id === c._id);
        expect(row?.parentId).toBe(b._id);
    });

    it('pages made in turn keep that order; only the owner adds a page inside a doc', async () => {
        const user = await createLearner();
        const other = await createLearner();
        const a = await make(user, 'Course');
        const p1 = await make(user, 'One', a._id);
        const p2 = await make(user, 'Two', a._id);
        const p3 = await make(user, 'Three', a._id);
        expect([p1.position, p2.position, p3.position]).toEqual([1024, 2048, 3072]);
        const pages = (await api(user).get(`/api/docs/${a._id}`)).body.data.pages as Array<{ title: string }>;
        expect(pages.map((p) => p.title)).toEqual(['One', 'Two', 'Three']);
        expect((await api(other).post('/api/docs', { title: 'X', parentId: a._id })).status).toBe(403);
    });

    it('an agent makes a page inside a doc; reading it says its path, reading the parent its pages', async () => {
        const user = await createLearner();
        const agent = asAgent((await createTestToken(user)).token, 'Claude');
        const a = await make(user, 'Kafka');
        const made = await agent.post('/api/agent/docs', { title: 'Partitions', markdown: 'How a topic splits.', parentId: a._id });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const page = await agent.get(`/api/agent/docs/${made.body.data.id}`);
        expect(page.body.data.path).toEqual([{ id: a._id, title: 'Kafka' }]);
        const parent = await agent.get(`/api/agent/docs/${a._id}`);
        expect(parent.body.data.pages).toEqual([{ id: made.body.data.id, title: 'Partitions', pages: 0 }]);
    });

    it('orderTree: depth-first, siblings by position', () => {
        const nodes = [
            { id: 'c', parentId: 'a', position: 2048 },
            { id: 'b', parentId: 'a', position: 1024 },
            { id: 'd', parentId: 'b', position: 1024 },
            { id: 'a', parentId: null, position: 0 },
        ];
        expect(orderTree(nodes).map((n) => n.id)).toEqual(['a', 'b', 'd', 'c']);
    });
});

// ─── Stage 2: the tree's rules (§3.5, 1-9) ─────────────────────────────

type Row = { _id: string; title: string; parentId: string | null; trashedAt: string | null; trashedWithId: string | null };
const titlesIn = async (user: { id: string }, docId: string) => ((await api(user).get(`/api/docs/${docId}`)).body.data.pages as Array<{ title: string }>).map((p) => p.title);
const rowOf = async (user: { id: string }, docId: string) => ((await api(user).get('/api/docs')).body.data as Row[]).find((d) => d._id === docId);
const file = (user: { id: string }, docId: string, subjectId: string) => api(user).post('/api/topics', { docId, subjectId, startRevisions: false });

describe("the tree's rules (DOC_PAGES_PLAN stage 2)", () => {
    it('the tree route answers the whole tree from any of its docs, root first', async () => {
        const user = await createLearner();
        const a = await make(user, 'A');
        const b = await make(user, 'B', a._id);
        const c = await make(user, 'C', b._id);
        for (const id of [a._id, b._id, c._id]) {
            const tree = await api(user).get(`/api/docs/${id}/tree`);
            expect(tree.status).toBe(200);
            expect(tree.body.data.rootId).toBe(a._id);
            expect((tree.body.data.nodes as Array<{ title: string }>).map((n) => n.title)).toEqual(['A', 'B', 'C']);
        }
    });

    it('order: "start" puts a page first; 30 places between the same two neighbours keep their order (renumbered)', async () => {
        const user = await createLearner();
        const parent = await make(user, 'Course');
        await make(user, 'One', parent._id);
        await make(user, 'Two', parent._id);
        const three = await make(user, 'Three', parent._id);
        expect((await api(user).patch(`/api/docs/${three._id}`, { after: 'start' })).status).toBe(200);
        expect(await titlesIn(user, parent._id)).toEqual(['Three', 'One', 'Two']);

        const box = await make(user, 'Box');
        const x = await make(user, 'X', box._id);
        await make(user, 'Y', box._id);
        for (let i = 1; i <= 30; i++) {
            const p = await make(user, `n${i}`, box._id);
            const moved = await api(user).patch(`/api/docs/${p._id}`, { after: x._id });
            expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        }
        const expected = ['X', ...Array.from({ length: 30 }, (_, i) => `n${30 - i}`), 'Y'];
        expect(await titlesIn(user, box._id)).toEqual(expected);
    });

    it('move: out to the top level; not inside itself; only the owner; not into the trash', async () => {
        const user = await createLearner();
        const other = await createLearner();
        const a = await make(user, 'A');
        const b = await make(user, 'B', a._id);
        const c = await make(user, 'C', b._id);
        const loop = await api(user).patch(`/api/docs/${a._id}`, { parentId: c._id });
        expect(loop.status).toBe(409);
        expect(loop.body.message).toContain("can't go inside itself");
        await prisma.docCollaborator.create({ data: { docId: b._id, userId: other.id, role: 'editor' } });
        expect((await api(other).patch(`/api/docs/${b._id}`, { parentId: null })).status).toBe(403);
        const bin = await make(user, 'Bin');
        await api(user).post(`/api/docs/${bin._id}/trash`);
        expect((await api(user).patch(`/api/docs/${b._id}`, { parentId: bin._id })).status).toBe(409);
        const top = await api(user).patch(`/api/docs/${c._id}`, { parentId: null });
        expect(top.status).toBe(200);
        expect((await api(user).get(`/api/docs/${c._id}`)).body.data.trail).toEqual([]);
        expect(await titlesIn(user, b._id)).toEqual([]);
        // A move keeps its place in "recent": updatedAt stays.
        const before = await prisma.doc.findUniqueOrThrow({ where: { id: b._id }, select: { updatedAt: true } });
        await api(user).patch(`/api/docs/${b._id}`, { parentId: null });
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: b._id }, select: { updatedAt: true } })).updatedAt).toEqual(before.updatedAt);
    });

    it('trash takes the pages inside along; restore brings back the same set; a page restored alone comes back at the top', async () => {
        const user = await createLearner();
        const a = await make(user, 'Alpha tree');
        const b = await make(user, 'Beta page', a._id);
        const c = await make(user, 'Gamma page', b._id);
        const trashed = await api(user).post(`/api/docs/${a._id}/trash`);
        expect(trashed.body.data).toMatchObject({ pages: 2 });
        for (const id of [a._id, b._id, c._id]) expect((await rowOf(user, id))?.trashedAt).not.toBeNull();
        expect((await rowOf(user, c._id))?.trashedWithId).toBe(a._id);
        expect((await api(user).get('/api/docs/search?q=Gamma')).body.data).toEqual([]);
        expect((await trashedDocs(user.id)).map((d) => ({ id: d.id, pages: d.pages }))).toEqual([{ id: a._id, pages: 2 }]);

        const back = await api(user).post(`/api/docs/${a._id}/restore`);
        expect(back.body.data).toMatchObject({ pages: 2, detached: false, trashedAt: null });
        for (const id of [a._id, b._id, c._id]) expect((await rowOf(user, id))?.trashedAt).toBeNull();
        expect((await rowOf(user, c._id))?.parentId).toBe(b._id);

        // B on its own, then A; restoring A leaves B (and C, which went with B) in the trash.
        await api(user).post(`/api/docs/${b._id}/trash`);
        await api(user).post(`/api/docs/${a._id}/trash`);
        await api(user).post(`/api/docs/${a._id}/restore`);
        expect((await rowOf(user, a._id))?.trashedAt).toBeNull();
        expect((await rowOf(user, b._id))?.trashedAt).not.toBeNull();
        expect((await rowOf(user, c._id))?.trashedAt).not.toBeNull();

        // C restored alone while B is in the trash: back at the top level.
        const alone = await api(user).post(`/api/docs/${c._id}/restore`);
        expect(alone.body.data).toMatchObject({ detached: true, trashedAt: null });
        expect((await rowOf(user, c._id))?.parentId).toBeNull();
    });

    it('deleting a doc for good from the trash takes its set; a doc trashed on its own stays', async () => {
        const user = await createLearner();
        const a = await make(user, 'A');
        const b = await make(user, 'B', a._id);
        const c = await make(user, 'C', b._id);
        const d = await make(user, 'D');
        await api(user).post(`/api/docs/${d._id}/trash`);
        await api(user).post(`/api/docs/${a._id}/trash`);
        expect((await api(user).delete(`/api/docs/${a._id}`)).status).toBe(200);
        expect(await prisma.doc.count({ where: { id: { in: [a._id, b._id, c._id] } } })).toBe(0);
        expect(await prisma.doc.count({ where: { id: d._id } })).toBe(1);
    });

    it('lessons: one per branch; a page inside a lesson says its lesson and has no topic', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id, 'System design');
        const a = await make(user, 'Caching');
        const b = await make(user, 'Eviction', a._id);
        expect((await file(user, a._id, s.id)).status).toBe(201);
        const inside = await file(user, b._id, s.id);
        expect(inside.status).toBe(409);
        expect(inside.body.message).toContain('inside the lesson "Caching"');
        const hub = await make(user, 'Hub');
        const l1 = await make(user, 'L1', hub._id);
        const l2 = await make(user, 'L2', hub._id);
        expect((await file(user, l1._id, s.id)).status).toBe(201);
        expect((await file(user, l2._id, s.id)).status).toBe(201);
        const holds = await file(user, hub._id, s.id);
        expect(holds.status).toBe(409);
        expect(holds.body.message).toContain('lessons already ("L1", "L2")');
        const nest = await api(user).patch(`/api/docs/${l1._id}`, { parentId: l2._id });
        expect(nest.status).toBe(409);
        expect(nest.body.message).toContain('"L1" is a lesson with its own reviews');
        const byDoc = await api(user).get(`/api/topics/by-doc/${b._id}`);
        expect(byDoc.body.data.topic).toBeNull();
        expect(byDoc.body.data.lesson).toMatchObject({ docId: a._id, title: 'Caching', subjectName: 'System design' });
    });

    it('notes keep their lesson and remember their page; a page deleted or moved out forgets them, the lesson keeps them', async () => {
        const user = await createLearner();
        const agent = asAgent((await createTestToken(user)).token, 'Claude');
        const s = await createSubjectRow(user.id, 'System design');
        const a = await make(user, 'Caching');
        const b = await make(user, 'Eviction', a._id);
        const topicId = (await file(user, a._id, s.id)).body.data.topic._id as string;
        const onB = await agent.post('/api/agent/notes', { docId: b._id, title: 'LRU', markdown: 'Least recently used goes first.' });
        expect(onB.status, JSON.stringify(onB.body)).toBe(201);
        expect(onB.body.data.page).toEqual({ docId: b._id, title: 'Eviction' });
        const note = await prisma.capture.findUniqueOrThrow({ where: { id: onB.body.data.id } });
        expect(note).toMatchObject({ topicId, docId: b._id });
        await agent.post('/api/agent/notes', { docId: a._id, title: 'TTL', markdown: 'Expire after a time.' });
        const byA = await agent.get(`/api/agent/notes?docId=${a._id}`);
        expect((byA.body.data.notes as Array<{ title: string; page: unknown }>).map((n) => [n.title, n.page])).toEqual([
            ['TTL', null],
            ['LRU', { docId: b._id, title: 'Eviction' }],
        ]);
        const byB = await agent.get(`/api/agent/notes?docId=${b._id}`);
        expect((byB.body.data.notes as Array<{ title: string }>).map((n) => n.title)).toEqual(['LRU', 'TTL']);

        // The app's notes: the page goes with the lesson's topic, and the list names it.
        const made = await api(user).post('/api/captures', { topicId, docId: b._id, content: 'LFU counts uses' });
        expect(made.body.data.capture.docId).toBe(b._id);
        const listed = await api(user).get(`/api/captures?topicId=${topicId}`);
        expect((listed.body.data as Array<{ _id: string; page: unknown }>).find((c) => c._id === made.body.data.capture._id)?.page).toEqual({ id: b._id, title: 'Eviction' });

        // Moved out of the lesson: the notes forget the page, keep the lesson.
        const c = await make(user, 'Write policies', a._id);
        const onC = await agent.post('/api/agent/notes', { docId: c._id, title: 'Write-back', markdown: 'Later.' });
        await api(user).patch(`/api/docs/${c._id}`, { parentId: null });
        expect(await prisma.capture.findUniqueOrThrow({ where: { id: onC.body.data.id } })).toMatchObject({ topicId, docId: null });

        // Deleted for good: the note stays on the lesson.
        await api(user).post(`/api/docs/${b._id}/trash`);
        await api(user).delete(`/api/docs/${b._id}`);
        expect(await prisma.capture.findUniqueOrThrow({ where: { id: note.id } })).toMatchObject({ topicId, docId: null });
    });

    it('deleting a subject takes the pages inside its lessons to the trash, and undo brings them all back', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id, 'Networks');
        const a = await make(user, 'TCP');
        const b = await make(user, 'Handshake', a._id);
        const c = await make(user, 'Flags', b._id);
        await file(user, a._id, s.id);
        const deleted = await api(user).delete(`/api/subjects/${s.id}`);
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        const rows = await prisma.doc.findMany({ where: { id: { in: [a._id, b._id, c._id] } }, select: { id: true, trashedAt: true, trashedWithId: true } });
        expect(rows.every((r) => r.trashedAt)).toBe(true);
        expect(rows.find((r) => r.id === c._id)?.trashedWithId).toBe(a._id);
        const deletion = await prisma.subjectDeletion.findFirstOrThrow({ where: { userId: user.id } });
        expect((await api(user).post(`/api/subject-deletions/${deletion.id}/undo`)).status).toBe(200);
        const back = await prisma.doc.findMany({ where: { id: { in: [a._id, b._id, c._id] } }, select: { trashedAt: true, trashedWithId: true, parentId: true, id: true } });
        expect(back.every((r) => !r.trashedAt && !r.trashedWithId)).toBe(true);
        expect(back.find((r) => r.id === c._id)?.parentId).toBe(b._id);
    });

    it('a page made inside a shared doc starts shared with the same people; a page made before is not', async () => {
        const user = await createLearner();
        const friend = await createLearner();
        const a = await make(user, 'Shared course');
        const before = await make(user, 'Made before', a._id);
        await prisma.docCollaborator.create({ data: { docId: a._id, userId: friend.id, role: 'editor' } });
        const after = await make(user, 'Made after', a._id);
        const seen = await api(friend).get(`/api/docs/${after._id}`);
        expect(seen.status).toBe(200);
        expect(seen.body.role).toBe('editor');
        expect((await api(friend).get(`/api/docs/${before._id}`)).status).toBe(404);
    });
});
