// ECOSYSTEM_V2_PLAN stage 20: what happened after the buddy's words showed, written by code for the day just ended.
// Each outcome from seeded days (acted on a pick-up nudge, a task ticked, a thumb, a Later, an answered question, none);
// a line withdrawn before its hours is not counted; a second run writes nothing twice.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { recordOutcomes } from '../../src/services/buddy/outcomes';
import { createTestUser } from '../helpers/auth';

const TZ = 'Asia/Kolkata';
const at = (hhmm: string, day = '19') => new Date(`2026-11-${day}T${hhmm}:00+05:30`);
const DAY = new Date('2026-11-19T00:00:00Z');
const line = (from: string, until: string, text: string, refs: string[] = []) => ({ slot: 'evening', from, until, text, form: 'push', lockOk: true, sourceId: null, ...(refs.length ? { refs } : {}) });

describe('the quiet record (stage 20)', () => {
    it('acted, ticked, a thumb, a Later, an answer, none; a line withdrawn before its hours is not counted; once only', async () => {
        const user = await createTestUser();
        await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
        const sum = await prisma.workSession.create({ data: { userId: user.id, key: 's_o1', kind: 'practice', day: new Date('2026-11-18T00:00:00Z'), startedAt: at('21:00', '18'), title: '3Sum', problem: '3Sum', source: 'agent' } });
        const invoice = await prisma.todo.create({ data: { userId: user.id, title: 'Send the invoice', status: 'pending' } });
        const gift = await prisma.todo.create({ data: { userId: user.id, title: 'Buy the gift', status: 'complete', completedAt: at('12:00') } });
        const passport = await prisma.todo.create({ data: { userId: user.id, title: 'Renew passport', status: 'pending' } });
        const step = await prisma.buddyDay.create({
            data: {
                userId: user.id,
                day: DAY,
                kind: 'night',
                lines: [
                    line('20:30', '22:00', '3Sum: finish it tonight?', [`pu_${sum.id}`]),
                    line('18:00', '19:00', 'The invoice is due today.', [`tk_${invoice.id}`]),
                    line('15:00', '16:00', 'Gift shops close early on Saturday.', [`tk_${gift.id}`]),
                    line('08:00', '09:00', 'One review before work.'),
                    line('22:30', '23:30', 'Passport this week.', [`tk_${passport.id}`]),
                ],
                model: 'claude-opus-5-5',
                createdAt: at('05:00'),
            },
        });
        // 3Sum picked up at 20:50 (a new session on the same problem); the invoice ticked at 18:40; a thumb down on the
        // morning line; a Later on the passport at 22:40; the gift was bought before its line's hours (withdrawn).
        await prisma.workSession.create({ data: { userId: user.id, key: 's_o2', kind: 'practice', day: DAY, startedAt: at('20:50'), title: '3Sum', problem: '3sum', source: 'agent' } });
        await prisma.todo.update({ where: { id: invoice.id }, data: { status: 'complete', completedAt: at('18:40') } });
        await prisma.buddyFeedback.create({ data: { userId: user.id, buddyDayId: step.id, target: '08:00', verdict: 'less', createdAt: at('08:10') } });
        await prisma.buddyReminder.create({ data: { userId: user.id, text: 'Renew passport', at: at('09:00', '20'), refKind: 'tk', refId: passport.id, origin: 'later', createdAt: at('22:40') } });
        // A question shown and answered at 19:30.
        await prisma.buddyAsk.create({ data: { userId: user.id, text: 'A run tonight?', fromAt: at('18:00'), untilAt: at('22:00'), state: 'answered', shownOn: ['lock'], firstShownAt: at('18:05'), answeredAt: at('19:30'), answer: 'done' } });

        const wrote = await recordOutcomes(user.id, '2026-11-19' as never, TZ);
        const rows = await prisma.buddyOutcome.findMany({ where: { userId: user.id }, orderBy: { sourceKey: 'asc' } });
        expect(wrote).toBe(6);
        const by = (text: string) => rows.find((r) => r.text === text);
        expect([by('3Sum: finish it tonight?')?.outcome, by('3Sum: finish it tonight?')?.minutes]).toEqual(['acted', 20]);
        expect([by('The invoice is due today.')?.outcome, by('The invoice is due today.')?.minutes]).toEqual(['acted', 40]);
        expect(by('One review before work.')?.outcome).toBe('thumb_down');
        expect(by('Passport this week.')?.outcome).toBe('later');
        expect(by('Gift shops close early on Saturday.')).toBeUndefined();
        expect([by('A run tonight?')?.shown, by('A run tonight?')?.outcome, by('A run tonight?')?.minutes]).toEqual(['question', 'answered', 85]);
        expect(rows.some((r) => r.shown === 'later' && r.outcome === 'none')).toBe(true);
        expect(await recordOutcomes(user.id, '2026-11-19' as never, TZ)).toBe(0);
    });
});
