// ECOSYSTEM_V2_PLAN stage 19: Later on the widget's card. The time rules (before and after 17:00, their usual evening
// start, 22:30, the item's own day, tomorrow's hours); one pending Later per item; the item off the card and the home
// picture until its time, then one of the lock's rows (and a task's own row not beside it); words resting on it hidden;
// the card's order; the route for the phone's token; the day's JSON carries the card only from app 0.7.0.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { cardOf, laterAt, laterLabel, pickCard, setLater, tapMoment } from '../../src/services/ahead/later';
import { aheadFor } from '../../src/services/ahead/ahead.service';
import { getAmbient } from '../../src/services/ambient/ambient.service';
import type { AheadRow } from '../../src/services/ahead/aheadRules';
import { createTestUser } from '../helpers/auth';
import { asAgent, createTestToken } from '../helpers/agent';

const TZ = 'Asia/Kolkata';
/** Their clock (Kolkata), November 2026 (Fri 20). */
const at = (hhmm: string, day = '20') => new Date(`2026-11-${day}T${hhmm}:00+05:30`);
const row = (over: Partial<AheadRow>): AheadRow => ({ id: 'tk_1', kind: 'task', text: 'Book the dentist', at: 'Mon', when: null, day: '2026-11-23' as AheadRow['day'], ...over });

describe('when a Later brings it back (pure)', () => {
    it('before 17:00: tonight at their usual start (else 19:30), at least an hour away, never after 22:30; else tomorrow (09:00, or their evening for a left-off item); never past its own day', () => {
        const t = (now: Date, kind: AheadRow['kind'] = 'task', ownDay: string | null = '2026-11-23', usual: string | null = null) => laterAt({ now, tz: TZ, kind, ownDay: ownDay as AheadRow['day'] | null, usual });
        expect(t(at('11:10'))).toEqual(at('19:30'));
        expect(t(at('11:10'), 'pickup', null, '20:45')).toEqual(at('20:45'));
        expect(t(at('16:50'), 'task', '2026-11-23', '17:30')).toEqual(at('17:50'));
        expect(t(at('17:05'))).toEqual(at('09:00', '21'));
        expect(t(at('18:00'), 'pickup', null, '20:45')).toEqual(at('20:45', '21'));
        // A task due today: tonight if there is time; after 17:00 none is left before its own day.
        expect(t(at('11:10'), 'task', '2026-11-20')).toEqual(at('19:30'));
        expect(t(at('17:30'), 'task', '2026-11-20')).toBeNull();
        expect(laterLabel(at('20:30'), at('11:00'), TZ)).toBe('Tonight · 8:30 pm');
        expect(laterLabel(at('09:00', '21'), at('18:00'), TZ)).toBe('Tomorrow · 9 am');
    });

    it('the card: the item Buddy’s line rests on; else coming up within 2 days; else the left-off item; else the nearest ahead; else today’s next', () => {
        const pick = (o: Partial<Parameters<typeof pickCard>[0]>) => pickCard({ today: [], comingUp: [], leftOff: [], lineRefs: [], todayDay: '2026-11-20' as AheadRow['day'], ...o })?.id ?? null;
        const soon = row({ id: 'tk_soon', day: '2026-11-22' as AheadRow['day'], at: 'Sun' });
        const far = row({ id: 'tk_far', day: '2026-11-26' as AheadRow['day'], at: 'Thu' });
        const left = row({ id: 'pu_1', kind: 'pickup', text: '3Sum', at: '', detail: 'duplicates' });
        const now = row({ id: 'rm_1', kind: 'reminder', text: 'Call the bank', at: '7 pm', day: '2026-11-20' as AheadRow['day'] });
        expect(pick({ comingUp: [soon], leftOff: [left], lineRefs: ['pu_1'] })).toBe('pu_1');
        expect(pick({ comingUp: [soon, far], leftOff: [left] })).toBe('tk_soon');
        expect(pick({ comingUp: [far], leftOff: [left] })).toBe('pu_1');
        expect(pick({ comingUp: [far], today: [now] })).toBe('tk_far');
        expect(pick({ today: [now] })).toBe('rm_1');
        expect(pick({})).toBeNull();
        const card = cardOf(left, { now: at('11:00'), tz: TZ, usual: '20:45', appUrl: 'https://re-collect.in' });
        expect(card).toMatchObject({ label: 'Pick up', title: '3Sum', detail: 'duplicates', link: null, later: { label: 'Tonight · 8:45 pm' } });
        // The label says when; the line under the title never says it again.
        expect(cardOf({ ...far, docId: null }, { now: at('11:00'), tz: TZ, usual: null, appUrl: null })).toMatchObject({ label: 'Coming up · Thu', detail: '' });
        expect(cardOf(now, { now: at('11:00'), tz: TZ, usual: null, appUrl: null })).toMatchObject({ label: 'Today · 7 pm', detail: '' });
    });

    it('a tap kept on the phone while offline is timed from when it was made, unless that time has passed', () => {
        expect(tapMoment(at('17:20'), at('16:50'))).toEqual(at('16:50'));
        expect(tapMoment(at('17:20'), null)).toEqual(at('17:20'));
        // From the future (a phone's clock ahead) or more than a day old: the server's now.
        expect(tapMoment(at('17:20'), at('18:00'))).toEqual(at('17:20'));
        expect(tapMoment(at('17:20'), at('17:00', '19'))).toEqual(at('17:20'));
    });
});

