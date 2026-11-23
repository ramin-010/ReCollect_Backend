// ECOSYSTEM_V2_PLAN stage 14, "Docs that keep what helped": a chat adds a note inside one section of a doc on the
// person's yes (append_to_doc with heading, after). Code places it (after the quoted paragraph, else at the section's
// end), adds a quiet last line (the day and the app), refuses a note the section already holds (two chats at once write
// it once), logs it with Undo; no model call, so it works with no AI. STUDY_FLOW_PLAN §4.1 (11-23): no cap on how many
// a day, the length is a size guard only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { JSONContent } from '@tiptap/core';

vi.mock('upfly', async () => (await import('../helpers/uploads')).createUpflyMock());
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));

import { prisma } from '../../src/db/prisma';
import { stateBytes } from '../../src/services/docs/docState';
import { docJsonToYjsState, yjsStateToDocJson } from '../../src/services/docs/docContent';
import { markdownToDocJson, nodePlainText } from '../../src/services/docs/markdown/docMarkdown';
import { BLOCKS_FRAGMENT, blocksToYElements, readBlocks, type InlineNode, type NewBlock } from '../../src/services/docs/blocks/serverEditor';
import { appendNoteForAgent } from '../../src/services/agent/agentDocs.service';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

const t = (text: string): InlineNode => ({ type: 'text', text, styles: {} });

async function blocksDoc(userId: string, title: string, blocks: NewBlock[]) {
    const ydoc = new Y.Doc();
    const group = new Y.XmlElement('blockGroup');
    ydoc.getXmlFragment(BLOCKS_FRAGMENT).insert(0, [group]);
    group.insert(0, blocksToYElements(blocks));
    ydoc.getMap('metadata').set('title', title);
    const yjsState = stateBytes(Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    return prisma.doc.create({ data: { userId, title, yjsState } });
}

/** The stored doc's top-level blocks as "type:text" lines. */
async function shape(docId: string): Promise<string[]> {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, row.yjsState!);
    const text = (b: ReturnType<typeof readBlocks>[number]) => (Array.isArray(b.content) ? (b.content as InlineNode[]).map((n) => (n.type === 'text' ? n.text : n.content.map((c) => c.text).join(''))).join('') : '');
    const out = readBlocks(ydoc).map((b) => `${b.type}:${text(b)}`);
    ydoc.destroy();
    return out;
}

const twoPointers = (): NewBlock[] => [
    { id: 'h1', type: 'heading', props: { level: 2 }, content: [t('Two pointers')] },
    { id: 'p1', type: 'paragraph', content: [t('Works on a sorted array.')] },
    { id: 'h2', type: 'heading', props: { level: 3 }, content: [t('Why it works')] },
    { id: 'p2', type: 'paragraph', content: [t('Start one pointer at each end and move them toward each other.')] },
    { id: 'p3', type: 'paragraph', content: [t('If the sum is too small, move the left pointer right.')] },
    { id: 'e1', type: 'paragraph', content: [] },
    { id: 'h3', type: 'heading', props: { level: 2 }, content: [t('Complexity')] },
    { id: 'p4', type: 'paragraph', content: [t('O(n) time, O(1) space.')] },
    { id: 'z1', type: 'paragraph', content: [] },
];

const CONVEYOR =
    '**Conveyor belt picture:** think of the sorted array as a conveyor belt with a worker at each end. Too light together: the left worker takes a heavier box. Too heavy: the right worker takes a lighter one.';
const WHY_SAFE = "**Why it never misses a pair:** when the sum is too small, the left element can't pair with anything still in range, so dropping it loses no answer.";

/** Friday 20 Nov 2026, 11:30 in Kolkata. */
const AT = (min = 0) => new Date(Date.UTC(2026, 10, 20, 6, min));

