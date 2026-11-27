// ECOSYSTEM_V2_PLAN stage 16: what is ahead, read from the database for the phone's pictures. The lock picture is now
// (today's next scheduled things), the home picture is ahead (Pick up, Coming up); no estimated time; the goal only
// with their switch; a private event never shows; plain words with titles hidden; an item under a pending Later is
// left out; the picture's key changes when a row passes its time and not otherwise. No model anywhere.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { getAmbient, wallpaperSvg } from '../../src/services/ambient/ambient.service';
import { aheadFor } from '../../src/services/ahead/ahead.service';
import { createTestUser } from '../helpers/auth';
import { api, createSubjectRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import { newSessionKey } from '../../src/services/learningDb/sessions.service';

const TZ = 'Asia/Kolkata';
/** Friday 20 Nov 2026 at hh:mm in Kolkata. */
const at = (hh: number, mm = 0, day = 20) => new Date(Date.UTC(2026, 10, day, hh - 5, mm - 30));
const dbDay = (d: string) => new Date(`${d}T00:00:00Z`);

async function setup() {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
    // A reminder at 7 pm on a task due today; a day-only task today; a late one; one in two days; one with no day and a reminder on Monday.
    const bank = await prisma.todo.create({ data: { userId: user.id, title: 'Call the bank', dueDate: at(18, 0), status: 'pending' } });
    await prisma.reminder.create({ data: { userId: user.id, todoId: bank.id, reminderDate: at(19, 0), status: 'pending' } });
    await prisma.todo.create({ data: { userId: user.id, title: 'Send the invoice', dueDate: at(18, 0), status: 'pending' } });
    await prisma.todo.create({ data: { userId: user.id, title: 'Pay the rent', dueDate: at(18, 0, 18), status: 'pending' } });
    const gift = await prisma.todo.create({ data: { userId: user.id, title: 'Get a gift for my sister', dueDate: at(18, 0, 22), status: 'pending' } });
    const dentist = await prisma.todo.create({ data: { userId: user.id, title: 'Book the dentist', status: 'pending' } });
    await prisma.reminder.create({ data: { userId: user.id, todoId: dentist.id, reminderDate: at(9, 0, 23), status: 'pending' } });
    // An event thread on Thursday at 3 pm; a private one tomorrow (never on a screen).
    const now = at(14, 0);
    await prisma.buddyThread.create({ data: { userId: user.id, title: 'Interview at Acme', keywords: ['interview'], stage: 'active', event: true, eventMinute: 15 * 60, lookAgainOn: dbDay('2026-11-26'), lastSaidAt: now, firstDay: dbDay('2026-11-19') } });
    await prisma.buddyThread.create({ data: { userId: user.id, title: 'Biopsy results', keywords: ['biopsy'], stage: 'active', event: true, sensitive: true, lookAgainOn: dbDay('2026-11-21'), lastSaidAt: now, firstDay: dbDay('2026-11-19') } });
    // A practice problem left unsolved on Tuesday, with where they stopped.
    const session = await prisma.workSession.create({
        data: { userId: user.id, key: 's_test_3sum:1', kind: 'practice', day: dbDay('2026-11-17'), startedAt: at(20, 30, 17), endedAt: at(21, 15, 17), minutes: 45, title: '3Sum', problem: '3Sum', nextStep: 'has the two-pointer idea; duplicates still break it', url: 'https://leetcode.com/problems/3sum/', source: 'agent', updatedAt: at(21, 15, 17) },
    });
    // A goal (private by default on the pictures).
    await prisma.goal.create({ data: { userId: user.id, title: 'Backend offer by May', deadline: dbDay('2027-04-30') } });
    return { user, now, gift, dentist, session };
}

describe('what is ahead on the phone (stage 16)', () => {
    it('the lock’s rows, Pick up and Coming up from their data; a private event never shows; no estimated time anywhere', async () => {
        const { user, now } = await setup();
        const a = await getAmbient(user.id, now);
        expect(a.today?.map((r) => [r.at, r.text])).toEqual([
            ['7 pm', 'Call the bank'],
            ['', 'Send the invoice'],
            ['late', 'Pay the rent'],
        ]);
        expect(a.pickUp).toMatchObject({ text: '3Sum', detail: 'has the two-pointer idea; duplicates still break it' });
        expect(a.comingUp?.map((r) => [r.at, r.text])).toEqual([
            ['Sun', 'Get a gift for my sister'],
            ['Mon 9 am', 'Book the dentist'],
            ['Thu 3 pm', 'Interview at Acme'],
        ]);
        expect(JSON.stringify(a)).not.toContain('Biopsy');
        const lock = wallpaperSvg(a, 1080, 2340, 'dark', 'lock');
        const home = wallpaperSvg(a, 1080, 2340, 'dark', 'home');
        expect(lock).toContain('>Call the bank<');
        expect(home).toContain('>3Sum<');
        expect(home).toContain('>Get a gift for my sister<');
        expect(home).not.toContain('Call the bank'); // nothing on both screens
        expect(lock + home).not.toMatch(/\d+ min</);
    });

    it('the goal only with their switch; hidden titles are plain words; a pending Later leaves its item out', async () => {
        const { user, now, gift } = await setup();
        const goalSeen = async () => (await getAmbient(user.id, now)).goal;
        expect(await goalSeen()).toBeNull();
        expect(wallpaperSvg(await getAmbient(user.id, now), 1080, 2340, 'dark', 'lock')).not.toContain('days to');
        expect((await api(user).patch('/api/buddy/settings', { goalOnScreens: true })).status).toBe(200);
        expect(await goalSeen()).toMatchObject({ title: 'Backend offer by May' });
        expect(wallpaperSvg(await getAmbient(user.id, now), 1080, 2340, 'dark', 'lock')).toContain('days to Backend offer by May');
        expect((await api(user).patch('/api/buddy/settings', { goalOnScreens: false })).status).toBe(200);
        const plain = await getAmbient(user.id, now, { titles: false });
        expect(plain.today?.map((r) => r.text)).toEqual(['A reminder', 'A task', 'A task']);
        expect(plain.pickUp).toMatchObject({ text: 'Something you were working on' });
        expect(JSON.stringify([plain.today, plain.pickUp, plain.comingUp])).not.toMatch(/bank|invoice|3Sum|gift|dentist|Acme/);
        // Later on the gift (stage 19's row): off Coming up until its time.
        await prisma.buddyReminder.create({ data: { userId: user.id, text: 'Get a gift for my sister', at: at(20, 30), refKind: 'tk', refId: gift.id, origin: 'later' } });
        expect((await aheadFor(user.id, now, { aheadMax: 9 })).comingUp.map((r) => r.text)).not.toContain('Get a gift for my sister');
    });

    it('Pick up shows only the newest session’s own step: a later session on the topic replaces or ends it (TOOL_ACCESS_PLAN §13.1)', async () => {
        const user = await createTestUser();
        const net = await createSubjectRow(user.id, 'Networks');
        const [web] = (await api(user).post(`/api/subjects/${net.id}/path`, { titles: ['How the web works'] })).body.data.path.topics as Array<{ _id: string }>;
        const { token } = await createTestToken(user);
        const chat = asAgent(token, 'study-chat');
        const later = new Date(Date.now() + 2 * 3600_000);
        const pickUp = async () => (await aheadFor(user.id, later)).leftOff.map((r) => [r.text, r.detail]);

        const first = newSessionKey(new Date(Date.now() - 2 * 3600_000));
        const stopped = await chat.put(`/api/sessions/by-key/${first}`, { topicId: web!._id, title: 'DNS and routing', topicStatus: 'in_progress', nextStep: 'Open questions on telecom circles' });
        expect(stopped.body.data.staleStep).toBeNull();
        expect(await pickUp()).toEqual([['How the web works', 'Open questions on telecom circles']]);

        // The next session studies that part and sends no step: the old words are not its own, so no Pick up; the answer asks.
        const second = newSessionKey(new Date(Date.now() - 60 * 60_000));
        const again = await chat.put(`/api/sessions/by-key/${second}`, { topicId: web!._id, title: 'Telecom circles, then peering' });
        expect(again.body.data.staleStep).toBe('Open questions on telecom circles');
        expect(await pickUp()).toEqual([]);

        // A new step: that one shows, nothing is stale; "" clears it, and the topic's step with it.
        const step = await chat.put(`/api/sessions/by-key/${second}`, { nextStep: 'Peering and undersea cables' });
        expect(step.body.data.staleStep).toBeNull();
        expect(await pickUp()).toEqual([['How the web works', 'Peering and undersea cables']]);
        const cleared = await chat.put(`/api/sessions/by-key/${second}`, { nextStep: '' });
        expect(cleared.body.data.topic).toMatchObject({ nextStep: null });
        expect(cleared.body.data.staleStep).toBeNull();
        expect(await pickUp()).toEqual([]);
    });

    it('the picture’s key changes when a row passes its time, and not otherwise', async () => {
        const { user, now } = await setup();
        const k1 = (await getAmbient(user.id, now)).key;
        expect((await getAmbient(user.id, new Date(now.getTime() + 60_000))).key).toBe(k1);
        // Past 7 pm: the bank's reminder has passed (it rang; it is not silent), so the rows change.
        const later = (await getAmbient(user.id, at(19, 5))).key;
        expect(later).not.toBe(k1);
    });
});
