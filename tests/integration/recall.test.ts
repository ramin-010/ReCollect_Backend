// Recall mode (HOME_DOCS_AGENT_PLAN §4) through the real app and Postgres, with a fake Claude API
// (tests/helpers/claude.ts): start → answer (typed + self-mark) → finish → the revision moves; the
// cap (402), no key (503), no content (422), ownership, the spend meter, and the nightly batch.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Anthropic from '@anthropic-ai/sdk';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { addDays, today as todayIn } from '../../src/services/learning';
import { docJsonToYjsState } from '../../src/services/docs/docContent';
import { markdownToDocJson } from '../../src/services/docs/markdown/docMarkdown';
import { setAiClientForTests } from '../../src/services/claude/client';
import { FALLBACK_BETA } from '../../src/services/recall/prompts';
import { pollRecallBatches, submitNightlyRecallBatch } from '../../src/services/recall/batch.service';
import { api, createChainRows, createLearner, createSubjectRow, d } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import { DEFAULT_COST_USD, FakeClaude, erroredLine, fakeMessage, gradeOutput, sampleQuestions, succeededLine } from '../helpers/claude';

const IST = 'Asia/Kolkata';
const NOTES = `## Idea

A monotonic stack keeps its elements in decreasing order. Use a monotonic stack to find the next greater element.

## Complexity

Every element is pushed and popped at most once, so it runs in O(n).

## Edge cases

Indices left on the stack get -1.`;

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

type ChainOverrides = Parameters<typeof createChainRows>[3];

/** A learner with a doc-backed topic whose cycle 1 is due today (started yesterday). */
async function dueTopic(opts: { md?: string; title?: string; overrides?: ChainOverrides; user?: { id: string }; seenToday?: boolean } = {}) {
    const user = opts.user ?? (await createLearner(IST));
    const today = todayIn(IST);
    if (opts.seenToday) await prisma.user.update({ where: { id: user.id }, data: { lastSeenDay: d(today) } });
    const subject = await createSubjectRow(user.id);
    const title = opts.title ?? 'Monotonic stack';
    const doc = await prisma.doc.create({ data: { userId: user.id, title, yjsState: docJsonToYjsState(markdownToDocJson(opts.md ?? NOTES)) } });
    const topic = await prisma.topic.create({ data: { userId: user.id, subjectId: subject.id, docId: doc.id, title } });
    const chain = await createChainRows(user.id, { topicId: topic.id }, addDays(today, -1), opts.overrides ?? {});
    return { user, doc, topic, chain, rev: chain[0]!, today };
}

const day = (date: Date) => date.toISOString().slice(0, 10);

async function revisionRow(id: string) {
    return prisma.revision.findUniqueOrThrow({ where: { id } });
}

async function usageRows(userId: string) {
    return prisma.aiUsage.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
}

async function start(user: { id: string }, revisionId: string) {
    return api(user).post('/api/recall/start', { revisionId });
}

