// GET /api/topics/statuses: the Docs library's status column in one call (Docs round, 2026-11-14).
import { describe, expect, it } from 'vitest';

import { prisma } from '../../src/db/prisma';
import { addDays, today as todayIn } from '../../src/services/learning';
import { api, createChainRows, createLearner, createSubjectRow, createTopicRow } from '../helpers/learning';

const IST = 'Asia/Kolkata';

describe('GET /api/topics/statuses', () => {
    it('one row per live topic with the doc page’s next action; archived topics and other users are left out', async () => {
        const user = await createLearner(IST);
        const other = await createLearner(IST);
        const s = await createSubjectRow(user.id);
        const today = todayIn(IST);

        const unscheduled = await createTopicRow(user.id, s.id, 'Tries');
        const due = await createTopicRow(user.id, s.id, 'Heaps');
        await createChainRows(user.id, { topicId: due.topic.id }, addDays(today, -1));
        const waiting = await createTopicRow(user.id, s.id, 'Graphs');
        await createChainRows(user.id, { topicId: waiting.topic.id }, today);
        const mastered = await createTopicRow(user.id, s.id, 'Sorting');
        await createChainRows(user.id, { topicId: mastered.topic.id }, addDays(today, -30), {
            1: { status: 'done', completedAt: new Date() },
            2: { status: 'done', completedAt: new Date() },
            3: { status: 'done', completedAt: new Date() },
            4: { status: 'done', completedAt: new Date() },
        });
        const archived = await createTopicRow(user.id, s.id, 'Old');
        await prisma.topic.update({ where: { id: archived.topic.id }, data: { isArchived: true } });
        const otherSubject = await createSubjectRow(other.id);
        await createTopicRow(other.id, otherSubject.id, 'Not mine');

        const res = await api(user).get('/api/topics/statuses');
        expect(res.status).toBe(200);
        const byDoc = new Map(res.body.data.map((r: { docId: string }) => [r.docId, r]));
        expect(res.body.data).toHaveLength(4);

        expect(byDoc.get(unscheduled.doc.id)).toMatchObject({ state: 'start', next: null, inDays: null, done: 0, total: 0, subjectId: s.id });
        expect(byDoc.get(due.doc.id)).toMatchObject({ state: 'due', inDays: 0, next: { cycleNumber: 1, scheduledFor: today }, done: 0, total: 4 });
        expect(byDoc.get(waiting.doc.id)).toMatchObject({ state: 'early', inDays: 1, next: { cycleNumber: 1, scheduledFor: addDays(today, 1) } });
        expect(byDoc.get(mastered.doc.id)).toMatchObject({ state: 'completed', next: null, done: 4, total: 4 });
        expect(byDoc.has(archived.doc.id)).toBe(false);
    });

    it('an empty list for a user with no topics', async () => {
        const user = await createLearner(IST);
        const res = await api(user).get('/api/topics/statuses');
        expect([res.status, res.body.data]).toEqual([200, []]);
    });
});
