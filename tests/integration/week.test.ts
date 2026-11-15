// The week and suggestions (LOOP_COMPLETE_SPEC 1.6): targets that tick themselves, counts, the
// 5-target limit, agents (logged, undoable, can't accept), suggestions of each kind, and the Sunday
// review written by code.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { getWeek, weekStartOf } from '../../src/services/learningDb/week.service';
import { listSuggestions, proposeWeek } from '../../src/services/learningDb/suggestions.service';
import { newSessionKey } from '../../src/services/learningDb/sessions.service';
import { createTestUser } from '../helpers/auth';
import { api, createSubjectRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import type { DayString } from '../../src/services/learning';

const todayIst = (): DayString => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) as DayString;

async function planned(user: { id: string }, subjectId: string, titles: string[]) {
    return (await api(user).post(`/api/subjects/${subjectId}/path`, { titles })).body.data.path.topics as Array<{ _id: string; title: string }>;
}

describe('week targets', () => {
    it('a target ticks itself when its topic is done or its count is reached; at most 5; links are checked', async () => {
        const user = await createTestUser();
        const dsa = await createSubjectRow(user.id, 'DSA');
        const [graphs] = await planned(user, dsa.id, ['Graphs']);
        const add = (body: Record<string, unknown>) => api(user).post('/api/week/targets', body);

        const topic = await add({ text: 'Finish graphs', topicId: graphs!._id });
        expect(topic.status).toBe(201);
        expect(topic.body.data).toMatchObject({ text: 'Finish graphs', status: 'open', done: false, topic: { _id: graphs!._id, status: 'planned' }, weekStart: weekStartOf(todayIst()) });
        const count = await add({ text: '3 graph problems', measure: 'practice', amount: 3, subjectId: dsa.id });
        expect(count.body.data).toMatchObject({ done: false, progress: { done: 0, total: 3 } });

        expect((await add({ text: 'x', topicId: graphs!._id, measure: 'practice', amount: 2 })).status).toBe(400);
        expect((await add({ text: 'x', measure: 'minutes' })).status).toBe(400);
        expect((await add({ text: 'x', topicId: 'nope' })).body.message).toMatch(/No topic/);

        // Two practice sessions in the subject, then the topic finished: both tick themselves.
        const chat = asAgent((await createTestToken(user)).token);
        for (const n of [1, 2]) await chat.put(`/api/sessions/by-key/${newSessionKey()}:${n}`, { problem: `Problem ${n}`, outcome: 'alone', subjectId: dsa.id });
        await api(user).patch(`/api/topics/${graphs!._id}/path`, { status: 'done' });
        let week = (await api(user).get('/api/week')).body.data;
        expect(week.targets.map((t: { done: boolean; progress: unknown }) => [t.done, t.progress])).toEqual([
            [true, null],
            [false, { done: 2, total: 3 }],
        ]);

        // The limit: 5 that are not dropped; dropping one frees its place.
        for (const n of [3, 4, 5]) expect((await add({ text: `Target ${n}` })).status).toBe(201);
        const full = await add({ text: 'One too many' });
        expect(full.status).toBe(409);
        expect(full.body.code ?? full.body.error?.code ?? JSON.stringify(full.body)).toMatch(/WEEK_FULL/);
        await api(user).patch(`/api/week/targets/${count.body.data._id}`, { status: 'dropped' });
        expect((await add({ text: 'Now it fits' })).status).toBe(201);
        week = (await api(user).get('/api/week')).body.data;
        expect(week.targets).toHaveLength(5);
        // Ticking by hand.
        const ticked = await api(user).patch(`/api/week/targets/${week.targets[4]._id}`, { status: 'done' });
        expect(ticked.body.data).toMatchObject({ status: 'done', done: true });
    });

    it('an agent adds and changes targets (logged, undoable) and proposes, but never accepts', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'study-chat');
        const made = await chat.post('/api/week/targets', { text: '10 graph problems' });
        expect(made.status).toBe(201);
        expect(await prisma.weekTarget.findUniqueOrThrow({ where: { id: made.body.data._id } })).toMatchObject({ createdBy: 'agent', agentName: 'study-chat' });
        await chat.patch(`/api/week/targets/${made.body.data._id}`, { text: '12 graph problems', status: 'done' });
        const edits = await prisma.agentEdit.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        expect(edits.map((e) => e.summary)).toEqual(['Added the week target "10 graph problems"', 'Ticked the week target "12 graph problems"']);
        // Undo the change, then the add.
        expect((await api(user).post(`/api/agent/edits/${edits[1]!.id}/undo`)).status).toBe(200);
        expect(await prisma.weekTarget.findUniqueOrThrow({ where: { id: made.body.data._id } })).toMatchObject({ text: '10 graph problems', status: 'open', doneAt: null });
        expect((await api(user).post(`/api/agent/edits/${edits[0]!.id}/undo`)).status).toBe(200);
        expect(await prisma.weekTarget.count({ where: { userId: user.id } })).toBe(0);

        // Suggestions: an agent proposes; only the app accepts.
        const s = await chat.post('/api/suggestions', { kind: 'focus_line', text: 'Two sliding-window mediums', payload: { text: 'Two sliding-window mediums' } });
        expect(s.status).toBe(201);
        expect(s.body.data).toMatchObject({ kind: 'focus_line', status: 'pending', proposedBy: 'agent', agentName: 'study-chat' });
        expect((await chat.post(`/api/suggestions/${s.body.data._id}/accept`, {})).status).toBe(403);
        expect((await chat.post('/api/suggestions', { kind: 'action', text: 'x', payload: {} })).status).toBe(400);
        const accepted = await api(user).post(`/api/suggestions/${s.body.data._id}/accept`, {});
        expect(accepted.body.data.status).toBe('accepted');
        expect(await prisma.focusItem.findFirst({ where: { userId: user.id }, select: { text: true } })).toEqual({ text: 'Two sliding-window mediums' });
        expect((await api(user).post(`/api/suggestions/${s.body.data._id}/accept`, {})).status).toBe(409);
    });

    it('suggestions of each kind: a week target, the profile; dismiss; decide many at once', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'coach-chat');
        const a = (await chat.post('/api/suggestions', { kind: 'week_target', text: 'Ship the week UI', payload: { text: 'Ship the week UI' } })).body.data;
        const b = (await chat.post('/api/suggestions', { kind: 'profile_edit', text: 'Say he learns best by building', reason: 'He said so twice', payload: { profile: 'I learn best by building something small first.' } })).body.data;
        const c = (await chat.post('/api/suggestions', { kind: 'focus_line', text: 'Read DDIA ch. 6', payload: { text: 'Read DDIA ch. 6' } })).body.data;
        expect((await api(user).get('/api/suggestions')).body.data.map((x: { _id: string }) => x._id).sort()).toEqual([a._id, b._id, c._id].sort());
        const res = await api(user).post('/api/suggestions/decide', { accept: [a._id, b._id], dismiss: [c._id] });
        expect(res.body.data).toMatchObject({ accepted: [a._id, b._id], dismissed: [c._id], failed: [] });
        expect((await api(user).get('/api/week')).body.data.targets.map((t: { text: string }) => t.text)).toEqual(['Ship the week UI']);
        expect((await api(user).get('/api/learning/settings')).body.data.agentProfile).toBe('I learn best by building something small first.');
        // Nothing from the agent is left. (On a Sunday the app adds its own review proposals, e.g.
        // "Keep: Ship the week UI" for next week; those are not the agent's.)
        expect((await api(user).get('/api/suggestions')).body.data.filter((x: { proposedBy: string }) => x.proposedBy !== 'app')).toEqual([]);
        // The limit per agent.
        for (let i = 0; i < 10; i++) await chat.post('/api/suggestions', { kind: 'focus_line', text: `Line ${i}`, payload: { text: `Line ${i}` } });
        expect((await chat.post('/api/suggestions', { kind: 'focus_line', text: 'One more', payload: { text: 'One more' } })).status).toBe(409);
    });
});

