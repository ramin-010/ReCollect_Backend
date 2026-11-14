// The weekly coach (HOME_DOCS_AGENT_PLAN §4, Phase D3) through the real app and Postgres, with a
// fake Claude API: the evidence of the 7 days ending yesterday (the user's zone) goes to Claude as
// JSON, the note is stored and GET returns it; a second POST the same day returns it unless
// ?fresh=1; thin evidence is flagged; an empty week gets a note without a model call; 402 / 503 /
// 502 / 401 / 403.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { addDays, today as todayIn } from '../../src/services/learning';
import { setAiClientForTests } from '../../src/services/claude/client';
import { FALLBACK_BETA } from '../../src/services/recall/prompts';
import { COACH_SYSTEM_PROMPT } from '../../src/services/coach/prompts';
import { coachWindow, type CoachEvidence } from '../../src/services/coach/evidence';
import { QUIET_WEEK_MODEL, quietWeekNote } from '../../src/services/coach/coach.service';
import { api, createChainRows, createLearner, createSubjectRow, d } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import { DEFAULT_COST_USD, FakeClaude, fakeMessage, sampleCoach } from '../helpers/claude';

const IST = 'Asia/Kolkata';
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

/** An instant on a local (IST) day. */
const at = (day: string, time = '10:00') => new Date(`${day}T${time}:00+05:30`);

/** The evidence JSON Claude was sent in call `i`. */
function sentEvidence(i = 0): CoachEvidence {
    const text = (fake.calls[i]!.messages[0]!.content as Array<{ text: string }>)[0]!.text;
    const match = /<evidence>\n(.*)\n<\/evidence>/s.exec(text);
    if (!match) throw new Error('no <evidence> block');
    return JSON.parse(match[1]!) as CoachEvidence;
}

/**
 * A learner with a busy week: a DSA topic whose cycle 1 was done on time and cycle 2 missed, a
 * Recall review that went weak, focus lines (1 of 2 done), a doc written in the week and a goal.
 */
async function busyWeek() {
    const user = await createLearner(IST);
    const today = todayIn(IST);
    const { weekStart } = coachWindow(today);
    const subject = await createSubjectRow(user.id, 'DSA');
    const doc = await prisma.doc.create({ data: { userId: user.id, title: 'Dijkstra' } });
    const topic = await prisma.topic.create({ data: { userId: user.id, subjectId: subject.id, docId: doc.id, title: 'Dijkstra' } });
    const chain = await createChainRows(user.id, { topicId: topic.id }, addDays(weekStart, 0), {
        1: { scheduledFor: addDays(weekStart, 1), status: 'done', completedAt: at(addDays(weekStart, 1)) },
        2: { scheduledFor: addDays(weekStart, 3) },
        3: { scheduledFor: addDays(today, 10) },
        4: { scheduledFor: addDays(today, 30) },
    });
    const set = await prisma.recallSet.create({
        data: {
            userId: user.id,
            revisionId: chain[0]!.id,
            docId: doc.id,
            cycleNumber: 1,
            status: 'ready',
            model: 'claude-opus-5-5',
            questions: [
                { id: 'q1', kind: 'edge', prompt: 'Why does Dijkstra fail with negative edges?', answerKey: 'k', sourceQuote: 's' },
                { id: 'q2', kind: 'recall', prompt: 'What does the priority queue hold?', answerKey: 'k', sourceQuote: 's' },
            ],
            finishedAt: at(addDays(weekStart, 1), '10:30'),
            result: 'weak',
        },
    });
    await prisma.recallAttempt.createMany({
        data: [
            { setId: set.id, questionId: 'q1', grade: 'weak', feedback: '', createdAt: at(addDays(weekStart, 1), '10:10') },
            { setId: set.id, questionId: 'q2', grade: 'strong', feedback: '', createdAt: at(addDays(weekStart, 1), '10:20') },
        ],
    });
    await prisma.focusItem.createMany({
        data: [
            { userId: user.id, day: d(addDays(weekStart, 2)), text: 'Solve 2 graph problems', done: true },
            { userId: user.id, day: d(addDays(weekStart, 2)), text: 'Read DDIA chapter 5', done: false },
        ],
    });
    await prisma.doc.create({ data: { userId: user.id, title: 'Bellman-Ford', createdAt: at(addDays(weekStart, 2)), updatedAt: at(addDays(weekStart, 2), '11:00') } });
    await prisma.goal.create({
        data: {
            userId: user.id,
            title: 'Product-company SDE role',
            deadline: d(addDays(today, 200)),
            createdAt: at(addDays(today, -60)),
            milestones: {
                create: [
                    { title: 'Arrays and hashing', done: true, doneAt: at(addDays(today, -30)), sortOrder: 0 },
                    { title: 'Graphs', done: false, sortOrder: 1 },
                ],
            },
        },
    });
    return { user, today, chain };
}

