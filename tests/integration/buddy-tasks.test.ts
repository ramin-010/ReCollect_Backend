// Stage 5b, part A of ECOSYSTEM_V2_PLAN on scripted models (the owner's answer, 11-18 evening): something to do is
// a task, due on its day (never on today's list before it) with one quiet early reminder and an Undo row; "booked it"
// ticks it; an event is a thread: no question before it is over, one at most after it within 3 days, and it closes by
// itself a week after its day. The model's part (which words are which) is measured by the real-model sets.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { queueOwnWords } from '../../src/services/buddy/capture.service';
import { drainBuddyQueue } from '../../src/services/buddy/worker';
import { writeAsks } from '../../src/services/buddy/asks';
import { threadsForNight } from '../../src/services/buddy/nightLoop';
import { closePastEvents, withPersonLock } from '../../src/services/buddy/threads';
import { listTasks } from '../../src/services/tasks/tasks.service';
import { DIGEST_SCHEMA } from '../../src/services/buddy/digest';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';

const fake = new FakeClaude();
beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    setAiClientForTests(fake);
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = '';
    setAiClientForTests(null);
});
beforeEach(async () => {
    fake.reset();
    await prisma.buddyChunk.deleteMany({});
});

const TZ = 'Asia/Kolkata';
// Kolkata time (UTC+5:30): Fri 20 Nov 11:00; Mon 23 Nov 08:00.
const FRI = new Date('2026-11-20T05:30:00Z');
const MON_8 = new Date('2026-11-23T02:30:00Z');

const item = (o: Record<string, unknown>) => ({ kind: 'task', text: '', dueDay: '', deadline: false, time: '', why: '', message: 1, ...o });
const op = (o: Record<string, unknown>) => ({ op: 'open', threadId: '', title: '', keywords: [], kind: 'said', text: '', day: '', message: 1, askId: '', sensitive: false, lookAgainOn: '', rhythm: 'none', steer: '', event: false, time: '', ...o });
const digest = (o: { items?: unknown[]; tasksDone?: unknown[]; threads?: unknown[]; screens?: unknown[] }) => fakeMessage({ notes: [], items: [], tasksDone: [], threads: [], screens: [], ...o }, { model: 'claude-sonnet-5-5' });

async function person(loop = true) {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
    await api(user).patch('/api/buddy/settings', { enabled: true, loop });
    return user;
}
const say = (userId: string, seq: number, text: string, at: Date) => queueOwnWords(userId, { key: 'ask:chat-5b', seq, via: 'ask_ai', messages: [{ at: at.toISOString(), text }] }, at);
const lastRequestText = () => {
    const c = fake.calls[fake.calls.length - 1] as unknown as { messages: Array<{ content: Array<{ text: string }> }> };
    return c.messages[0]!.content[0]!.text;
};

