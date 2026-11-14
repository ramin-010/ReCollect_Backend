// Practice log → note (HOME_DOCS_AGENT_PLAN §4, Phase D2) through the real app and Postgres, with a
// fake Claude API (tests/helpers/claude.ts): the note becomes a normal doc with the seven sections
// and the learner's code verbatim, filed and scheduled like an agent's doc but with no agent edit
// log line; 400 / 404 before any spend, 402 at the cap, 503 without a key, 502 for unusable output.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as Y from 'yjs';
import Anthropic from '@anthropic-ai/sdk';
import type { JSONContent } from '@tiptap/core';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { addDays, today as todayIn } from '../../src/services/learning';
import { yjsStateToDocJson } from '../../src/services/docs/docContent';
import { nodePlainText } from '../../src/services/docs/markdown/docMarkdown';
import { setAiClientForTests } from '../../src/services/claude/client';
import { FALLBACK_BETA } from '../../src/services/recall/prompts';
import { PRACTICE_SYSTEM_PROMPT } from '../../src/services/practice/prompts';
import { PRACTICE_SECTIONS } from '../../src/services/practice/output';
import { api, createLearner, createSubjectRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import { DEFAULT_COST_USD, FakeClaude, SAMPLE_NOTE_MARKDOWN, fakeMessage, samplePracticeNote } from '../helpers/claude';

const IST = 'Asia/Kolkata';
/** Tabs, trailing spaces, a blank line and a ``` line: all must survive. */
const CODE = [
    'def two_sum(nums, target):',
    '\tseen = {}',
    '    for i, x in enumerate(nums):',
    '        seen[x] = i  ',
    '',
    '        # ``` in a comment',
    '```',
    '        if target - x in seen:',
    '            return [seen[target - x], i]',
].join('\n');

const fake = new FakeClaude();

beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    setAiClientForTests(fake);
});
afterAll(() => {
    setAiClientForTests(null);
    process.env.CLAUDE_API_KEY = '';
});
beforeEach(() => fake.reset());

const note = (over: Record<string, unknown> = {}) => ({
    problem: 'https://leetcode.com/problems/two-sum/',
    solution: `\n${CODE}\n\n`,
    language: 'Python 3',
    struggles: 'I paired an index with itself.',
    ...over,
});

const post = (user: { id: string }, body: object) => api(user).post('/api/ai/practice-note', body);

async function storedDoc(docId: string) {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
    return { row, json: yjsStateToDocJson(row.yjsState!) as JSONContent };
}

function codeBlocks(doc: JSONContent): Array<{ language: unknown; text: string }> {
    const found: Array<{ language: unknown; text: string }> = [];
    const walk = (node: JSONContent) => {
        if (node.type === 'codeBlock') found.push({ language: node.attrs?.['language'] ?? null, text: (node.content ?? []).map((t) => t.text ?? '').join('') });
        (node.content ?? []).forEach(walk);
    };
    walk(doc);
    return found;
}

const sections = (doc: JSONContent) => (doc.content ?? []).filter((b) => b.type === 'heading' && b.attrs?.['level'] === 2).map((b) => nodePlainText(b));

async function usageRows(userId: string) {
    return prisma.aiUsage.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
}