describe('POST /api/recall/start', () => {
    it('writes the questions now (one call, fallbacks on, low effort), never sends the answer key, and records the cost', async () => {
        const { user, doc, rev } = await dueTopic();
        const res = await start(user, rev.id);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const set = res.body.data;
        expect(set).toMatchObject({ revisionId: rev.id, docId: doc.id, docTitle: 'Monotonic stack', cycleNumber: 1, attempts: [], finishedAt: null });
        expect(set.questions).toHaveLength(4);
        expect(set.questions[0]).toEqual({ id: 'q1', kind: 'recall', prompt: sampleQuestions().questions[0]!.prompt });
        expect(JSON.stringify(set)).not.toMatch(/answerKey|sourceQuote|Decreasing order from bottom/);

        expect(fake.calls).toHaveLength(1);
        const call = fake.calls[0]!;
        expect(call.model).toBe('claude-opus-5-5');
        expect(call.betas).toEqual([FALLBACK_BETA]);
        expect(call.fallbacks).toBe('default');
        expect(call.thinking).toEqual({ type: 'adaptive' });
        expect(call.output_config?.effort).toBe('low');
        const blocks = call.messages[0]!.content as Array<{ text: string; cache_control?: unknown }>;
        expect(blocks[0]!.text).toContain('Every element is pushed and popped at most once');
        expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' });
        expect(blocks[1]!.text).toContain('This is review 1 of 4');

        const rows = await usageRows(user.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ feature: 'recall_questions', model: 'claude-opus-5-5', batch: false, inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 2000 });
        expect(Number(rows[0]!.costUsd)).toBeCloseTo(DEFAULT_COST_USD, 6);

        const stored = await prisma.recallSet.findUniqueOrThrow({ where: { id: set.id } });
        expect(stored).toMatchObject({ status: 'ready', userId: user.id, docId: doc.id, batchId: null, model: 'claude-opus-5-5' });
        expect((stored.questions as Array<{ answerKey: string }>)[0]!.answerKey).toContain('Decreasing order');
    });

    it('returns the same live set again without a model call', async () => {
        const { user, rev } = await dueTopic();
        const first = await start(user, rev.id);
        const again = await start(user, rev.id);
        expect(again.status).toBe(200);
        expect(again.body.data.id).toBe(first.body.data.id);
        expect(fake.calls).toHaveLength(1);
        expect(await prisma.recallSet.count({ where: { revisionId: rev.id } })).toBe(1);
    });

    it('a capture review asks about its title, text and link; docId is null', async () => {
        const user = await createLearner(IST);
        const capture = await prisma.capture.create({
            data: {
                userId: user.id,
                title: 'Dijkstra and negative edges',
                content: 'Dijkstra assumes that once a node is popped its distance is final. A negative edge can later shorten that distance, so the greedy choice breaks. Use Bellman-Ford instead.',
                url: 'https://example.com/dijkstra',
            },
        });
        const [rev] = await createChainRows(user.id, { captureId: capture.id }, addDays(todayIn(IST), -1));
        const res = await start(user, rev!.id);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ docId: null, docTitle: 'Dijkstra and negative edges' });
        const text = (fake.calls[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text;
        expect(text).toContain('<title>Dijkstra and negative edges</title>');
        expect(text).toContain('<link>https://example.com/dijkstra</link>');
        expect(text).toContain('Use Bellman-Ford instead.');
    });

    it('later reviews pass the earlier questions and how they went', async () => {
        const { user, chain } = await dueTopic({ overrides: { 1: { status: 'done', completedAt: new Date() }, 2: { scheduledFor: todayIn(IST) } } });
        const earlier = await prisma.recallSet.create({
            data: { userId: user.id, revisionId: chain[0]!.id, cycleNumber: 1, status: 'ready', model: 'claude-opus-5-5', questions: [{ id: 'q1', kind: 'edge', prompt: 'What about an empty array?', answerKey: 'k', sourceQuote: 's' }], finishedAt: new Date() },
        });
        await prisma.recallAttempt.create({ data: { setId: earlier.id, questionId: 'q1', grade: 'weak', feedback: '' } });

        const res = await start(user, chain[1]!.id);
        expect(res.status).toBe(200);
        expect(res.body.data.cycleNumber).toBe(2);
        const task = (fake.calls[0]!.messages[0]!.content as Array<{ text: string }>)[1]!.text;
        expect(task).toContain('This is review 2 of 4');
        expect(task).toContain('- [weak] (edge) What about an empty array?');
    });

    it('422 NO_CONTENT when the notes are too short to ask about (no model call)', async () => {
        const { user, rev } = await dueTopic({ md: 'Just a heading and a line.' });
        const res = await start(user, rev.id);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({ success: false, code: 'NO_CONTENT', message: expect.any(String) });
        expect(fake.calls).toHaveLength(0);
    });

    it('409 NOT_PENDING for a review that is already done', async () => {
        const { user, rev } = await dueTopic({ overrides: { 1: { status: 'done', completedAt: new Date() } } });
        const res = await start(user, rev.id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NOT_PENDING');
    });

    it('502 when the model declines or returns something unreadable; the call is still billed; no set is stored', async () => {
        const { user, rev } = await dueTopic();
        fake.push(fakeMessage('', { stopReason: 'refusal' }));
        const refused = await start(user, rev.id);
        expect(refused.status).toBe(502);
        expect(refused.body).toMatchObject({ success: false, code: 'AI_REFUSED' });

        fake.push(fakeMessage('Here are some questions!'));
        const garbled = await start(user, rev.id);
        expect(garbled.status).toBe(502);
        expect(garbled.body.code).toBe('AI_FAILED');

        expect(await usageRows(user.id)).toHaveLength(2);
        expect(await prisma.recallSet.count({ where: { revisionId: rev.id } })).toBe(0);

        // The next start writes them (the default fake answer is fine).
        expect((await start(user, rev.id)).status).toBe(200);
    });

    it('a rejected API key is 503 AI_NOT_CONFIGURED; a rate limit is 502 AI_BUSY', async () => {
        const { user, rev } = await dueTopic();
        const err = (status: number, type: string) => Anthropic.APIError.generate(status, { type: 'error', error: { type, message: type } }, type, new Headers());
        fake.push(err(401, 'authentication_error'));
        const rejected = await start(user, rev.id);
        expect(rejected.status).toBe(503);
        expect(rejected.body.code).toBe('AI_NOT_CONFIGURED');

        fake.push(err(429, 'rate_limit_error'));
        const busy = await start(user, rev.id);
        expect(busy.status).toBe(502);
        expect(busy.body.code).toBe('AI_BUSY');
        expect(await usageRows(user.id)).toHaveLength(0);
    });
});

