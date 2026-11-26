// DOC_PAGES_PLAN §3.5 (stage 1): docs inside docs. A page made inside a doc shows in its parent's pages, in order;
// a deep page has its trail; only the owner adds pages inside a doc; a page made inside a shared doc starts shared
// with the same people.
import { describe, expect, it } from 'vitest';
import { api, createLearner } from '../helpers/learning';
import { orderTree } from '../../src/services/docs/docTree.service';

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