describe('POST /api/ai/practice-note', () => {
    it('writes the note as a normal doc: the seven sections, the code verbatim under ## Code; one low-effort call with fallbacks; billed; no agent edit', async () => {
        const user = await createLearner(IST);
        const res = await post(user, note());

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ success: true, data: { docId: expect.any(String), title: 'Two Sum', topicId: null, nextRevision: null } });

        const { row, json } = await storedDoc(res.body.data.docId);
        expect(row).toMatchObject({ userId: user.id, title: 'Two Sum', docType: 'notes', isArchived: false });
        expect(row.previewState).toContain('Given an array of integers');
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, Buffer.from(row.yjsState!, 'base64'));
        expect(ydoc.getMap('metadata').get('title')).toBe('Two Sum');
        ydoc.destroy();

        expect(sections(json)).toEqual([...PRACTICE_SECTIONS]);
        const [mine, cleaner] = codeBlocks(json);
        expect(mine).toEqual({ language: 'python', text: CODE });
        expect(cleaner!.text).toContain('if target - x in seen:');
        expect(JSON.stringify(json)).not.toContain('{{MY_SOLUTION}}');
        expect((json.content ?? []).some((b) => b.type === 'callout')).toBe(true);
        expect((json.content ?? []).filter((b) => b.type === 'details')).toHaveLength(2);

        expect(fake.calls).toHaveLength(1);
        const call = fake.calls[0]!;
        expect(call.model).toBe('claude-opus-5-5');
        expect(call.betas).toEqual([FALLBACK_BETA]);
        expect(call.fallbacks).toBe('default');
        expect(call.thinking).toEqual({ type: 'adaptive' });
        expect(call.output_config?.effort).toBe('low');
        expect(call.system).toEqual([{ type: 'text', text: PRACTICE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
        const task = (call.messages[0]!.content as Array<{ text: string }>)[0]!.text;
        expect(task).toContain('<language>python</language>');
        expect(task).toContain(`<solution>\n${CODE}\n</solution>`);
        expect(task).toContain('I paired an index with itself.');

        const rows = await usageRows(user.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ feature: 'practice_note', model: 'claude-opus-5-5', batch: false });
        expect(Number(rows[0]!.costUsd)).toBeCloseTo(DEFAULT_COST_USD, 6);
        expect(await prisma.agentEdit.count({ where: { userId: user.id } })).toBe(0);

        // It is the user's doc like any other (the docs API lists and opens it).
        const opened = await api(user).get(`/api/docs/${row.id}`);
        expect(opened.status).toBe(200);
    });

    it('with subjectId + revise: filed as a topic and scheduled 1/3/7/21 days by the topic service; without revise a topic with no revisions', async () => {
        const user = await createLearner(IST);
        const subject = await createSubjectRow(user.id, 'DSA');
        const res = await post(user, note({ subjectId: subject.id, revise: true }));
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ title: 'Two Sum', topicId: expect.any(String), nextRevision: addDays(todayIn(IST), 1) });

        const byDoc = await api(user).get(`/api/topics/by-doc/${res.body.data.docId}`);
        expect(byDoc.body.data.topic).toMatchObject({ _id: res.body.data.topicId, subjectId: subject.id });
        expect(byDoc.body.data.chain.map((r: { intervalDays: number }) => r.intervalDays)).toEqual([1, 3, 7, 21]);

        const filed = await post(user, note({ subjectId: subject.id }));
        expect(filed.status).toBe(201);
        expect(filed.body.data).toMatchObject({ topicId: expect.any(String), nextRevision: null });
        expect(await prisma.revision.count({ where: { topicId: filed.body.data.topicId } })).toBe(0);
        expect(await prisma.agentEdit.count({ where: { userId: user.id } })).toBe(0);
    });

    it("without a language the code block takes Claude's tag; the code is still verbatim", async () => {
        const user = await createLearner(IST);
        fake.push(fakeMessage(samplePracticeNote({ markdown: SAMPLE_NOTE_MARKDOWN.replace('```python\n{{MY_SOLUTION}}', '```Go\n{{MY_SOLUTION}}') })));
        const code = 'func twoSum(nums []int, target int) []int {\n\treturn nil\n}';
        const res = await post(user, note({ solution: code, language: undefined }));
        expect(res.status).toBe(201);
        expect(codeBlocks((await storedDoc(res.body.data.docId)).json)[0]).toEqual({ language: 'go', text: code });
        expect((fake.calls[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text).toContain('<language>not given');
    });

    it('400 for bad input and for revise without a subject; 404 for an unknown or foreign subject; no call, no doc', async () => {
        const user = await createLearner(IST);
        const stranger = await createLearner(IST);
        const theirs = await createSubjectRow(stranger.id);
        const bad = [
            { solution: CODE },
            note({ problem: '   ' }),
            note({ solution: ' \n\t ' }),
            note({ problem: 'x'.repeat(4001) }),
            note({ solution: 'x'.repeat(20001) }),
            note({ language: 'x'.repeat(41) }),
            note({ struggles: 'x'.repeat(2001) }),
            note({ revise: 'yes' }),
        ];
        for (const body of bad) {
            const res = await post(user, body);
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ success: false, code: 'INVALID_INPUT' });
        }
        const revise = await post(user, note({ revise: true }));
        expect(revise.status).toBe(400);
        expect(revise.body).toEqual({ success: false, code: 'INVALID_INPUT', message: 'revise needs a subjectId (the subject to revise it under)' });

        for (const subjectId of ['no-such-subject', theirs.id]) {
            const res = await post(user, note({ subjectId, revise: true }));
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ success: false, code: 'NOT_FOUND', message: 'Subject not found' });
        }
        expect(fake.calls).toHaveLength(0);
        expect(await prisma.doc.count({ where: { userId: user.id } })).toBe(0);
        // The limits are inclusive.
        expect((await post(user, note({ problem: 'x'.repeat(4000), language: 'x'.repeat(40), struggles: 'x'.repeat(2000) }))).status).toBe(201);
    });

    it('402 AI_CAP_REACHED at the cap (no call); 503 without a key; 401 without a cookie; 403 for an access token', async () => {
        const user = await createLearner(IST);
        await prisma.aiSettings.create({ data: { userId: user.id, monthlyCapUsd: '0' } });
        const capped = await post(user, note());
        expect(capped.status).toBe(402);
        expect(capped.body).toMatchObject({ success: false, code: 'AI_CAP_REACHED' });
        expect(fake.calls).toHaveLength(0);

        process.env.CLAUDE_API_KEY = '';
        try {
            const off = await post(user, note());
            expect(off.status).toBe(503);
            expect(off.body).toEqual({ success: false, code: 'AI_NOT_CONFIGURED', message: expect.any(String) });
        } finally {
            process.env.CLAUDE_API_KEY = 'test-key-not-real';
        }

        expect((await request(app).post('/api/ai/practice-note').send(note())).status).toBe(401);
        const { token } = await createTestToken(user);
        expect((await asAgent(token).post('/api/ai/practice-note', note())).status).toBe(403);
        expect(await prisma.doc.count({ where: { userId: user.id } })).toBe(0);
    });

    it('502 when Claude declines, answers garbage or leaves out a section (billed, no doc); AI_BUSY when rate limited (not billed)', async () => {
        const user = await createLearner(IST);
        fake.push(fakeMessage('', { stopReason: 'refusal' }));
        const refused = await post(user, note());
        expect(refused.status).toBe(502);
        expect(refused.body).toMatchObject({ success: false, code: 'AI_REFUSED' });

        fake.push(fakeMessage('Here is your note!'));
        expect((await post(user, note())).body.code).toBe('AI_FAILED');

        fake.push(fakeMessage(samplePracticeNote({ markdown: SAMPLE_NOTE_MARKDOWN.replace('## Similar problems', '## See also') })));
        const missing = await post(user, note());
        expect(missing.status).toBe(502);
        expect(missing.body.code).toBe('AI_FAILED');

        fake.push(fakeMessage('{"title":"Two Sum","markdown":"## Problem\\n\\nx', { stopReason: 'max_tokens' }));
        expect((await post(user, note())).body.code).toBe('AI_FAILED');

        fake.push(Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'rate', new Headers()));
        const busy = await post(user, note());
        expect(busy.status).toBe(502);
        expect(busy.body.code).toBe('AI_BUSY');

        expect((await usageRows(user.id)).map((r) => r.feature)).toEqual(['practice_note', 'practice_note', 'practice_note', 'practice_note']);
        expect(await prisma.doc.count({ where: { userId: user.id } })).toBe(0);
    });
});