describe('POST /api/recall/sets/:id/answer', () => {
    it('self-marks without a model call: knew → strong, didnt → weak, quote = the source passage', async () => {
        const { user, rev } = await dueTopic();
        const set = (await start(user, rev.id)).body.data;
        const knew = await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q1', selfMark: 'knew' });
        expect(knew.status).toBe(200);
        expect(knew.body.data).toEqual({ questionId: 'q1', grade: 'strong', feedback: '', quote: sampleQuestions().questions[0]!.sourceQuote, selfMarked: true });
        const didnt = await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q2', selfMark: 'didnt' });
        expect(didnt.body.data).toMatchObject({ questionId: 'q2', grade: 'weak', selfMarked: true });
        expect(fake.calls).toHaveLength(1); // only the questions
    });

    it('grades a typed answer against the notes; re-answering replaces the attempt', async () => {
        const { user, rev } = await dueTopic();
        const set = (await start(user, rev.id)).body.data;

        fake.push(fakeMessage(gradeOutput('partial', 'You named the stack but not why it stays O(n): each element is pushed and popped once.', '')));
        const first = await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q3', answer: '  a stack  ' });
        expect(first.status).toBe(200);
        expect(first.body.data).toEqual({
            questionId: 'q3',
            grade: 'partial',
            feedback: 'You named the stack but not why it stays O(n): each element is pushed and popped once.',
            quote: sampleQuestions().questions[2]!.sourceQuote, // empty quote → the source passage
            selfMarked: false,
        });
        const call = fake.calls[1]!;
        expect(call.fallbacks).toBe('default');
        const blocks = call.messages[0]!.content as Array<{ text: string; cache_control?: unknown }>;
        expect(blocks[0]!.text).toBe((fake.calls[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text); // same cached notes block
        expect(blocks[1]!.text).toContain('<learner_answer>\na stack\n</learner_answer>');
        expect(blocks[1]!.text).toContain('<answer_key>Each element is pushed once and popped at most once');

        fake.push(fakeMessage(gradeOutput('strong', '', 'Every element is pushed and popped at most once, so it runs in O(n).')));
        const second = await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q3', answer: 'pushed and popped once each, so linear' });
        expect(second.body.data).toMatchObject({ grade: 'strong', feedback: '', selfMarked: false });

        const attempts = await prisma.recallAttempt.findMany({ where: { setId: set.id } });
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ questionId: 'q3', grade: 'strong', answer: 'pushed and popped once each, so linear', selfMark: null });
        const features = (await usageRows(user.id)).map((r) => r.feature);
        expect(features).toEqual(['recall_questions', 'recall_grade', 'recall_grade']);

        // start again: the attempts come back with the set
        const again = await start(user, rev.id);
        expect(again.body.data.attempts).toEqual([{ questionId: 'q3', grade: 'strong', feedback: '', quote: 'Every element is pushed and popped at most once, so it runs in O(n).', selfMarked: false }]);
    });

    it('400 for a bad body or an unknown question; 409 once finished', async () => {
        const { user, rev } = await dueTopic();
        const set = (await start(user, rev.id)).body.data;
        const post = (body: object) => api(user).post(`/api/recall/sets/${set.id}/answer`, body);
        expect((await post({ questionId: 'q1' })).status).toBe(400);
        expect((await post({ questionId: 'q1', answer: '   ' })).status).toBe(400);
        expect((await post({ questionId: 'q1', answer: 'x', selfMark: 'knew' })).status).toBe(400);
        expect((await post({ questionId: 'q1', selfMark: 'maybe' })).status).toBe(400);
        const unknown = await post({ questionId: 'q9', selfMark: 'knew' });
        expect(unknown.status).toBe(400);
        expect(unknown.body).toMatchObject({ success: false, code: 'UNKNOWN_QUESTION' });

        await api(user).post(`/api/recall/sets/${set.id}/finish`);
        const late = await post({ questionId: 'q1', selfMark: 'knew' });
        expect(late.status).toBe(409);
        expect(late.body.code).toBe('FINISHED');
    });
});

