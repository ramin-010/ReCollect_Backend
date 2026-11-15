// The manager's test set (evals/manager.json) stays runnable: about 25 cases with unique ids, every
// tool it names is a real catalogue tool, and the grader reads tools, levels and words as meant.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { grade } from '../../../scripts/eval-manager';

const root = path.join(__dirname, '..', '..', '..');
const set = JSON.parse(fs.readFileSync(path.join(root, 'evals', 'manager.json'), 'utf8')) as {
    cases: Array<{ id: string; request: string; mustUse?: string[][]; mustNotUse?: string[]; textMust?: string[]; textMustNot?: string[] }>;
};
const catalogue = fs.readFileSync(path.join(root, '..', 'mcp', 'src', 'server.ts'), 'utf8');
const toolNames = new Set([...catalogue.slice(catalogue.indexOf('export const TOOL_NAMES'), catalogue.indexOf('] as const;')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));

const tool = (name: string, level: 1 | 2 | 3, extra: Record<string, unknown> = {}) => ({ name, level, input: '{}', result: '', ok: true, ...extra });

describe('the manager test set', () => {
    it('has about 25 cases with unique ids, real tool names and valid patterns', () => {
        expect(set.cases.length).toBeGreaterThanOrEqual(25);
        expect(new Set(set.cases.map((c) => c.id)).size).toBe(set.cases.length);
        expect(toolNames.size).toBeGreaterThan(50);
        for (const c of set.cases) {
            const named = [...(c.mustUse ?? []).flat(), ...(c.mustNotUse ?? [])];
            expect(named.filter((n) => !toolNames.has(n)), c.id).toEqual([]);
            for (const p of [...(c.textMust ?? []), ...(c.textMustNot ?? [])]) expect(() => new RegExp(p, 'i'), c.id).not.toThrow();
        }
    });

    it('grades the tools used, the level reached, the number of changes and the words', () => {
        const c = { id: 'x', request: 'r', mustUse: [['list_due', 'get_today']], mustNotUse: ['empty_trash'], maxLevel: 2 as const, maxChanges: 1, textMustNot: ['deleted'] };
        expect(grade(c, { tools: [tool('get_today', 1)], text: 'Two reviews are due.', stopped: 'done' })).toEqual([]);
        expect(grade(c, { tools: [tool('search_docs', 1)], text: 'ok', stopped: 'done' })).toEqual(['did not use list_due or get_today']);
        expect(grade(c, { tools: [tool('list_due', 1), tool('empty_trash', 3, { suggestionId: 's1' })], text: 'I deleted them', stopped: 'done' })).toEqual([
            'used empty_trash',
            'reached level 3 (at most 2)',
            'answer says /deleted/',
        ]);
        // A level-2 tool that only asked counts as level 3; failed calls don't count; two changes are one too many.
        expect(grade(c, { tools: [tool('list_due', 1), tool('spread_backlog', 2, { suggestionId: 's2' })], text: 'Asked.', stopped: 'done' })).toEqual(['reached level 3 (at most 2)']);
        expect(grade(c, { tools: [tool('list_due', 1), tool('trash_doc', 2), tool('trash_doc', 2), tool('trash_doc', 2, { ok: false })], text: 'ok', stopped: 'rounds' })).toEqual(['stopped: rounds', '2 changes (at most 1)']);
    });
});
