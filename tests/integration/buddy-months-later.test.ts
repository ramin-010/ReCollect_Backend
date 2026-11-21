// MCP_MEMORY_PLAN §6, the months-later check: half a year of one invented person through four doors (a web
// assistant, Claude Code's tools, the app, the person's own words), on a moved clock, read the way an assistant would.
// It holds every hard case of §6 and asserts each promise R1 to R12 by name (R13, an excluded folder, lives in the
// MCP: mcp/test/unit/excluded-folder.test.ts). Scripted: no real AI call. The AI is off all along (no key), so the
// record alone must hold; at week 26 it comes back and the catch-up runs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { setAiClientForTests } from '../../src/services/claude/client';
import { closeMemoryByAgent, listMemories, rememberNotes, type NoteInput } from '../../src/services/buddy/memory.service';
import { buddyView, updateRecord, type UpdateInput } from '../../src/services/buddy/record.service';
import { catchUpIfDue } from '../../src/services/buddy/catchup';
import { drainBuddyQueue, SAVE_SETTLE_MS } from '../../src/services/buddy/worker';
import { fadeMemories } from '../../src/services/buddy/think';

const fake = new FakeClaude();
const KEY = process.env.CLAUDE_API_KEY;
beforeAll(() => {
    process.env.CLAUDE_API_KEY = '';
    setAiClientForTests(fake);
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = KEY ?? '';
    setAiClientForTests(null);
});

const WEEK = 7 * 86_400_000;
/**
 * Midnight of the person's day (Asia/Kolkata) 26 weeks ago. It was Date.now() - 26 weeks, which put "10:00" at the
 * test's own hour plus ten: run after about 08:00 UTC, "the same day" of the owner's case fell across two days.
 */
