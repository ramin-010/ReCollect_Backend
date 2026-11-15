// The decision journal (LOOP_COMPLETE_SPEC 4.2): log, list, look again on its day, answer once;
// agents logged and undone; the brief shows what is due and a project's last decisions.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { lookAgainOf } from '../../src/services/learningDb/decisions.service';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

describe('/api/decisions', () => {
    it('logs with a span or a day, comes due on its day, takes a verdict once, or looks again later', async () => {
        const user = await createTestUser();
        const made = await api(user).post('/api/decisions', { title: 'Postgres over Mongo', why: 'Joins and one store', expect: 'Fewer data bugs', lookAgain: '30d', project: 'Recollect' });
        expect(made.status).toBe(201);
        expect(made.body.data).toMatchObject({ title: 'Postgres over Mongo', status: 'open', project: { key: 'recollect' } });
        expect((await api(user).post('/api/decisions', { title: 'x', why: 'y', lookAgain: 'soon' })).status).toBe(400);
        expect((await api(user).get('/api/decisions?due=1')).body.data).toEqual([]);

        // Its day comes.
        await prisma.decision.update({ where: { id: made.body.data._id }, data: { lookAgainDay: new Date('2020-01-01T00:00:00.000Z') } });
        expect((await api(user).get('/api/decisions?due=1')).body.data.map((d: { title: string }) => d.title)).toEqual(['Postgres over Mongo']);
        const later = await api(user).patch(`/api/decisions/${made.body.data._id}`, { lookAgain: '30d' });
        expect(later.body.data.status).toBe('open');
        await prisma.decision.update({ where: { id: made.body.data._id }, data: { lookAgainDay: new Date('2020-01-01T00:00:00.000Z') } });
        const answered = await api(user).patch(`/api/decisions/${made.body.data._id}`, { verdict: 'right', verdictNote: 'No data bugs since' });
        expect(answered.body.data).toMatchObject({ status: 'reviewed', verdict: 'right', verdictNote: 'No data bugs since', reviewedAt: expect.any(String) });
        expect((await api(user).get('/api/decisions?due=1')).body.data).toEqual([]);
        expect((await api(user).get('/api/decisions?project=recollect')).body.data).toHaveLength(1);
    });

    it('an agent logs and changes one (logged, undone); the brief shows due ones and the project’s last two', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'build-chat');
        const made = await chat.post('/api/decisions', { title: 'Hooks over a wrap-up tool', why: 'Capture must not depend on a model remembering', lookAgain: '6w', project: 'second_brain' });
        expect(made.status).toBe(201);
        expect(await prisma.decision.findUniqueOrThrow({ where: { id: made.body.data._id } })).toMatchObject({ createdBy: 'agent', agentName: 'build-chat' });
        await chat.patch(`/api/decisions/${made.body.data._id}`, { expect: 'Every coding session logged' });
        const edits = await prisma.agentEdit.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        expect(edits.map((e) => e.kind)).toEqual(['decision_create', 'decision_update']);
        expect((await api(user).post(`/api/agent/edits/${edits[1]!.id}/undo`)).status).toBe(200);
        expect((await prisma.decision.findUniqueOrThrow({ where: { id: made.body.data._id } })).expect).toBeNull();

        const brief = (await chat.get('/api/brief?project=second_brain')).body.data;
        expect(brief.decisions.project).toEqual([{ title: 'Hooks over a wrap-up tool', why: 'Capture must not depend on a model remembering', day: expect.any(String) }]);
        expect(brief.decisions.due).toEqual([]);
        expect((await api(user).post(`/api/agent/edits/${edits[0]!.id}/undo`)).status).toBe(200);
        expect(await prisma.decision.count({ where: { userId: user.id } })).toBe(0);
    });

    it('look-again spans: days, weeks, months; a past day is refused', () => {
        expect(lookAgainOf('30d', '2026-11-14' as never)).toBe('2026-12-14');
        expect(lookAgainOf('6w', '2026-11-14' as never)).toBe('2026-12-26');
        expect(lookAgainOf('2027-01-01', '2026-11-14' as never)).toBe('2027-01-01');
        expect(() => lookAgainOf('2026-11-01', '2026-11-14' as never)).toThrow(/after today/);
    });
});
