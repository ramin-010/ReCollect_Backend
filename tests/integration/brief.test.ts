// The brief (SYNC_SPINE_SPEC 1.3): one call that says where the user stands; a fresh session key that
// the first checkpoint's minutes come from; a key reused; a project's last session.
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../helpers/auth';
import { api, createSubjectRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

describe('GET /api/brief', () => {
    it('profile, goals, today, next up with its last session and weak spots, recent sessions, a project, a session key', async () => {
        const user = await createTestUser();
        await api(user).patch('/api/learning/settings', { agentProfile: '  Short explanations, then a quiz.  ' });
        const sys = await createSubjectRow(user.id, 'System Design');
        const topics = (await api(user).post(`/api/subjects/${sys.id}/path`, { titles: ['Message queues', 'Sharding'] })).body.data.path.topics;
        await api(user).post('/api/goals', { title: 'SDE offer', deadline: '2027-05-16', subjectIds: [sys.id] });
        const agent = asAgent((await createTestToken(user)).token, 'study-chat');
        await agent.put('/api/sessions/by-key/s_one', { topicId: topics[0]._id, title: 'Outbox, part 1', topicStatus: 'in_progress', weakSpots: ['polling vs CDC'], score: { done: 6, total: 8 } });
        await agent.put('/api/sessions/by-key/cc_build', { kindIfNew: 'build', project: 'second_brain', minutes: 80, title: 'Paths UI', nextStep: 'Hook installer' });

        const res = await agent.get('/api/brief?project=second_brain');
        expect(res.status).toBe(200);
        const b = res.body.data;
        expect(b.now).toMatchObject({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), time: expect.stringMatching(/^\d{2}:\d{2}$/) });
        expect(b.profile).toBe('Short explanations, then a quiz.');
        expect(b.goals).toEqual([expect.objectContaining({ title: 'SDE offer', deadline: '2027-05-16' })]);
        expect(b.today.revisions).toEqual(expect.objectContaining({ planned: 0, done: 0 }));
        expect(b.week).toMatchObject({ targets: [], reviewDue: expect.any(Boolean) });
        expect(b.next).toEqual([
            expect.objectContaining({
                topic: expect.objectContaining({ title: 'Message queues', status: 'in_progress' }),
                lastSession: expect.objectContaining({ title: 'Outbox, part 1', score: { done: 6, total: 8 } }),
                weakSpots: [expect.objectContaining({ text: 'polling vs CDC' })],
            }),
        ]);
        expect(b.recent.map((s: { title: string }) => s.title).sort()).toEqual(['Outbox, part 1', 'Paths UI']);
        expect(b.recall).toEqual({ days: 7, finished: 0, weakTopics: [] });
        expect(b.project).toEqual({ key: 'second_brain', name: 'second_brain', nextStep: 'Hook installer', lastSession: expect.objectContaining({ title: 'Paths UI', minutes: 80 }) });
        expect(b.session.key).toMatch(/^s_[0-9a-z]{12}$/);

        // A key to reuse comes back as it is; a hook-only token can read the brief too.
        expect((await agent.get('/api/brief?key=cc_abc')).body.data.session.key).toBe('cc_abc');
        const hook = asAgent((await createTestToken(user, ['read', 'sessions:write'])).token);
        expect((await hook.get('/api/brief')).status).toBe(200);
        expect((await agent.get('/api/brief?key=has%20space')).status).toBe(400);
    });
});