describe('POST /api/recall/sets/:id/finish', () => {
    it('strong → the revision is completed and the next cycle comes next; a second finish changes nothing', async () => {
        const { user, rev, chain, today } = await dueTopic();
        const set = (await start(user, rev.id)).body.data;
        for (const q of set.questions) await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: q.id, selfMark: 'knew' });

        const res = await api(user).post(`/api/recall/sets/${set.id}/finish`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ result: 'strong', effect: { kind: 'advanced', nextDay: addDays(today, 2) }, counts: { strong: 4, partial: 0, weak: 0 } });

        expect(await revisionRow(rev.id)).toMatchObject({ status: 'done' });
        expect(day((await revisionRow(chain[1]!.id)).scheduledFor)).toBe(addDays(today, 2));
        const stored = await prisma.recallSet.findUniqueOrThrow({ where: { id: set.id } });
        expect(stored.result).toBe('strong');
        expect(stored.finishedAt).not.toBeNull();
        // The streak service ran (first completion today).
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).globalStreak).toBe(1);

        const again = await api(user).post(`/api/recall/sets/${set.id}/finish`);
        expect(again.body.data).toEqual(res.body.data);
        expect(day((await revisionRow(chain[1]!.id)).scheduledFor)).toBe(addDays(today, 2));
        expect(await prisma.revision.count({ where: { topicId: rev.topicId, status: 'done' } })).toBe(1);
    });

    it('partial → the same revision comes back in 2 days (later cycles shift with it)', async () => {
        const { user, rev, chain, today } = await dueTopic();
        const set = (await start(user, rev.id)).body.data;
        const post = (body: object) => api(user).post(`/api/recall/sets/${set.id}/answer`, body);
        await post({ questionId: 'q1', selfMark: 'knew' });
        await post({ questionId: 'q2', selfMark: 'knew' });
        fake.push(fakeMessage(gradeOutput('partial', 'You missed why it is linear.')));
        await post({ questionId: 'q3', answer: 'a stack' });
        await post({ questionId: 'q4', selfMark: 'didnt' });

        const res = await api(user).post(`/api/recall/sets/${set.id}/finish`);
        expect(res.body.data).toEqual({ result: 'partial', effect: { kind: 'repeat', nextDay: addDays(today, 2) }, counts: { strong: 2, partial: 1, weak: 1 } });
        const moved = await revisionRow(rev.id);
        expect(moved.status).toBe('pending');
        expect(day(moved.scheduledFor)).toBe(addDays(today, 2));
        expect(day((await revisionRow(chain[1]!.id)).scheduledFor)).toBe(addDays(today, 4)); // was today+2
    });

    it('weak → back tomorrow; unanswered questions count as weak', async () => {
        const { user, rev, today } = await dueTopic();
        const set = (await start(user, rev.id)).body.data;
        await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q1', selfMark: 'knew' });
        const res = await api(user).post(`/api/recall/sets/${set.id}/finish`);
        expect(res.body.data).toEqual({ result: 'weak', effect: { kind: 'tomorrow', nextDay: addDays(today, 1) }, counts: { strong: 1, partial: 0, weak: 3 } });
        expect(day((await revisionRow(rev.id)).scheduledFor)).toBe(addDays(today, 1));
        expect((await revisionRow(rev.id)).status).toBe('pending');
    });

    it('strong on the last cycle → mastered', async () => {
        const done = { status: 'done' as const, completedAt: new Date(Date.now() - 86_400_000) };
        const { user, chain } = await dueTopic({ overrides: { 1: done, 2: done, 3: done, 4: { scheduledFor: todayIn(IST) } } });
        const set = (await start(user, chain[3]!.id)).body.data;
        expect(set.cycleNumber).toBe(4);
        for (const q of set.questions) await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: q.id, selfMark: 'knew' });
        const res = await api(user).post(`/api/recall/sets/${set.id}/finish`);
        expect(res.body.data.effect).toEqual({ kind: 'mastered', nextDay: null });
        expect((await revisionRow(chain[3]!.id)).status).toBe('done');
    });

    it('marked revised elsewhere during the review: the result is kept and the schedule is left alone', async () => {
        const { user, rev, today } = await dueTopic();
        const set = (await start(user, rev.id)).body.data;
        expect((await api(user).post(`/api/revisions/${rev.id}/complete`)).status).toBe(200);
        const res = await api(user).post(`/api/recall/sets/${set.id}/finish`); // nothing answered → weak
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ result: 'weak', effect: { kind: 'advanced', nextDay: addDays(today, 2) }, counts: { strong: 0, partial: 0, weak: 4 } });
        expect((await revisionRow(rev.id)).status).toBe('done');
    });
});