const coach = (user: { id: string }, query = '') => api(user).post(`/api/ai/coach${query}`);

describe('POST /api/ai/coach', () => {
    it("writes the note from the week's evidence (one low-effort call with fallbacks), stores it, bills it; GET returns it", async () => {
        const { user, today } = await busyWeek();
        const res = await coach(user);

        expect(res.status).toBe(201);
        const window = coachWindow(today);
        expect(res.body).toEqual({
            success: true,
            data: {
                id: expect.any(String),
                weekStart: window.weekStart,
                weekEnd: window.weekEnd,
                lines: { strong: sampleCoach().strong, slipping: sampleCoach().slipping, fix: sampleCoach().fix, deadline: sampleCoach().deadline },
                focus: sampleCoach().focus,
                createdAt: expect.any(String),
            },
        });
        expect(window.weekEnd).toBe(addDays(today, -1));

        expect(fake.calls).toHaveLength(1);
        const call = fake.calls[0]!;
        expect(call.model).toBe('claude-opus-5-5');
        expect(call.betas).toEqual([FALLBACK_BETA]);
        expect(call.fallbacks).toBe('default');
        expect(call.thinking).toEqual({ type: 'adaptive' });
        expect(call.output_config?.effort).toBe('low');
        expect(call.system).toEqual([{ type: 'text', text: COACH_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);

        const evidence = sentEvidence();
        expect(evidence.week).toEqual({ from: window.weekStart, to: window.weekEnd, today });
        expect(evidence.level).toBe('enough');
        expect(evidence.revisions).toMatchObject({ dueInWeek: 2, doneOnTime: 1, missed: 1, doneInWeek: 1, backlogFromBefore: 0, missedTitles: ['Dijkstra'] });
        expect(evidence.revisions.bySubject).toEqual([{ subject: 'DSA', due: 2, done: 1, missed: 1 }]);
        expect(evidence.recall).toEqual({
            reviewsFinished: 1,
            results: { strong: 0, partial: 0, weak: 1 },
            answers: { strong: 1, partial: 0, weak: 1 },
            weakestTopics: [{ title: 'Dijkstra', weak: 1, partial: 0, answered: 2, weakQuestions: ['Why does Dijkstra fail with negative edges?'] }],
        });
        expect(evidence.focus).toEqual({ lines: 2, done: 1, daysWithLines: 1, notDone: ['Read DDIA chapter 5'], doneExamples: ['Solve 2 graph problems'] });
        expect(evidence.docs).toMatchObject({ created: 1, createdTitles: ['Bellman-Ford'] });
        expect(evidence.goals).toHaveLength(1);
        expect(evidence.goals[0]).toMatchObject({ title: 'Product-company SDE role', daysLeft: 200, milestones: { done: 1, total: 2, doneThisWeek: 0 }, nextMilestone: { title: 'Graphs', due: null } });
        expect(evidence.rhythm.activeDays).toBe(2);

        const stored = await prisma.coachNote.findUniqueOrThrow({ where: { id: res.body.data.id } });
        expect(stored).toMatchObject({ userId: user.id, model: 'claude-opus-5-5', focus: sampleCoach().focus });
        const usage = await prisma.aiUsage.findMany({ where: { userId: user.id } });
        expect(usage).toHaveLength(1);
        expect(usage[0]).toMatchObject({ feature: 'weekly_coach', batch: false });
        expect(Number(usage[0]!.costUsd)).toBeCloseTo(DEFAULT_COST_USD, 6);

        const latest = await api(user).get('/api/ai/coach');
        expect(latest.status).toBe(200);
        expect(latest.body).toEqual(res.body);
    });

    it('a second POST the same day returns the stored note (200, no call); ?fresh=1 writes a new one (201) and GET returns the newest', async () => {
        const { user } = await busyWeek();
        const first = await coach(user);
        expect(first.status).toBe(201);

        const again = await coach(user);
        expect(again.status).toBe(200);
        expect(again.body.data).toEqual(first.body.data);
        expect(fake.calls).toHaveLength(1);

        fake.push(fakeMessage(sampleCoach({ fix: 'Do the missed review before work every day.' })));
        const fresh = await coach(user, '?fresh=1');
        expect(fresh.status).toBe(201);
        expect(fresh.body.data.id).not.toBe(first.body.data.id);
        expect(fresh.body.data.lines.fix).toBe('Do the missed review before work every day.');
        expect(fake.calls).toHaveLength(2);

        expect((await api(user).get('/api/ai/coach')).body.data.id).toBe(fresh.body.data.id);
        expect((await coach(user)).body.data.id).toBe(fresh.body.data.id); // the newest of today
        expect(await prisma.coachNote.count({ where: { userId: user.id } })).toBe(2);
        expect(await prisma.aiUsage.count({ where: { userId: user.id, feature: 'weekly_coach' } })).toBe(2);
    });

    it('little evidence: Claude is told the week is thin (level "little")', async () => {
        const user = await createLearner(IST);
        const { weekStart } = coachWindow(todayIn(IST));
        await prisma.focusItem.create({ data: { userId: user.id, day: d(addDays(weekStart, 4)), text: 'Revise heaps', done: true } });
        const res = await coach(user);
        expect(res.status).toBe(201);
        expect(fake.calls).toHaveLength(1);
        const evidence = sentEvidence();
        expect(evidence.level).toBe('little');
        expect(evidence.focus).toMatchObject({ lines: 1, done: 1 });
        expect(evidence.goals).toEqual([]);
        expect(COACH_SYSTEM_PROMPT).toContain('Where the evidence is thin');
    });

    it('an empty week: an honest note without a model call (no cost, even at a $0 cap), stored like any other', async () => {
        const user = await createLearner(IST);
        await prisma.aiSettings.create({ data: { userId: user.id, monthlyCapUsd: '0' } });
        // Today's activity is not part of the week.
        await prisma.focusItem.create({ data: { userId: user.id, day: d(todayIn(IST)), text: 'Today only', done: true } });
        const res = await coach(user);
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ lines: quietWeekNote().lines, focus: quietWeekNote().focus });
        expect(res.body.data.focus).toHaveLength(3);
        expect(fake.calls).toHaveLength(0);
        expect(await prisma.aiUsage.count({ where: { userId: user.id } })).toBe(0);
        expect((await prisma.coachNote.findFirstOrThrow({ where: { userId: user.id } })).model).toBe(QUIET_WEEK_MODEL);
        expect((await api(user).get('/api/ai/coach')).body.data.id).toBe(res.body.data.id);
    });

    it("the week is the user's own: 7 local days ending yesterday in their zone", async () => {
        const tz = 'America/Los_Angeles';
        const user = await createLearner(tz);
        const res = await coach(user);
        expect(res.body.data).toMatchObject({ weekEnd: addDays(todayIn(tz), -1), weekStart: addDays(todayIn(tz), -7) });
    });

    it('402 at the cap (no call, nothing stored); 502 when Claude declines or gives fewer than 3 focus lines (billed, nothing stored)', async () => {
        const { user } = await busyWeek();
        await api(user).patch('/api/ai/settings', { capUsd: 0 });
        const capped = await coach(user);
        expect(capped.status).toBe(402);
        expect(capped.body).toMatchObject({ success: false, code: 'AI_CAP_REACHED' });
        expect(fake.calls).toHaveLength(0);

        await api(user).patch('/api/ai/settings', { capUsd: 20 });
        fake.push(fakeMessage('', { stopReason: 'refusal' }));
        const refused = await coach(user);
        expect(refused.status).toBe(502);
        expect(refused.body).toMatchObject({ success: false, code: 'AI_REFUSED' });

        fake.push(fakeMessage(sampleCoach({ focus: ['Only one line', 'and another'] })));
        const short = await coach(user);
        expect(short.status).toBe(502);
        expect(short.body.code).toBe('AI_FAILED');

        expect(await prisma.coachNote.count({ where: { userId: user.id } })).toBe(0);
        expect(await prisma.aiUsage.count({ where: { userId: user.id, feature: 'weekly_coach' } })).toBe(2);
        expect((await api(user).get('/api/ai/coach')).body).toEqual({ success: true, data: null });
    });
});

