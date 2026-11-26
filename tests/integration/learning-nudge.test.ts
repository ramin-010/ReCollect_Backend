// LOOP_V2_SPEC §7: the morning nudge email. A pass (the cron runs one every 15 min) sends learners
// with the nudge on one digest per local day at or after nudgeTime; lastNudgeDay makes it
// idempotent. Outgoing email is the nodemailer mock (tests/helpers/mail.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { addDays } from '../../src/services/learning';
import { runMorningNudgePass } from '../../src/services/learningDb/nudge.service';
import { createTestUser } from '../helpers/auth';
import { createChainRows, createSubjectRow, createTopicRow, d } from '../helpers/learning';
import { clearSentMails, mailsTo, sentMails, setMailFailure } from '../helpers/mail';

const TODAY = '2026-11-14'; // a Saturday
const AT_0830_IST = new Date('2026-11-14T03:00:00Z');
const ago = (n: number) => addDays(TODAY, -n);
const OLD_DONE = new Date('2026-09-01T10:00:00Z');
const dayStr = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);

let k = 0;
/** A user with a deliverable-looking address (reserved domains like .local are never mailed). */
async function person(extra: Record<string, unknown> = {}, email?: string) {
    k += 1;
    const user = await createTestUser({ email: email ?? `nudge${k}@example.org` });
    await prisma.user.update({ where: { id: user.id }, data: { timezone: 'Asia/Kolkata', lastSeenDay: d(ago(1)), ...extra } });
    return { ...user, email: email ?? `nudge${k}@example.org` };
}

/** An overdue capture: cycle 2 due `daysLate` days ago (cycle 1 done in September). */
async function overdue(userId: string, daysLate: number, title = `Note ${daysLate}`) {
    const capture = await prisma.capture.create({ data: { userId, title, content: 'x' } });
    await createChainRows(userId, { captureId: capture.id }, ago(daysLate + 3), { 1: { status: 'done', completedAt: OLD_DONE, scheduledFor: ago(daysLate + 2) } });
    return capture;
}

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT_0830_IST);
    // Tests in a file share the database: earlier tests' users stop getting nudges.
    await prisma.user.updateMany({ data: { nudgeEmailEnabled: false } });
    clearSentMails();
});
afterEach(() => {
    vi.useRealTimers();
    setMailFailure(false);
});