describe('the Sunday review', () => {
    it('on Sunday it proposes next week from the goal’s pace, once; it stays due until decided', async () => {
        const user = await createTestUser();
        await prisma.user.update({ where: { id: user.id }, data: { timezone: 'Asia/Kolkata' } });
        const sys = await createSubjectRow(user.id, 'System Design');
        await planned(user, sys.id, ['Caching', 'Queues', 'Sharding', 'Consensus']);
        // Sunday 15 Nov 2026, 10:00 in India; a goal 2 weeks after next Monday → 2 topics a week.
        const sunday = new Date('2026-11-15T04:30:00.000Z');
        await api(user).post('/api/goals', { title: 'Offer', deadline: '2026-11-30', subjectIds: [sys.id], milestones: [{ title: 'Mock interview', dueDay: '2026-11-20' }] });

        const first = await proposeWeek(user.id, sunday);
        expect(first.map((s) => s.text)).toEqual(['Finish 1. Caching', 'Finish 2. Queues', 'Mock interview']);
        expect(first.every((s) => s.batch === 'week:2026-11-16')).toBe(true);
        expect((await proposeWeek(user.id, sunday)).map((s) => s._id)).toEqual(first.map((s) => s._id));
        expect(await prisma.suggestion.count({ where: { userId: user.id } })).toBe(3);

        const week = await getWeek(user.id, {}, sunday);
        expect(week.review).toEqual({ due: true, weekStart: '2026-11-16' });
        expect(week.lastWeek.weekStart).toBe('2026-11-09');

        // Accept one: a target for next week exists, so the review is done.
        const ok = await api(user).post(`/api/suggestions/${first[0]!._id}/accept`, {});
        expect(ok.status).toBe(200);
        const target = await prisma.weekTarget.findFirstOrThrow({ where: { userId: user.id } });
        expect(target.weekStart.toISOString().slice(0, 10)).toBe('2026-11-16');
        expect((await getWeek(user.id, {}, sunday)).review.due).toBe(false);
    });

    it('an empty week on a weekday is due; skipping the batch ends it; nothing to propose writes nothing', async () => {
        const user = await createTestUser();
        const wednesday = new Date('2026-11-18T06:00:00.000Z');
        expect(await proposeWeek(user.id, wednesday)).toEqual([]);
        expect((await getWeek(user.id, {}, wednesday)).review).toEqual({ due: true, weekStart: '2026-11-16' });

        const dsa = await createSubjectRow(user.id, 'DSA');
        await planned(user, dsa.id, ['Graphs']);
        await prisma.workSession.create({ data: { userId: user.id, kind: 'study', title: 'BFS', day: new Date('2026-11-17T00:00:00.000Z'), startedAt: new Date('2026-11-17T05:00:00.000Z'), subjectId: dsa.id, source: 'user' } });
        const batch = await proposeWeek(user.id, wednesday);
        expect(batch.map((s) => s.text)).toEqual(['Finish 1. Graphs']);
        expect((await listSuggestions(user.id, {}, wednesday)).map((s) => s._id)).toEqual(batch.map((s) => s._id));
        await api(user).post('/api/suggestions/decide', { dismiss: batch.map((s) => s._id) });
        expect((await getWeek(user.id, {}, wednesday)).review.due).toBe(false);
    });
});