describe('Later on their data (stage 19)', () => {
    it('one silent reminder of Buddy’s on the item; off the lists until its time, then a lock row (the task’s own row not beside it); the same tap again changes nothing', async () => {
        const user = await createTestUser();
        await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
        const task = await prisma.todo.create({ data: { userId: user.id, title: 'Send the invoice', dueDate: at('18:00'), status: 'pending' } });
        const id = `tk_${task.id}`;
        expect((await aheadFor(user.id, at('11:00'))).today.map((r) => r.id)).toContain(id);
        const r = await setLater(user.id, id, at('11:00'));
        expect(r).toMatchObject({ id, at: at('19:30').toISOString(), label: 'Tonight · 7:30 pm' });
        expect(await setLater(user.id, id, at('11:05'))).toEqual(r);
        const rows = await prisma.buddyReminder.findMany({ where: { userId: user.id } });
        expect(rows.map((x) => [x.origin, x.refKind, x.refId, x.text, x.status])).toEqual([['later', 'tk', task.id, 'Send the invoice', 'pending']]);
        // Until then off the lists; at its time one of the lock's rows, once.
        expect((await aheadFor(user.id, at('12:00'))).today.map((r2) => r2.id)).not.toContain(id);
        const evening = await aheadFor(user.id, at('19:31'));
        expect(evening.today.map((r2) => `${r2.at} ${r2.text}`)).toEqual(['7:30 pm Send the invoice']);
        // Something not on their day: refused plainly.
        await expect(setLater(user.id, 'tk_nope', at('11:00'))).rejects.toMatchObject({ statusCode: 404 });
        await expect(setLater(user.id, 'zz_1', at('11:00'))).rejects.toMatchObject({ statusCode: 400 });
    });

    it('a tap sent late (offline): tonight as the button said when made before 17:00; from now when that time has passed', async () => {
        const user = await createTestUser();
        await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
        const task = await prisma.todo.create({ data: { userId: user.id, title: 'Renew the passport', dueDate: at('18:00', '23'), status: 'pending' } });
        const id = `tk_${task.id}`;
        // Tapped at 16:50 ("Tonight · 7:30 pm"), sent at 17:20: still tonight, not tomorrow morning.
        expect(await setLater(user.id, id, at('17:20'), at('16:50'))).toMatchObject({ at: at('19:30').toISOString(), label: 'Tonight · 7:30 pm' });
        await prisma.buddyReminder.deleteMany({ where: { userId: user.id } });
        // Tapped at 16:50, sent at 20:00 (the 19:30 it said has passed): the rules from now, tomorrow 09:00.
        expect(await setLater(user.id, id, at('20:00'), at('16:50'))).toMatchObject({ at: at('09:00', '21').toISOString(), label: 'Tomorrow · 9 am' });
    });

    it('the route for the phone’s token; the day’s JSON carries the card only from app 0.7.0; card=0 leaves it off the home picture', async () => {
        const user = await createTestUser();
        await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
        const task = await prisma.todo.create({ data: { userId: user.id, title: 'Get a gift for my sister', dueDate: new Date(Date.now() + 2 * 86_400_000), status: 'pending' } });
        const phone = asAgent((await createTestToken(user, ['ambient'], 'Phone app')).token);
        const old = await phone.get('/api/ambient/widget?app=0.6.0');
        expect(old.body.data.next).toBeUndefined();
        const day = await phone.get('/api/ambient/widget?app=0.7.0');
        expect(day.body.data.next).toMatchObject({ id: `tk_${task.id}`, title: 'Get a gift for my sister', later: { label: expect.stringMatching(/^(Tonight|Tomorrow) · /) } });
        const a = await getAmbient(user.id, new Date(), { app: '0.7.0', withoutCard: true });
        expect(a.comingUp?.map((r) => r.id)).not.toContain(`tk_${task.id}`);
        // The phone sends when the tap was made (app 0.7.0).
        const tapped = await phone.post('/api/ambient/later', { id: `tk_${task.id}`, tappedAt: new Date().toISOString() });
        expect(tapped.status).toBe(200);
        expect(tapped.body.data).toMatchObject({ id: `tk_${task.id}` });
        expect((await phone.post('/api/ambient/later', { id: 'x' })).status).toBe(400);
        expect((await phone.post('/api/ambient/later', { id: `tk_${task.id}`, tappedAt: 'yesterday' })).status).toBe(400);
    });
});

