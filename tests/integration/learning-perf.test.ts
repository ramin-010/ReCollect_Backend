// LEARNING_SPEC §2 performance target: GET /api/today < 300 ms with 2k revisions and 500 notes on
// local Postgres. The assertion has headroom (machines vary); the measured time is printed.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { addDays, REVISION_INTERVALS, today as todayIn } from '../../src/services/learning';
import { api, createLearner, createSubjectRow, d } from '../helpers/learning';

describe('GET /api/today performance', () => {
    it('2000 revisions + 500 quick notes', async () => {
        const user = await createLearner();
        const today = todayIn('Asia/Kolkata');
        const subjects = await Promise.all([1, 2, 3, 4, 5].map((i) => createSubjectRow(user.id, `S${i}`)));
        const captureIds: string[] = [];
        const captures = Array.from({ length: 500 }, (_, i) => ({ id: `perfcap${i}`, userId: user.id, content: `note ${i}`, subjectId: subjects[i % 5]!.id }));
        await prisma.capture.createMany({ data: captures });
        captureIds.push(...captures.map((c) => c.id));
        await prisma.revision.createMany({
            data: captureIds.flatMap((captureId, i) =>
                REVISION_INTERVALS.map((interval, k) => ({
                    userId: user.id,
                    captureId,
                    cycleNumber: k + 1,
                    intervalDays: interval,
                    scheduledFor: d(addDays(today, interval - (i % 30))),
                    status: k === 0 && i % 3 === 0 ? ('done' as const) : ('pending' as const),
                    completedAt: k === 0 && i % 3 === 0 ? new Date() : null,
                }))
            ),
        });
        await prisma.quickNote.createMany({
            data: Array.from({ length: 500 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, userId: user.id, content: `quick ${i}` })),
        });

        await api(user).get('/api/today'); // warm-up
        const t0 = performance.now();
        const res = await api(user).get('/api/today');
        const ms = performance.now() - t0;
        console.log(`[perf] GET /api/today with 2000 revisions + 500 notes: ${ms.toFixed(0)} ms`);
        expect(res.status).toBe(200);
        expect(res.body.data.quickNotes).toHaveLength(500);
        expect(res.body.data.revisions.totalDue).toBeGreaterThan(100);
        expect(ms).toBeLessThan(1000);
    });
});