const T0 = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() - 26 * WEEK))}T00:00:00+05:30`).getTime();
/** Week w (1 to 26) of the run, at 10:00 plus `h` hours of the person's day. */
const at = (w: number, h = 0) => new Date(T0 + (w - 1) * WEEK + (10 + h) * 3600_000);
const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);

describe('the months-later check (§6)', () => {
    it('half a year, four doors, every hard case: the right thing is held', async () => {
        const user = await createTestUser();
        await api(user).patch('/api/buddy/settings', { enabled: true });
        await prisma.buddyState.update({ where: { userId: user.id }, data: { loop: true } });
        const web = { userId: user.id, source: 'agent' as const, agentName: 'ChatGPT', via: 'connector' };
        const code = { userId: user.id, source: 'agent' as const, agentName: 'Claude Code', via: 'agent' };
        const save = async (w: typeof web, note: NoteInput, when: Date) => {
            const n = (await rememberNotes(w, [{ inferred: false, ...note }], when)).notes[0]!;
            return { status: n.status, id: n.status === 'empty' ? '' : n.memory._id };
        };
        const upd = (w: typeof web, input: UpdateInput, when: Date) => updateRecord({ actor: { userId: user.id, agentName: w.agentName, tokenId: null }, source: 'agent', via: w.via }, input, when);
        const active = async () => (await prisma.memory.findMany({ where: { userId: user.id, status: 'active' } })).map((m) => m.text).sort();

        // Week 1: a preference said once, never again; a habit.
        const backend = await save(web, { text: 'Prefers backend work over frontend', kind: 'preference' }, at(1));
        const walk = await save(web, { text: 'Walks after work most days', kind: 'pattern' }, at(1, 1));
        // R3: when it was said, which app, whose word.
        const firstNote = await prisma.observation.findFirstOrThrow({ where: { memoryId: backend.id } });
        expect(firstNote, 'R3').toMatchObject({ agentName: 'ChatGPT', via: 'connector', basis: 'said' });
        expect(dayOf(firstNote.saidAt!), 'R3').toBe(dayOf(at(1)));
        // R1: the AI is off: still kept, the habit waits for the buddy's understanding.
        expect((await prisma.observation.findFirstOrThrow({ where: { memoryId: walk.id } })).waitingSince, 'R1').not.toBeNull();

        // Weeks 2 to 20: weekly progress from Claude Code strengthens the one memory (R8).
        for (let w = 2; w <= 20; w++) await upd(code, { on: walk.id, update: 'done', text: 'Got my walk in' }, at(w, 9));
        const walked = await prisma.memory.findUniqueOrThrow({ where: { id: walk.id } });
        expect(walked.seenCount, 'R8').toBe(20);
        expect(await prisma.memory.count({ where: { userId: user.id, text: { contains: 'walk', mode: 'insensitive' } } }), 'R8').toBe(1);

        // Week 2: a habit that stops in week 6.
        const chess = await save(code, { text: 'Plays chess on Sundays', kind: 'pattern' }, at(2));
        await upd(web, { on: chess.id, update: 'dropped', text: 'Stopped playing chess' }, at(6));

        // Week 3: a routine corrected twice from two apps, the second against a stale id (R4, R5).
        const study1 = await save(web, { text: 'Studies after dinner', kind: 'pattern' }, at(3));
        await upd(code, { on: study1.id, update: 'changed', text: 'Studies in the mornings now' }, at(8));
        const stale = await upd(web, { on: study1.id, update: 'changed', text: 'Studies at lunch now' }, at(12));
        expect(stale, 'R5').toMatchObject({ outcome: 'replaced', movedFrom: study1.id });
        // An older statement arriving two weeks late joins the history (R4).
        const late = await upd(code, { on: stale.memory!._id, update: 'changed', text: 'Studies late at night now', saidOn: dayOf(at(10)) }, at(12, 2));
        expect(late.outcome, 'R4').toBe('history');

        // Week 10: two corrections on one day, the earlier arriving last with only its day (the owner's case).
        const gym = await save(code, { text: 'Goes to the gym on Mondays', kind: 'pattern' }, at(9));
        await upd(web, { on: gym.id, update: 'changed', text: 'Goes to the gym on Tuesdays now' }, at(10, 6));
        const unclear = await upd(code, { on: gym.id, update: 'changed', text: 'Goes to the gym on Fridays now', saidOn: dayOf(at(10)) }, at(10, 8));
        expect(unclear.outcome).toBe('check');

        // The same thing through two doors counts once (R9).
        await save(web, { text: 'Drinks green tea in the afternoon', kind: 'preference' }, at(5));
        await save(code, { text: 'drinks green tea in the afternoon', kind: 'preference' }, at(5, 3));
        expect(await prisma.memory.count({ where: { userId: user.id, text: { contains: 'green tea', mode: 'insensitive' } } }), 'R9').toBe(1);

        // Inference: one later confirmed in their own words, one never (R7).
        await rememberNotes(web, [{ text: 'Seems to enjoy jazz while working', kind: 'preference', inferred: true }], at(4));
        await rememberNotes(web, [{ text: 'Seems to dislike meetings', kind: 'preference', inferred: true }], at(4, 1));
        await upd(web, { on: stale.memory!._id, update: 'changed', text: 'Probably stopped studying', inferred: true }, at(13));
        await save(code, { text: 'Seems to enjoy jazz while working' }, at(9));
        const jazz = await prisma.memory.findFirstOrThrow({ where: { userId: user.id, text: 'Seems to enjoy jazz while working' } });
        const meetings = await prisma.memory.findFirstOrThrow({ where: { userId: user.id, text: 'Seems to dislike meetings' } });
        expect([jazz.inferred, meetings.inferred], 'R7').toEqual([false, true]);

        // Removal: forgotten; marked wrong, then repeated by an agent; deleted on /you, then said again (R6).
        const cello = await save(code, { text: 'Wants to learn the cello', kind: 'aim' }, at(5));
        await closeMemoryByAgent({ userId: user.id, agentName: 'Claude Code', tokenId: null }, cello.id, 'Misunderstood', at(11));
        const berlin = await save(web, { text: 'Plans to move to Berlin', kind: 'aim' }, at(5));
        await api(user).patch(`/api/buddy/memories/${berlin.id}`, { status: 'wrong' });
        expect((await save(code, { text: 'Plans to move to Berlin' }, at(12))).status, 'R6').toBe('wrong');
        // An agent's passed-on repeat (an older build: whose word it is unknown) never brings back what they dropped.
        expect((await rememberNotes(code, [{ text: 'Plays chess on Sundays' }], at(12))).notes[0]!.status, 'R6').toBe('closed');
        const marathon = await save(web, { text: 'Training for a marathon', kind: 'aim' }, at(6));
        await api(user).delete(`/api/buddy/memories/${marathon.id}`);
        expect((await save(web, { text: 'Training for a marathon', kind: 'aim' }, at(14))).status, 'R6').toBe('saved');

        // Private things stay out of the brief (R12).
        await save(web, { text: 'Worried about a health result', kind: 'state' }, at(13));

        // Read at week 4 and week 13, as an assistant would.
        const w4 = await buddyView(user.id, at(4, 8));
        expect(w4.savedLately.length).toBeLessThanOrEqual(3);
        const w13 = await buddyView(user.id, at(13, 8));
        expect(JSON.stringify(w13), 'R12').not.toMatch(/health/i);
        const routine = await listMemories(user.id, { q: 'studies' });
        expect(routine.map((m) => m.text), 'R5').toEqual(['Studies at lunch now']);

        // An interest that ends (weeks 15 to 18).
        const rag = await save(web, { text: 'Learning about RAG', kind: 'aim' }, at(15));
        await upd(web, { on: rag.id, update: 'progress', text: 'Built a small RAG prototype' }, at(16));
        await upd(web, { on: rag.id, update: 'finished', text: 'Learned enough about RAG for now' }, at(18));

        // Weeks 19 to 21: paused by the person: nothing is kept (R2).
        await api(user).patch('/api/buddy/settings', { paused: true });
        expect((await rememberNotes(web, [{ text: 'Started yoga', kind: 'pattern', inferred: false }], at(20))).paused, 'R2').toBe(true);
        expect(await prisma.memory.count({ where: { userId: user.id, text: 'Started yoga' } }), 'R2').toBe(0);
        await api(user).patch('/api/buddy/settings', { paused: false });

        // Week 26: the code-only upkeep; then read everything.
        await fadeMemories(user.id, dayOf(at(26)));
        expect(await active()).toEqual(
            [
                'Drinks green tea in the afternoon',
                'Goes to the gym on Tuesdays now',
                'Prefers backend work over frontend',
                'Seems to dislike meetings',
                'Seems to enjoy jazz while working',
                'Studies at lunch now',
                'Training for a marathon',
                'Walks after work most days',
            ].sort()
        );
        // A worry fades after two quiet weeks (the code-only upkeep, with no AI); it is not deleted.
        expect((await prisma.memory.findFirstOrThrow({ where: { userId: user.id, text: 'Worried about a health result' } })).status).toBe('faded');
        // The preference said once, found by its own words from another app (R10; the owner's case).
        const other = asAgent((await createTestToken(user, undefined, 'Claude')).token);
        for (const q of ['backend', 'frontend', 'prefers backend']) expect((await other.get(`/api/buddy/memories?q=${encodeURIComponent(q)}`)).body.data.map((m: { text: string }) => m.text), `R10 ${q}`).toEqual(['Prefers backend work over frontend']);
        // The two versions of one day are marked check until settled.
        expect((await prisma.memory.findFirstOrThrow({ where: { userId: user.id, text: 'Goes to the gym on Tuesdays now' } })).checkSince).not.toBeNull();

        // The AI comes back: the catch-up reads only what can be in motion, newest versions, and nothing that was removed.
        process.env.CLAUDE_API_KEY = 'test-key-not-real';
        expect(await catchUpIfDue(user.id, new Date())).toBe('long');
        const read = (await prisma.buddyChunk.findMany({ where: { userId: user.id, via: 'catchup' } })).flatMap((c) => (c.messages as Array<{ text: string }>).map((m) => m.text)).join('\n');
        expect(read, 'R6').not.toMatch(/cello|Berlin|chess on Sundays\b(?! \[ended)/);
        expect(read, 'R5').not.toMatch(/after dinner|in the mornings now|late at night/);
        expect(read, 'R7').not.toMatch(/dislike meetings|stopped studying/);
        expect(read).toMatch(/Learning about RAG.*\[ended .*Finished: Learned enough about RAG for now\]/);
        // The older build's passed-on repeat (week 12) is a piece of its own, read first; then the catch-up's batch.
        const batch = await prisma.buddyChunk.findFirstOrThrow({ where: { userId: user.id, via: 'catchup' } });
        const ragLine = (batch.messages as Array<{ text: string }>).findIndex((m) => m.text.startsWith('Learning about RAG')) + 1;
        const empty = () => fakeMessage({ notes: [], items: [], threads: [] }, { model: 'claude-sonnet-5-5' });
        for (let i = await prisma.buddyChunk.count({ where: { userId: user.id, NOT: { via: 'catchup' } } }); i > 0; i--) fake.push(empty());
        fake.push(fakeMessage({ notes: [], items: [], threads: [{ op: 'open', threadId: '', title: 'Learning about RAG', keywords: ['rag'], kind: 'finished', text: 'Learned enough about RAG for now', day: '', message: ragLine, askId: '', sensitive: false, lookAgainOn: '', rhythm: 'none', steer: '' }] }, { model: 'claude-sonnet-5-5' }));
        for (let i = 0; i < 4; i++) await drainBuddyQueue(new Date(Date.now() + SAVE_SETTLE_MS + 1000 + i));
        // R11: nothing that ended is asked about; the ended interest is closed.
        const ragThread = await prisma.buddyThread.findFirst({ where: { userId: user.id, title: 'Learning about RAG' } });
        if (ragThread) expect(ragThread.stage, 'R11').toBe('done');
        expect(await prisma.buddyAsk.count({ where: { userId: user.id } }), 'R11').toBe(0);
        expect((await buddyView(user.id)).inMotion.map((x) => x.text), 'R11').not.toContain('Learning about RAG');
    }, 120_000);
});