describe('ownership and auth', () => {
    it("404 for another user's revision or set; 401 without a cookie; 403 for an access token", async () => {
        const { user, rev } = await dueTopic();
        const set = (await start(user, rev.id)).body.data;
        const stranger = await createLearner(IST);

        const notMine = await start(stranger, rev.id);
        expect(notMine.status).toBe(404);
        expect(notMine.body).toEqual({ success: false, code: 'NOT_FOUND', message: 'Not found' });
        expect((await api(stranger).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q1', selfMark: 'knew' })).status).toBe(404);
        expect((await api(stranger).post(`/api/recall/sets/${set.id}/finish`)).status).toBe(404);

        expect((await request(app).post('/api/recall/start').send({ revisionId: rev.id })).status).toBe(401);
        expect((await request(app).get('/api/ai/usage')).status).toBe(401);

        const { token } = await createTestToken(user);
        const agent = asAgent(token);
        for (const res of [await agent.post('/api/recall/start', { revisionId: rev.id }), await agent.get('/api/ai/usage'), await agent.patch('/api/ai/settings', { capUsd: 5 })]) {
            expect(res.status).toBe(403);
        }
    });
});

describe('503 without CLAUDE_API_KEY', () => {
    it('every AI route says AI_NOT_CONFIGURED', async () => {
        const { user, rev } = await dueTopic();
        process.env.CLAUDE_API_KEY = '';
        try {
            const res = await start(user, rev.id);
            expect(res.status).toBe(503);
            expect(res.body).toEqual({ success: false, code: 'AI_NOT_CONFIGURED', message: expect.any(String) });
            expect((await api(user).get('/api/ai/usage')).status).toBe(503);
            expect((await api(user).patch('/api/ai/settings', { capUsd: 5 })).status).toBe(503);
            expect((await api(user).post('/api/recall/sets/x/finish')).status).toBe(503);
            expect(fake.calls).toHaveLength(0);
        } finally {
            process.env.CLAUDE_API_KEY = 'test-key-not-real';
        }
    });
});

describe('the monthly cap', () => {
    it('402 AI_CAP_REACHED once this month reaches the cap; self-marks and finish still work', async () => {
        const { user, rev } = await dueTopic();
        expect((await api(user).patch('/api/ai/settings', { capUsd: 0.03 })).body.data.capUsd).toBe(0.03);

        const set = (await start(user, rev.id)).body.data; // $0.024 spent
        expect((await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q1', answer: 'decreasing' })).status).toBe(200); // $0.048
        const capped = await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q2', answer: 'a stack' });
        expect(capped.status).toBe(402);
        expect(capped.body).toMatchObject({ success: false, code: 'AI_CAP_REACHED' });
        expect(fake.calls).toHaveLength(2);

        expect((await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q2', selfMark: 'didnt' })).status).toBe(200);
        expect((await api(user).post(`/api/recall/sets/${set.id}/finish`)).status).toBe(200);

        const other = await dueTopic({ user, title: 'Another doc' });
        const blocked = await start(user, other.rev.id);
        expect(blocked.status).toBe(402);
        expect(fake.calls).toHaveLength(2);
    });

    it('only this month counts (the user’s local month)', async () => {
        const { user, rev } = await dueTopic();
        await api(user).patch('/api/ai/settings', { capUsd: 1 });
        await prisma.aiUsage.create({ data: { userId: user.id, feature: 'recall_grade', model: 'claude-opus-5-5', costUsd: '5.000000', createdAt: new Date(Date.now() - 40 * 86_400_000) } });
        expect((await start(user, rev.id)).status).toBe(200);
    });
});

describe('GET /api/ai/usage and PATCH /api/ai/settings', () => {
    it("this month's spend by feature, the call count, the cap (default $20) and the model", async () => {
        const { user, rev } = await dueTopic();
        const set = (await start(user, rev.id)).body.data;
        await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q1', answer: 'decreasing' });
        await prisma.aiUsage.create({ data: { userId: user.id, feature: 'recall_questions', model: 'claude-opus-5-5', batch: true, costUsd: '0.012000' } });
        const other = await createLearner(IST);
        await prisma.aiUsage.create({ data: { userId: other.id, feature: 'recall_grade', model: 'claude-opus-5-5', costUsd: '9.000000' } });

        const res = await api(user).get('/api/ai/usage');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            month: todayIn(IST).slice(0, 7),
            spentUsd: 0.06,
            capUsd: 20,
            calls: 3,
            byFeature: { recall_questions: 0.036, recall_grade: 0.024, practice_note: 0, weekly_coach: 0 },
            model: 'claude-opus-5-5',
        });
    });

    it('sets the cap (0–1000, to the cent) and answers with the usage', async () => {
        const user = await createLearner(IST);
        const res = await api(user).patch('/api/ai/settings', { capUsd: 35.556 });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ capUsd: 35.56, spentUsd: 0, calls: 0 });
        expect((await api(user).get('/api/ai/usage')).body.data.capUsd).toBe(35.56);
        expect((await api(user).patch('/api/ai/settings', { capUsd: 0 })).body.data.capUsd).toBe(0);
        for (const capUsd of [-1, 1000.01, 'abc', null]) {
            const bad = await api(user).patch('/api/ai/settings', { capUsd });
            expect(bad.status).toBe(400);
            expect(bad.body).toMatchObject({ success: false, code: 'INVALID_INPUT' });
        }
    });
});

describe('the nightly Message Batch', () => {
    // Users from earlier tests count as inactive, so each test plans only its own reviews.
    beforeEach(async () => {
        await prisma.user.updateMany({ data: { lastSeenDay: null } });
    });

    it('pre-writes due reviews of active users under their cap, stores the results at half price, and start uses them', async () => {
        const today = todayIn(IST);
        const a = await dueTopic({ seenToday: true, title: 'Due today' });
        const tomorrow = await dueTopic({ user: a.user, title: 'Due tomorrow', overrides: { 1: { scheduledFor: addDays(today, 1) } } });
        const later = await dueTopic({ user: a.user, title: 'Due later', overrides: { 1: { scheduledFor: addDays(today, 5) } } });
        const tooShort = await dueTopic({ user: a.user, title: 'Too short', md: 'Almost nothing.' });
        const overdueTwice = await dueTopic({ user: a.user, title: 'Two cycles due', overrides: { 1: { scheduledFor: addDays(today, -3) }, 2: { scheduledFor: addDays(today, -1) } } });
        const inactive = await dueTopic({ title: 'Inactive user' }); // never opened the app
        const capped = await dueTopic({ seenToday: true, title: 'Capped user' });
        await prisma.aiSettings.create({ data: { userId: capped.user.id, monthlyCapUsd: '0' } });

        const submitted = await submitNightlyRecallBatch();
        const expected = [a.rev.id, tomorrow.rev.id, overdueTwice.chain[0]!.id];
        expect(submitted.requests).toBe(3);
        const batch = fake.batches.get(submitted.batchId!)!;
        expect(batch.requests.map((r) => r.custom_id).sort()).toEqual([...expected].sort());
        for (const r of batch.requests) {
            expect(r.params).not.toHaveProperty('fallbacks');
            expect(r.params.output_config?.effort).toBe('low');
        }
        for (const skipped of [later.rev.id, tooShort.rev.id, overdueTwice.chain[1]!.id, inactive.rev.id, capped.rev.id]) {
            expect(await prisma.recallSet.count({ where: { revisionId: skipped } })).toBe(0);
        }
        const pending = await prisma.recallSet.findMany({ where: { batchId: submitted.batchId! } });
        expect(pending.map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
        expect(await prisma.aiBatch.findUniqueOrThrow({ where: { id: submitted.batchId! } })).toMatchObject({ requestCount: 3, endedAt: null });

        // A second run the same night adds nothing.
        expect((await submitNightlyRecallBatch()).requests).toBe(0);

        // Still processing: nothing stored.
        expect(await pollRecallBatches()).toEqual({ open: 1, stored: 0 });

        fake.endBatch(submitted.batchId!, [
            succeededLine(a.rev.id),
            erroredLine(tomorrow.rev.id),
            succeededLine(overdueTwice.chain[0]!.id, fakeMessage('not json')),
        ]);
        expect(await pollRecallBatches()).toEqual({ open: 1, stored: 1 });
        expect(await pollRecallBatches()).toEqual({ open: 0, stored: 0 });

        const byRevision = async (revisionId: string) => prisma.recallSet.findFirstOrThrow({ where: { revisionId } });
        expect(await byRevision(a.rev.id)).toMatchObject({ status: 'ready', error: null });
        expect(await byRevision(tomorrow.rev.id)).toMatchObject({ status: 'failed' });
        expect((await byRevision(overdueTwice.chain[0]!.id)).status).toBe('failed');
        expect((await prisma.aiBatch.findUniqueOrThrow({ where: { id: submitted.batchId! } })).endedAt).not.toBeNull();

        const usage = await usageRows(a.user.id);
        expect(usage).toHaveLength(2); // the two billed (succeeded) requests
        for (const row of usage) {
            expect(row).toMatchObject({ feature: 'recall_questions', batch: true });
            expect(Number(row.costUsd)).toBeCloseTo(DEFAULT_COST_USD / 2, 6);
        }

        // The ready set opens without a model call.
        const ready = await start(a.user, a.rev.id);
        expect(ready.status).toBe(200);
        expect(ready.body.data.questions).toHaveLength(4);
        expect(fake.calls).toHaveLength(0);

        // A failed one is written on demand, in the same row.
        const failedSet = await byRevision(tomorrow.rev.id);
        const rewritten = await start(a.user, tomorrow.rev.id);
        expect(rewritten.body.data.id).toBe(failedSet.id);
        expect(fake.calls).toHaveLength(1);
        expect(await byRevision(tomorrow.rev.id)).toMatchObject({ status: 'ready', batchId: null });
    });

    it('a review started before its batch ends is written on demand; the batch result is billed but not stored', async () => {
        const a = await dueTopic({ seenToday: true });
        const submitted = await submitNightlyRecallBatch();
        expect(submitted.requests).toBe(1);

        fake.push(fakeMessage(sampleQuestions(3)));
        const started = await start(a.user, a.rev.id);
        expect(started.body.data.questions).toHaveLength(3);

        fake.endBatch(submitted.batchId!); // 4 questions for the same revision
        await pollRecallBatches();
        const sets = await prisma.recallSet.findMany({ where: { revisionId: a.rev.id } });
        expect(sets).toHaveLength(1);
        expect(sets[0]!.status).toBe('ready');
        expect((sets[0]!.questions as unknown[]).length).toBe(3);
        expect((await usageRows(a.user.id)).map((r) => r.batch)).toEqual([false, true]);
    });
});
