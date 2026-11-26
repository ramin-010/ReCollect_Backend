// DOC_PAGES_PLAN §3.5: the pure part of the tree (orderTree). The position math and the walks run on the database
// (tests/integration/doc-pages.test.ts).
import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, orderTree } from '../../../src/services/docs/docTree.service';

const node = (id: string, parentId: string | null, position = 0) => ({ id, parentId, position });

describe('orderTree', () => {
    it('depth-first from the root, siblings by position, ties by id', () => {
        const nodes = [node('c', 'r', 2048), node('b2', 'r', 1024), node('b1', 'r', 1024), node('x', 'b1', 1024), node('r', null)];
        expect(orderTree(nodes).map((n) => n.id)).toEqual(['r', 'b1', 'x', 'b2', 'c']);
    });

    it('from a given root: only what is inside it; a node whose parent is missing is left out', () => {
        const nodes = [node('a', 'root', 1), node('b', 'a', 1), node('lost', 'gone', 1)];
        expect(orderTree(nodes, 'root').map((n) => n.id)).toEqual(['a', 'b']);
    });

    it('a loop in the data never runs away: each node once', () => {
        const nodes = [node('a', 'b', 1), node('b', 'a', 1), node('top', null, 0), node('k', 'top', 1)];
        expect(orderTree(nodes).map((n) => n.id)).toEqual(['top', 'k']);
        expect(orderTree(nodes, 'a').map((n) => n.id)).toEqual(['b', 'a']);
    });

    it(`stops at ${MAX_DEPTH} levels`, () => {
        const chain = Array.from({ length: MAX_DEPTH + 10 }, (_, i) => node(`n${i}`, i === 0 ? null : `n${i - 1}`, 1));
        expect(orderTree(chain).length).toBe(MAX_DEPTH + 1);
    });

    it('negative positions (a page put first) sort before the rest', () => {
        const nodes = [node('one', 'p', 1024), node('first', 'p', -1024), node('p', null)];
        expect(orderTree(nodes).map((n) => n.id)).toEqual(['p', 'first', 'one']);
    });
});