describe('GET /api/ai/coach', () => {
    it("null before any note; another user's note is not yours", async () => {
        const { user } = await busyWeek();
        const stranger = await createLearner(IST);
        expect((await api(user).get('/api/ai/coach')).body).toEqual({ success: true, data: null });
        await coach(user);
        expect((await api(stranger).get('/api/ai/coach')).body).toEqual({ success: true, data: null });
    });

    it('503 without a key (GET and POST); 401 without a cookie; 403 for an access token', async () => {
        const user = await createLearner(IST);
        process.env.CLAUDE_API_KEY = '';
        try {
            for (const res of [await api(user).get('/api/ai/coach'), await coach(user)]) {
                expect(res.status).toBe(503);
                expect(res.body).toEqual({ success: false, code: 'AI_NOT_CONFIGURED', message: expect.any(String) });
            }
        } finally {
            process.env.CLAUDE_API_KEY = 'test-key-not-real';
        }
        expect((await request(app).get('/api/ai/coach')).status).toBe(401);
        expect((await request(app).post('/api/ai/coach')).status).toBe(401);
        const { token } = await createTestToken(user);
        expect((await asAgent(token).get('/api/ai/coach')).status).toBe(403);
        expect((await asAgent(token).post('/api/ai/coach')).status).toBe(403);
        expect(fake.calls).toHaveLength(0);
    });
});