describe('a note inside a section (stage 14)', () => {
    it('lands at the section’s end (before its blank line) or right after the quoted paragraph, with its last line; Undo takes exactly it back', async () => {
        const user = await createTestUser();
        const doc = await blocksDoc(user.id, 'Two Pointers', twoPointers());
        const chat = asAgent((await createTestToken(user, ['read', 'docs:write'], 'ChatGPT')).token, 'ChatGPT');
        const end = await chat.post(`/api/agent/docs/${doc.id}/append`, { heading: 'why it works', markdown: CONVEYOR });
        expect(end.status).toBe(200);
        expect(end.body.data).toMatchObject({ id: doc.id, heading: 'Why it works', placed: 'section_end', appended: 2, editId: expect.any(String) });
        const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(new Date());
        expect(await shape(doc.id)).toEqual([
            'heading:Two pointers',
            'paragraph:Works on a sorted array.',
            'heading:Why it works',
            'paragraph:Start one pointer at each end and move them toward each other.',
            'paragraph:If the sum is too small, move the left pointer right.',
            expect.stringMatching(/^paragraph:Conveyor belt picture: think of the sorted array/),
            expect.stringMatching(new RegExp(`^paragraph:Added ${day.replace('.', '')} from ChatGPT$`)),
            'paragraph:',
            'heading:Complexity',
            'paragraph:O(n) time, O(1) space.',
            'paragraph:',
        ]);
        // After the quoted paragraph (case and punctuation aside).
        const after = await chat.post(`/api/agent/docs/${doc.id}/append`, { heading: 'Why it works', after: 'start ONE pointer at each end', markdown: WHY_SAFE });
        expect(after.body.data).toMatchObject({ placed: 'after', appended: 2 });
        const s = await shape(doc.id);
        expect(s[4]).toMatch(/^paragraph:Why it never misses a pair/);
        expect(s[5]).toMatch(/^paragraph:Added .+ from ChatGPT$/);
        expect(s[6]).toBe('paragraph:If the sum is too small, move the left pointer right.');
        // Logged with Undo on Home; Undo removes exactly that note.
        const edit = await prisma.agentEdit.findUniqueOrThrow({ where: { id: after.body.data.editId } });
        expect([edit.kind, edit.summary, edit.agentName]).toEqual(['doc_append', 'Added a note under "Why it works" in "Two Pointers"', 'ChatGPT']);
        expect((await api(user).post(`/api/agent/edits/${after.body.data.editId}/undo`)).status).toBe(200);
        const undone = await shape(doc.id);
        expect(undone.some((l) => l.includes('never misses a pair'))).toBe(false);
        expect(undone.some((l) => l.includes('Conveyor belt picture'))).toBe(true);
        // An unknown heading lists the doc's headings; after without heading is refused.
        const missing = await chat.post(`/api/agent/docs/${doc.id}/append`, { heading: 'Proof', markdown: WHY_SAFE });
        expect(missing.status).toBe(404);
        expect(missing.body.message).toContain('"Why it works"');
        expect((await chat.post(`/api/agent/docs/${doc.id}/append`, { after: 'start one pointer', markdown: WHY_SAFE })).status).toBe(400);
        // Without heading: unchanged behaviour (the doc's end).
        const plain = await chat.post(`/api/agent/docs/${doc.id}/append`, { markdown: 'A last line.' });
        expect(plain.body.data).toEqual({ id: doc.id, appended: 1, editId: expect.any(String) });
        expect((await shape(doc.id)).slice(-2)).toEqual(['paragraph:A last line.', 'paragraph:']);
    });

    it('a note the section already holds is not added (another app, other casing); a different note on the section is', async () => {
        const user = await createTestUser();
        const doc = await blocksDoc(user.id, 'Two Pointers', twoPointers());
        const claude = asAgent((await createTestToken(user, ['read', 'docs:write'], 'Claude')).token, 'Claude');
        const chatgpt = asAgent((await createTestToken(user, ['read', 'docs:write'], 'ChatGPT')).token, 'ChatGPT');
        expect((await claude.post(`/api/agent/docs/${doc.id}/append`, { heading: 'Why it works', markdown: CONVEYOR })).body.data.placed).toBe('section_end');
        const again = await chatgpt.post(`/api/agent/docs/${doc.id}/append`, { heading: 'Why it works', markdown: CONVEYOR.replace('Conveyor belt picture', 'The conveyor belt picture') });
        expect(again.status).toBe(200);
        expect(again.body.data).toEqual({ id: doc.id, heading: 'Why it works', already: true, placed: null, appended: 0, editId: null });
        // The section's own sentence again is a repeat too.
        expect((await chatgpt.post(`/api/agent/docs/${doc.id}/append`, { heading: 'Why it works', markdown: 'If the sum is too small, move the left pointer right' })).body.data.already).toBe(true);
        // A new insight on the same topic is added.
        expect((await chatgpt.post(`/api/agent/docs/${doc.id}/append`, { heading: 'Why it works', markdown: WHY_SAFE })).body.data.placed).toBe('section_end');
        expect((await shape(doc.id)).filter((l) => l.startsWith('paragraph:Added '))).toHaveLength(2);
    });

    it('two chats saving the same note at the same moment write it once', async () => {
        const user = await createTestUser();
        const doc = await blocksDoc(user.id, 'Two Pointers', twoPointers());
        const actor = (agentName: string) => ({ userId: user.id, agentName, tokenId: null });
        const [a, b] = await Promise.all([
            appendNoteForAgent(actor('Claude'), doc.id, { heading: 'Why it works', markdown: CONVEYOR }, AT()),
            appendNoteForAgent(actor('ChatGPT'), doc.id, { heading: 'Why it works', markdown: CONVEYOR }, AT()),
        ]);
        expect([('already' in a && a.already) || false, ('already' in b && b.already) || false].sort()).toEqual([false, true]);
        expect((await shape(doc.id)).filter((l) => l.includes('Conveyor belt picture'))).toHaveLength(1);
    });

    it('no cap on how many a day (a fourth and a tenth go in); 6,000 characters is a size guard; a viewer and a read token are refused', async () => {
        const user = await createTestUser();
        const doc = await blocksDoc(user.id, 'Two Pointers', twoPointers());
        const chat = asAgent((await createTestToken(user, ['read', 'docs:write'], 'ChatGPT')).token, 'ChatGPT');
        // A long explanation that is still one note goes in (the old 1,500 was too tight for a real one).
        const longer = `**A worked trace:** ${Array.from({ length: 30 }, (_, i) => `step ${i + 1} compares candidate pair ${i + 1} against the target and decides which side gives way.`).join(' ')}`;
        expect(longer.length).toBeGreaterThan(1500);
        expect((await chat.post(`/api/agent/docs/${doc.id}/append`, { heading: 'Why it works', markdown: longer })).status).toBe(200);
        const long = await chat.post(`/api/agent/docs/${doc.id}/append`, { heading: 'Why it works', markdown: `**Long:** ${'word '.repeat(1300)}` });
        expect(long.status).toBe(400);
        expect(long.body.message).toMatch(/at most 6,000 characters/);
        const notes = [
            '**Left pointer:** it only moves right.',
            '**Right pointer:** it only moves left.',
            '**When they meet:** the search is over and no pair was found.',
            '**Duplicates:** skip equal values after a hit.',
            '**Negative numbers:** they change nothing, the array is still sorted.',
            '**Three sum:** fix one value, then run two pointers on the rest.',
            '**Closest pair:** keep the best difference seen while moving.',
            '**Strings:** palindromes check from both ends the same way.',
            '**Linked lists:** fast and slow pointers find the middle.',
            '**Container with most water:** move the shorter wall inward.',
        ];
        for (const n of notes) {
            const r = await chat.post(`/api/agent/docs/${doc.id}/append`, { heading: 'Complexity', markdown: n });
            expect(r.status).toBe(200);
            expect(r.body.data.placed).toBe('section_end');
        }
        expect((await shape(doc.id)).filter((l) => l.startsWith('paragraph:Added '))).toHaveLength(11);
        // A read token, a stranger.
        const reader = asAgent((await createTestToken(user, ['read'], 'Claude')).token, 'Claude');
        expect((await reader.post(`/api/agent/docs/${doc.id}/append`, { heading: 'Complexity', markdown: '**x:** y z' })).status).toBe(403);
        const stranger = asAgent((await createTestToken(await createTestUser(), ['read', 'docs:write'], 'Claude')).token, 'Claude');
        expect((await stranger.post(`/api/agent/docs/${doc.id}/append`, { heading: 'Complexity', markdown: '**x:** y z' })).status).toBe(404);
    });

    it('a doc on the old editor takes a note in its section the same way', async () => {
        const user = await createTestUser();
        const md = '## Two pointers\n\nWorks on a sorted array.\n\n### Why it works\n\nStart one pointer at each end.\n\nIf the sum is too small, move left.\n\n## Complexity\n\nO(n).';
        const doc = await prisma.doc.create({ data: { userId: user.id, title: 'Old pointers', yjsState: docJsonToYjsState(markdownToDocJson(md)) } });
        const actor = { userId: user.id, agentName: 'Claude', tokenId: null };
        const r = await appendNoteForAgent(actor, doc.id, { heading: 'Why it works', after: 'start one pointer', markdown: WHY_SAFE }, AT());
        expect(r).toMatchObject({ heading: 'Why it works', placed: 'after', appended: 2 });
        const row = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        const texts = (yjsStateToDocJson(row.yjsState!).content as JSONContent[]).map((n) => nodePlainText(n));
        const i = texts.findIndex((x) => x.startsWith('Start one pointer'));
        expect(texts[i + 1]).toMatch(/^Why it never misses a pair/);
        expect(texts[i + 2]).toBe('Added 20 Nov from Claude');
        expect(await appendNoteForAgent(actor, doc.id, { heading: 'Why it works', markdown: WHY_SAFE }, AT(1))).toMatchObject({ already: true });
    });
});