describe('something to do is a task (5b A)', () => {
    it('“I need to book the dentist on Monday”: one task due Monday, not on Friday’s list, a quiet reminder Monday 09:00, an Undo row, no thread; said again, nothing twice', async () => {
        const arjun = await person();
        await say(arjun.id, 1, 'I need to book the dentist on Monday, the tooth keeps bugging me.', FRI);
        fake.push(digest({ items: [item({ text: 'Book the dentist', dueDay: '2026-11-23' })] }));
        expect(await drainBuddyQueue(FRI)).toMatchObject({ digested: 1, failed: 0 });
        const tasks = await prisma.todo.findMany({ where: { userId: arjun.id } });
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({ title: 'Book the dentist', status: 'pending' });
        expect(tasks[0]!.dueDate?.toISOString()).toBe('2026-11-23T12:30:00.000Z'); // Monday 18:00
        // Not on Friday's list; there in the week's.
        expect(await listTasks(arjun.id, 'today', FRI)).toEqual([]);
        expect((await listTasks(arjun.id, 'week', FRI)).map((t) => t.title)).toEqual(['Book the dentist']);
        const reminders = await prisma.reminder.findMany({ where: { userId: arjun.id } });
        expect(reminders).toHaveLength(1);
        expect(reminders[0]).toMatchObject({ silent: true, status: 'pending', todoId: tasks[0]!.id });
        expect(reminders[0]!.reminderDate.toISOString()).toBe('2026-11-23T03:30:00.000Z'); // Monday 09:00
        const edits = await prisma.agentEdit.findMany({ where: { userId: arjun.id } });
        expect(edits).toHaveLength(1);
        expect(edits[0]).toMatchObject({ kind: 'task_create', entityId: tasks[0]!.id });
        expect(edits[0]!.summary).toMatch(/^Added the task "Book the dentist" for Mon 23 Nov, with a quiet reminder Mon 23 Nov, 09:00, from what you said$/);
        expect(await prisma.buddyThread.count({ where: { userId: arjun.id } })).toBe(0);
        expect(await prisma.suggestion.count({ where: { userId: arjun.id } })).toBe(0);

        // Said again later: the digest is shown the open task (with its id and day), and a second one is never added.
        await say(arjun.id, 2, 'remember, the dentist on Monday', new Date(FRI.getTime() + 3600_000));
        fake.push(digest({ items: [item({ text: 'Book the dentist appointment', dueDay: '2026-11-23' })] }));
        await drainBuddyQueue(new Date(FRI.getTime() + 3600_000));
        expect(lastRequestText()).toContain(`${tasks[0]!.id} · Book the dentist · 2026-11-23`);
        expect(await prisma.todo.count({ where: { userId: arjun.id } })).toBe(1);
        expect(await prisma.reminder.count({ where: { userId: arjun.id } })).toBe(1);
    });

    it('“booked it”: the task is ticked and its reminder still to come cancelled; Undo puts both back', async () => {
        const arjun = await person();
        await say(arjun.id, 1, 'I need to book the dentist on Monday.', FRI);
        fake.push(digest({ items: [item({ text: 'Book the dentist', dueDay: '2026-11-23' })] }));
        await drainBuddyQueue(FRI);
        const task = await prisma.todo.findFirstOrThrow({ where: { userId: arjun.id } });
        await say(arjun.id, 2, 'Booked it! Thursday at 4.', MON_8);
        fake.push(digest({ tasksDone: [{ taskId: task.id, message: 1 }] }));
        await drainBuddyQueue(MON_8);
        expect(await prisma.todo.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'complete' });
        expect((await prisma.reminder.findFirstOrThrow({ where: { todoId: task.id } })).status).toBe('cancelled');
        const tick = await prisma.agentEdit.findFirstOrThrow({ where: { userId: arjun.id, kind: 'task_update' } });
        expect(tick.summary).toBe('Ticked "Book the dentist" done, from what you said');
        // Undo (Home's "From your agent"): open again, its reminder back.
        expect((await api(arjun).post(`/api/agent/edits/${tick.id}/undo`)).status).toBe(200);
        expect(await prisma.todo.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'pending', completedAt: null });
        expect((await prisma.reminder.findFirstOrThrow({ where: { todoId: task.id } })).status).toBe('pending');
    });

    it('never a task outside the list it was shown, nor from a message read as context; the loop off keeps today’s suggestion', async () => {
        const meera = await person();
        const other = await person();
        const theirs = await prisma.todo.create({ data: { userId: other.id, title: 'Pay the rent', status: 'pending', visibility: 'private' } });
        await say(meera.id, 1, 'paid the rent', FRI);
        fake.push(digest({ tasksDone: [{ taskId: theirs.id, message: 1 }] }));
        await drainBuddyQueue(FRI);
        expect((await prisma.todo.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('pending');

        const lena = await person(false);
        await say(lena.id, 1, 'I need to renew my passport by Friday.', FRI);
        // The loop off: today's gate and digest, and a to-do stays a suggestion.
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'item' }] }, { model: 'claude-haiku-5-5' }));
        fake.push(fakeMessage({ notes: [], items: [{ kind: 'task', text: 'Renew the passport', dueDay: '2026-11-27', why: '' }] }, { model: 'claude-sonnet-5-5' }));
        await drainBuddyQueue(FRI);
        expect(fake.calls.some((c) => c.output_config?.format?.schema === DIGEST_SCHEMA)).toBe(true);
        expect(await prisma.todo.count({ where: { userId: lena.id } })).toBe(0);
        expect(await prisma.suggestion.count({ where: { userId: lena.id, kind: 'task' } })).toBe(1);
    });

    it('a deadline reminds the day before; a named time reminds then; one for today after 09:00 has no reminder', async () => {
        const omar = await person();
        await say(omar.id, 1, 'The client wants the dashboard redesign by Friday the 27th. I also have to call the bank at 3 on Monday, and send the invoice today.', FRI);
        fake.push(
            digest({
                items: [
                    item({ text: 'Deliver the dashboard redesign', dueDay: '2026-11-27', deadline: true }),
                    item({ text: 'Call the bank', dueDay: '2026-11-23', time: '15:00' }),
                    item({ text: 'Send the invoice', dueDay: '2026-11-20' }),
                ],
            })
        );
        await drainBuddyQueue(FRI);
        const rows = await prisma.todo.findMany({ where: { userId: omar.id }, include: { reminders: true }, orderBy: { title: 'asc' } });
        const by = Object.fromEntries(rows.map((r) => [r.title, r]));
        expect(by['Deliver the dashboard redesign']!.reminders.map((r) => r.reminderDate.toISOString())).toEqual(['2026-11-26T03:30:00.000Z']);
        expect(by['Call the bank']!.reminders.map((r) => r.reminderDate.toISOString())).toEqual(['2026-11-23T09:30:00.000Z']);
        expect(by['Call the bank']!.dueDate?.toISOString()).toBe('2026-11-23T09:30:00.000Z');
        expect(by['Send the invoice']!.reminders).toEqual([]);
        // Today's one is on today's list (its day is today).
        expect((await listTasks(omar.id, 'today', FRI)).map((t) => t.title)).toEqual(['Send the invoice']);
    });

    it('the wedding and the gift in one message: a thread for the event, a task for the gift', async () => {
        const omar = await person();
        await say(omar.id, 1, "My cousin's wedding is on December 5th and I still need to sort out a gift.", FRI);
        fake.push(
            digest({
                items: [item({ text: 'Sort out a gift for the wedding', dueDay: '2026-12-04', deadline: true })],
                threads: [op({ title: "Cousin's wedding", keywords: ['wedding', 'cousin'], text: "Cousin's wedding on 5 December", lookAgainOn: '2026-12-05', event: true })],
            })
        );
        await drainBuddyQueue(FRI);
        const wedding = await prisma.buddyThread.findFirstOrThrow({ where: { userId: omar.id } });
        expect(wedding).toMatchObject({ event: true, eventMinute: null, rhythm: 'none' });
        expect(wedding.lookAgainOn?.toISOString().slice(0, 10)).toBe('2026-12-05');
        const gift = await prisma.todo.findFirstOrThrow({ where: { userId: omar.id }, include: { reminders: true } });
        expect(gift.title).toBe('Sort out a gift for the wedding');
        expect(gift.reminders.map((r) => r.reminderDate.toISOString())).toEqual(['2026-12-03T03:30:00.000Z']);
    });
});