/** The owner's word (11-21): their own reminder keeps its time; a Later comes back at the time shown, once; checked directly. */
describe('Later, the duplicate cases (11-21)', () => {
    const APP = { app: '0.7.1' };
    const words = (a: Awaited<ReturnType<typeof getAmbient>>, re: RegExp) => ({
        lockRows: (a.today ?? []).filter((r) => re.test(r.text)).length,
        line: re.test(a.line?.text ?? '') ? 1 : 0,
        comingUp: (a.comingUp ?? []).filter((r) => re.test(r.text)).length,
        pickUp: re.test(a.pickUp?.text ?? '') ? 1 : 0,
        card: re.test(a.next?.title ?? '') ? 1 : 0,
    });

    it('their own reminder (and its alarm) keep their time: Later only takes it off the widget until then; never a second reminder', async () => {
        const { createTodoReminder } = await import('../../src/services/reminders/reminders.service');
        const { upcomingAlarms } = await import('../../src/services/ambient/ambient.service');
        const user = await createTestUser();
        await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
        const task = await prisma.todo.create({ data: { userId: user.id, title: 'Call the bank', status: 'pending' } });
        const mine = await createTodoReminder({ userId: user.id, todoId: task.id, reminderDate: at('21:00'), title: 'Call the bank' });
        const before = await getAmbient(user.id, at('11:00'), APP);
        // The card is the bank (today's next thing), and its Later reads their own reminder's time.
        expect(before.next).toMatchObject({ title: 'Call the bank', later: { label: 'Your reminder · 9 pm', at: at('21:00').toISOString() } });
        const tapped = await setLater(user.id, before.next!.id, at('11:00'), at('11:00'), new Date(before.next!.later!.at));
        expect(tapped).toMatchObject({ at: at('21:00').toISOString(), label: 'Your reminder · 9 pm' });
        // Tapped again (a phone that sends twice), and on the task's own id: still one, no reminder of Buddy's.
        await setLater(user.id, before.next!.id, at('11:02'));
        await setLater(user.id, `tk_${task.id}`, at('11:03'));
        const buddy = await prisma.buddyReminder.findMany({ where: { userId: user.id } });
        expect(buddy.filter((b) => b.origin === 'later')).toHaveLength(0);
        // Their reminder: the same time, still pending, still rung by the phone.
        const after = await prisma.reminder.findUniqueOrThrow({ where: { id: mine.id } });
        expect([after.reminderDate.toISOString(), after.status]).toEqual([at('21:00').toISOString(), 'pending']);
        expect((await upcomingAlarms(user.id, at('11:05'))).map((x) => x.when)).toEqual([at('21:00').toISOString()]);
        // On the screens: the lock's row once (their own), not on the widget or the home picture until then.
        const later = await getAmbient(user.id, at('11:05'), APP);
        expect(words(later, /call the bank/i)).toEqual({ lockRows: 1, line: 0, comingUp: 0, pickUp: 0, card: 0 });
        expect((later.today ?? []).find((r) => /call the bank/i.test(r.text))?.at).toBe('9 pm');
    });

    it('their own silent reminder the day before its day: once at its time too (its row stays on the lock two hours, Home and the widget leave it out), then ahead again', async () => {
        const { createTodoReminder } = await import('../../src/services/reminders/reminders.service');
        const user = await createTestUser();
        await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
        const task = await prisma.todo.create({ data: { userId: user.id, title: 'Submit the form', dueDate: at('18:00', '21'), status: 'pending' } });
        await createTodoReminder({ userId: user.id, todoId: task.id, reminderDate: at('21:00'), title: 'Submit the form', silent: true });
        const id = `tk_${task.id}`;
        const before = await getAmbient(user.id, at('11:00'), APP);
        expect(before.next).toMatchObject({ id, later: { label: 'Your reminder · 9 pm' } });
        await setLater(user.id, id, at('11:00'), at('11:00'), new Date(before.next!.later!.at));
        const form = /submit the form/i;
        // Until 21:00 their reminder's row is on the lock; nothing on Home or the widget.
        expect(words(await getAmbient(user.id, at('12:00'), APP), form)).toEqual({ lockRows: 1, line: 0, comingUp: 0, pickUp: 0, card: 0 });
        // A silent reminder's row stays two hours after its time: still once.
        expect(words(await getAmbient(user.id, at('21:30'), APP), form)).toEqual({ lockRows: 1, line: 0, comingUp: 0, pickUp: 0, card: 0 });
        // Then ahead again (its day is tomorrow).
        expect(words(await getAmbient(user.id, at('23:10'), APP), form)).toMatchObject({ lockRows: 0, comingUp: 1 });
    });

    it('a Later comes back at the time shown, once: its row on the lock (or Buddy’s line about it instead), never on the home screen; two hours on it is ahead again', async () => {
        const user = await createTestUser();
        await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
        await prisma.buddyState.upsert({ where: { userId: user.id }, create: { userId: user.id, enabled: true, loop: true }, update: { enabled: true, loop: true } });
        const gift = await prisma.todo.create({ data: { userId: user.id, title: 'Get a gift for my sister', dueDate: at('18:00', '22'), status: 'pending' } });
        const id = `tk_${gift.id}`;
        const morning = await getAmbient(user.id, at('11:00'), APP);
        expect(morning.next).toMatchObject({ id, later: { label: 'Tonight · 7:30 pm' } });
        // The time the button showed is the time it comes back.
        expect(await setLater(user.id, id, at('11:00'), at('11:00'), new Date(morning.next!.later!.at))).toMatchObject({ at: at('19:30').toISOString() });
        // The item's title, or Buddy's words about it ("the gift for Sunday").
        const gone = /\bgift\b/i;
        expect(words(await getAmbient(user.id, at('12:00'), APP), gone)).toEqual({ lockRows: 0, line: 0, comingUp: 0, pickUp: 0, card: 0 });
        // Back at 19:30: once, as its row on the lock screen.
        expect(words(await getAmbient(user.id, at('19:35'), APP), gone)).toEqual({ lockRows: 1, line: 0, comingUp: 0, pickUp: 0, card: 0 });
        // With Buddy's line about it from 19:30 (the pulse or the night wrote it), the line stands in for the row.
        await prisma.buddyDay.create({
            data: {
                userId: user.id,
                day: new Date('2026-11-20T00:00:00Z'),
                kind: 'pulse',
                lines: [{ slot: 'evening', from: '19:30', until: '21:00', text: 'The gift for Sunday: the shops near you are open till 9 tonight.', form: 'push', lockOk: true, sourceId: null, refs: [id] }],
                model: 'seeded',
                createdAt: at('11:10'),
            },
        });
        const back = await getAmbient(user.id, at('19:35'), APP);
        expect(back.line?.text).toMatch(/^The gift for Sunday/);
        expect(words(back, gone)).toEqual({ lockRows: 0, line: 1, comingUp: 0, pickUp: 0, card: 0 });
        // The plain twin (no words of Buddy's: quiet hours, the line's end) has the row back.
        expect((back.todayPlain ?? []).filter((r) => gone.test(r.text))).toHaveLength(1);
        // Two hours past its time it is no longer on the lock: ahead again, until Sunday.
        expect(words(await getAmbient(user.id, at('21:40'), APP), gone)).toMatchObject({ lockRows: 0, comingUp: 1 });
    });

    it('the time shown is kept only while it holds; Buddy’s own reminder is moved, not copied', async () => {
        const user = await createTestUser();
        await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
        const task = await prisma.todo.create({ data: { userId: user.id, title: 'Renew the passport', dueDate: at('18:00', '23'), status: 'pending' } });
        expect(await setLater(user.id, `tk_${task.id}`, at('11:00'), at('11:00'), at('20:15'))).toMatchObject({ at: at('20:15').toISOString() });
        await prisma.buddyReminder.deleteMany({ where: { userId: user.id } });
        // A time three days off, or one already past: the rules (tonight 19:30).
        expect(await setLater(user.id, `tk_${task.id}`, at('11:00'), at('11:00'), at('10:00', '23'))).toMatchObject({ at: at('19:30').toISOString() });
        await prisma.buddyReminder.deleteMany({ where: { userId: user.id } });
        expect(await setLater(user.id, `tk_${task.id}`, at('11:00'), at('11:00'), at('09:00'))).toMatchObject({ at: at('19:30').toISOString() });
        await prisma.buddyReminder.deleteMany({ where: { userId: user.id } });
        // One of Buddy's own reminders: moved to the Later's time, still one.
        const own = await prisma.buddyReminder.create({ data: { userId: user.id, text: 'Laundry before the rain', at: at('13:00') } });
        expect(await setLater(user.id, `br_${own.id}`, at('11:00'), at('11:00'), at('19:30'))).toMatchObject({ at: at('19:30').toISOString() });
        const rows = await prisma.buddyReminder.findMany({ where: { userId: user.id } });
        expect(rows.map((r) => [r.text, r.at.toISOString()])).toEqual([['Laundry before the rain', at('19:30').toISOString()]]);
    });

    it('a Later that comes back today starts a pulse (the nudge at its time); one for tomorrow is the night’s', async () => {
        const { pulseDue } = await import('../../src/services/buddy/pulse');
        const user = await createTestUser();
        await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
        await prisma.buddyState.upsert({ where: { userId: user.id }, create: { userId: user.id, enabled: true, loop: true }, update: { enabled: true, loop: true } });
        await prisma.buddyDay.create({ data: { userId: user.id, day: new Date('2026-11-20T00:00:00Z'), kind: 'night', lines: [], model: 'seeded', createdAt: at('05:00') } });
        const gift = await prisma.todo.create({ data: { userId: user.id, title: 'Get a gift for my sister', dueDate: at('18:00', '22'), status: 'pending' } });
        expect(await pulseDue(user.id, at('10:00'))).toMatchObject({ due: false });
        await setLater(user.id, `tk_${gift.id}`, at('11:00'));
        await prisma.buddyReminder.updateMany({ where: { userId: user.id }, data: { createdAt: at('11:00') } });
        expect(await pulseDue(user.id, at('11:05'))).toMatchObject({ due: true, onEvent: true });
        // Tapped after 17:00: it comes back tomorrow at 09:00, which tomorrow's night reads.
        const other = await createTestUser();
        await prisma.user.update({ where: { id: other.id }, data: { timezone: TZ } });
        await prisma.buddyState.upsert({ where: { userId: other.id }, create: { userId: other.id, enabled: true, loop: true }, update: { enabled: true, loop: true } });
        await prisma.buddyDay.create({ data: { userId: other.id, day: new Date('2026-11-20T00:00:00Z'), kind: 'night', lines: [], model: 'seeded', createdAt: at('05:00') } });
        const passport = await prisma.todo.create({ data: { userId: other.id, title: 'Renew the passport', dueDate: at('18:00', '23'), status: 'pending' } });
        await setLater(other.id, `tk_${passport.id}`, at('17:30'));
        await prisma.buddyReminder.updateMany({ where: { userId: other.id }, data: { createdAt: at('17:30') } });
        expect(await pulseDue(other.id, at('18:05'))).toMatchObject({ due: false });
    });
});