describe('morning nudge', () => {
    it('sends one digest at nudge time (top items, goals, one button); never twice a day; again the next day', async () => {
        const user = await person();
        const dsa = await createSubjectRow(user.id, 'DSA');
        const { topic } = await createTopicRow(user.id, dsa.id, 'Binary search');
        await createChainRows(user.id, { topicId: topic.id }, ago(1)); // cycle 1 due today, goal-linked
        const heaps = await prisma.capture.create({ data: { userId: user.id, title: '<b>Heaps</b> & tries', content: 'x' } });
        await createChainRows(user.id, { captureId: heaps.id }, ago(3)); // cycle 1, 2 days late
        for (const late of [1, 2, 3]) await overdue(user.id, late);
        const goal = await prisma.goal.create({ data: { userId: user.id, title: 'SDE role', deadline: d('2027-06-30') } });
        await prisma.goalSubject.create({ data: { goalId: goal.id, subjectId: dsa.id } });

        vi.setSystemTime(new Date('2026-11-14T02:59:00Z')); // 08:29 IST
        await runMorningNudgePass();
        expect(mailsTo(user.email)).toHaveLength(0);

        vi.setSystemTime(AT_0830_IST);
        const first = await runMorningNudgePass();
        expect(first).toMatchObject({ sent: 1, failed: 0 });
        const [mail] = mailsTo(user.email);
        expect(mail!.subject).toBe('Today: 3 revisions · ~21 min');
        expect(mail!.html).toContain("Today&#39;s plan");
        expect(mail!.html).toContain('Binary search');
        expect(mail!.html).toContain('DSA · cycle 1 · 8 min');
        expect(mail!.html).toContain('&lt;b&gt;Heaps&lt;/b&gt; &amp; tries');
        expect(mail!.html).not.toContain('<b>Heaps</b>');
        expect(mail!.html).toContain('SDE role');
        expect(mail!.html).toContain('228 days left');
        expect(mail!.html).toContain('Open Kaaga');
        expect(mail!.html).toContain('href="http://localhost:3005"');
        expect(mail!.text).toContain('- Binary search (DSA · cycle 1 · 8 min)');
        expect(mail!.text).toContain('- SDE role: 228 days left');
        expect(mail!.text).toContain('Open Kaaga: http://localhost:3005');
        expect(dayStr((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastNudgeDay)).toBe(TODAY);

        vi.setSystemTime(new Date('2026-11-14T03:20:00Z'));
        await runMorningNudgePass();
        vi.setSystemTime(new Date('2026-11-14T17:00:00Z')); // 22:30 IST
        await runMorningNudgePass();
        expect(mailsTo(user.email)).toHaveLength(1);

        vi.setSystemTime(new Date('2026-11-15T03:05:00Z'));
        await runMorningNudgePass();
        expect(mailsTo(user.email)).toHaveLength(2);
        expect(mailsTo(user.email)[1]!.html).toContain('227 days left');
    });

    it('busy week: "Busy week: just 3 things today"', async () => {
        const user = await person({ busyUntil: d(addDays(TODAY, 6)) });
        for (const late of [1, 2, 3, 4, 5]) await overdue(user.id, late);
        await runMorningNudgePass();
        const [mail] = mailsTo(user.email);
        expect(mail!.subject).toBe('Busy week: just 3 things today');
        expect(mail!.html).toContain('Busy week');
        expect(mail!.text).toContain('Just 3 things today, about 15 min. The rest waits.');
    });

    it('comeback after days away: "Welcome back" with at most 5', async () => {
        const user = await person({ lastSeenDay: d(ago(6)), dailyBudgetMin: 120 });
        for (let late = 1; late <= 8; late++) await overdue(user.id, late);
        await runMorningNudgePass();
        const [mail] = mailsTo(user.email);
        expect(mail!.subject).toBe('Today: 5 revisions · ~25 min');
        expect(mail!.text).toContain('Welcome back');
        expect(mail!.text).toContain('+ 2 more in today\'s plan.');
    });

    it('nothing due: "Nothing due today", still with the goals', async () => {
        const user = await person();
        await prisma.goal.create({ data: { userId: user.id, title: 'Ship Recollect v2', deadline: d(TODAY) } });
        await runMorningNudgePass();
        const [mail] = mailsTo(user.email);
        expect(mail!.subject).toBe('Nothing due today');
        expect(mail!.text).toContain('- Ship Recollect v2: Due today');
    });

    it('skips: nudge off, placeholder users, non-learners and reserved addresses; uses the reminder email', async () => {
        const off = await person({ nudgeEmailEnabled: false });
        await overdue(off.id, 1);
        const ghost = await person({ isGhost: true });
        await overdue(ghost.id, 1);
        const idle = await person(); // no revisions, goals or focus lines
        const local = await person({}, 'dev@recollect.local');
        await overdue(local.id, 1);
        const testDomain = await person({}, `someone${k}@test.local`);
        await overdue(testDomain.id, 1);
        const other = await person({ reminderEmail: 'inbox@example.net' });
        await prisma.focusItem.create({ data: { userId: other.id, day: d(ago(1)), text: 'a learner by focus lines' } });

        const result = await runMorningNudgePass();
        expect(result).toMatchObject({ sent: 1, failed: 0 });
        expect(result.skipped).toBe(2);
        for (const u of [off, ghost, idle, local, testDomain]) expect(mailsTo(u.email)).toHaveLength(0);
        expect(mailsTo(other.email)).toHaveLength(0);
        expect(mailsTo('inbox@example.net')).toHaveLength(1);
        expect(sentMails()).toHaveLength(1);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: off.id } })).lastNudgeDay).toBeNull();
    });

    it("uses each user's nudgeTime and time zone (America/New_York)", async () => {
        const early = await person({ nudgeTime: '07:00' });
        await overdue(early.id, 1);
        // Already nudged on its 11-13 (local); its next one is 08:30 EST on 11-14.
        const ny = await person({ timezone: 'America/New_York', lastNudgeDay: d('2026-11-13') });
        await overdue(ny.id, 1);

        vi.setSystemTime(new Date('2026-11-14T01:00:00Z')); // 06:30 IST
        await runMorningNudgePass();
        expect(mailsTo(early.email)).toHaveLength(0);
        vi.setSystemTime(new Date('2026-11-14T01:30:00Z')); // 07:00 IST; 20:30 EST on 11-13
        await runMorningNudgePass();
        expect([mailsTo(early.email).length, mailsTo(ny.email).length]).toEqual([1, 0]);

        vi.setSystemTime(new Date('2026-11-14T13:29:00Z')); // 08:29 EST
        await runMorningNudgePass();
        expect(mailsTo(ny.email)).toHaveLength(0);
        vi.setSystemTime(new Date('2026-11-14T13:30:00Z')); // 08:30 EST
        await runMorningNudgePass();
        expect(mailsTo(ny.email)).toHaveLength(1);
        expect(dayStr((await prisma.user.findUniqueOrThrow({ where: { id: ny.id } })).lastNudgeDay)).toBe(TODAY);
        expect(mailsTo(early.email)).toHaveLength(1);
    });

    it('a failed send is logged and not retried the same day; overlapping passes send once', async () => {
        const failing = await person();
        await overdue(failing.id, 1);
        setMailFailure(true);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await runMorningNudgePass()).toMatchObject({ sent: 0, failed: 1 });
        errors.mockRestore();
        setMailFailure(false);
        vi.setSystemTime(new Date('2026-11-14T03:30:00Z'));
        await runMorningNudgePass();
        expect(mailsTo(failing.email)).toHaveLength(0);

        const racing = await person();
        await overdue(racing.id, 2);
        const results = await Promise.all([runMorningNudgePass(), runMorningNudgePass(), runMorningNudgePass()]);
        expect(results.reduce((s, r) => s + r.sent, 0)).toBe(1);
        expect(mailsTo(racing.email)).toHaveLength(1);
    });
});