describe('an event is a thread (5b A5)', () => {
    async function interview() {
        const sam = await person();
        await say(sam.id, 1, 'My job interview at Acme is on Friday the 27th at 3pm.', new Date('2026-11-23T05:30:00Z'));
        fake.push(digest({ threads: [op({ title: 'Job interview at Acme', keywords: ['interview', 'acme', 'job'], text: 'Job interview at Acme on Friday at 3pm', lookAgainOn: '2026-11-27', event: true, time: '15:00' })] }));
        await drainBuddyQueue(new Date('2026-11-23T05:30:00Z'));
        const t = await prisma.buddyThread.findFirstOrThrow({ where: { userId: sam.id } });
        return { sam, t };
    }
    const proposal = (threadId: string, from: Date) => [{ threadId, text: 'How did the interview go?', answers: [{ label: 'Went well', meaning: 'done' as const }], from, until: new Date(from.getTime() + 4 * 3600_000) }];
    const write = (userId: string, threadId: string, now: Date, from: Date) => withPersonLock(userId, (tx) => writeAsks(tx, userId, null, proposal(threadId, from), { now, tz: TZ }));

    it('no question before it is over (moved to an hour after its time); one at most after it; none past 3 days', async () => {
        const { sam, t } = await interview();
        expect(t).toMatchObject({ event: true, eventMinute: 15 * 60 });
        // The night before: its day has not come (said once, it is silent until then).
        expect((await write(sam.id, t.id, new Date('2026-11-25T23:30:00Z'), new Date('2026-11-26T12:30:00Z'))).kept).toBe(0);
        // Its morning: a question written for 10:00 starts at 16:00 (an hour after 15:00).
        const fri5 = new Date('2026-11-26T23:30:00Z');
        expect((await write(sam.id, t.id, fri5, new Date('2026-11-27T04:30:00Z'))).kept).toBe(1);
        const asked = await prisma.buddyAsk.findFirstOrThrow({ where: { userId: sam.id } });
        expect(asked.fromAt.toISOString()).toBe('2026-11-27T10:30:00.000Z');
        expect(asked.untilAt.getTime()).toBeGreaterThan(asked.fromAt.getTime());
        // It showed and passed unanswered; the next day: never a second one.
        await prisma.buddyAsk.update({ where: { id: asked.id }, data: { state: 'passed', firstShownAt: asked.fromAt } });
        expect((await write(sam.id, t.id, new Date('2026-11-27T23:30:00Z'), new Date('2026-11-28T12:30:00Z'))).dropped.map((d) => d.why)).toEqual(['asked about it once already']);
        // The night's view says so.
        expect((await threadsForNight(sam.id, '2026-11-28', new Date('2026-11-27T23:30:00Z'))).block).toMatch(/event was 2026-11-27 at 15:00: followed up already/);
    });

    it('the moment passes after 3 days; it closes by itself a week after its day; a new day moves it', async () => {
        const { sam, t } = await interview();
        expect((await threadsForNight(sam.id, '2026-11-24', new Date('2026-11-23T23:30:00Z'))).block).toMatch(/event on 2026-11-27 at 15:00: before it a line may help, never a question/);
        expect((await write(sam.id, t.id, new Date('2026-11-30T23:30:00Z'), new Date('2026-12-01T12:30:00Z'))).dropped.map((d) => d.why)).toEqual(['the moment has passed']);
        expect(await closePastEvents(sam.id, '2026-12-03' as never, new Date('2026-12-02T23:30:00Z'))).toBe(0);
        expect(await closePastEvents(sam.id, '2026-12-04' as never, new Date('2026-12-03T23:30:00Z'))).toBe(1);
        expect(await prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ stage: 'done' });
        expect((await prisma.buddyThreadEvent.findFirstOrThrow({ where: { threadId: t.id, kind: 'finished' } })).text).toMatch(/closed by itself/);

        // Another one moves: a second round on 12 December keeps it open past the 4th.
        const { sam: kim, t: second } = await interview();
        await say(kim.id, 2, 'Good news, they want a second round on the 12th at 11.', new Date('2026-11-28T05:30:00Z'));
        fake.push(digest({ threads: [op({ op: 'event', threadId: second.id, kind: 'changed', text: 'Second round on 12 December at 11', lookAgainOn: '2026-12-12', time: '11:00' })] }));
        await drainBuddyQueue(new Date('2026-11-28T05:30:00Z'));
        const moved = await prisma.buddyThread.findUniqueOrThrow({ where: { id: second.id } });
        expect(moved.lookAgainOn?.toISOString().slice(0, 10)).toBe('2026-12-12');
        expect(moved.eventMinute).toBe(11 * 60);
        expect(await closePastEvents(kim.id, '2026-12-04' as never, new Date('2026-12-03T23:30:00Z'))).toBe(0);
    });
});
