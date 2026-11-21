// The record checks the words before anything changes (MCP_MEMORY_PLAN §4.3, after the live hour of 11-19), with no AI
// at all: the account has no credits here (no key), so every outcome is code. On the live hour ChatGPT filed "Decided
// to start learning Spanish" on "Walking after work" as a change, and one morning's walk on it as a change of routine,
// and the record took both. These are fresh examples of the same two mistakes and of what must still work:
//   - not about the thing named (no shared word, two or more of its own): kept as its own note, the thing untouched;
//   - one day's doing named as a change or an end: recorded as that day's news (the open question answered);
//   - a real change of routine, and a real end, still apply; too few words to tell leave the assistant's choice;
//   - remember for one day's doing of exactly one followed thing is that thing's day news, no new memory;
//   - a thread changed since its title was written shows the change beside it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import { buddyMaySpend } from '../../src/services/buddy/spend';

const KEY = process.env.CLAUDE_API_KEY;
beforeAll(() => {
    delete process.env.CLAUDE_API_KEY;
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = KEY ?? '';
});

async function person(loop = true) {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true });
    if (loop) await prisma.buddyState.update({ where: { userId: user.id }, data: { loop: true } });
    const chat = asAgent((await createTestToken(user, undefined, 'ChatGPT')).token);
    return { user, chat };
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
/** A followed thread, made directly (two guitar threads must stay two). */
const thread = (userId: string, title: string, keywords: string[], rhythm: 'none' | 'daily' = 'none') =>
    prisma.buddyThread.create({ data: { userId, title, keywords, rhythm, stage: 'active', lastSaidAt: new Date(Date.now() - 3600_000), firstDay: new Date(`${today()}T00:00:00Z`) } });
const events = (threadId: string) => prisma.buddyThreadEvent.findMany({ where: { threadId }, orderBy: { createdAt: 'asc' }, select: { kind: true, text: true } });

describe('with no AI credits at all', () => {
    it('is code only: the buddy may not spend', async () => {
        const { user } = await person();
        expect(await buddyMaySpend(user.id)).toBe('no_ai');
    });
});

describe('update_memory on a thread', () => {
    it('one day\'s doing named as a change is that day\'s news: done, the question answered, no change on the thread', async () => {
        const { user, chat } = await person();
        const guitar = await thread(user.id, 'Evening guitar practice', ['guitar', 'practice', 'practise'], 'daily');
        await prisma.buddyAsk.create({ data: { userId: user.id, threadId: guitar.id, text: 'Did you get some practice in today?', seenRevision: guitar.revision, fromAt: new Date(Date.now() - 60_000), untilAt: new Date(Date.now() + 3600_000) } });
        const r = (await chat.post('/api/buddy/update', { on: guitar.id, update: 'changed', text: 'Played guitar for 25 minutes before lunch today' })).body.data;
        expect(r).toMatchObject({ target: 'thread', outcome: 'seen', readAs: { from: 'changed', to: 'done' } });
        expect(await events(guitar.id)).toEqual([expect.objectContaining({ kind: 'done', text: 'Played guitar for 25 minutes before lunch today' })]);
        expect((await prisma.buddyAsk.findFirstOrThrow({ where: { threadId: guitar.id } })).state).toBe('answered');
    });

    it('not about the thing: kept as its own note; the thread gets no event and no new revision', async () => {
        const { user, chat } = await person();
        const guitar = await thread(user.id, 'Evening guitar practice', ['guitar', 'practice'], 'daily');
        const r = (await chat.post('/api/buddy/update', { on: guitar.id, update: 'changed', text: 'Signed up for a pottery class on Saturday mornings' })).body.data;
        expect(r).toMatchObject({ outcome: 'apart', apart: { from: { _id: guitar.id, text: 'Evening guitar practice' }, note: { status: 'saved', memory: { text: 'Signed up for a pottery class on Saturday mornings' } } } });
        expect(await events(guitar.id)).toEqual([]);
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: guitar.id } })).revision).toBe(guitar.revision);
        const kept = await prisma.memory.findFirstOrThrow({ where: { userId: user.id, text: 'Signed up for a pottery class on Saturday mornings' } });
        expect(kept).toMatchObject({ status: 'active', agentName: 'ChatGPT' });
        // Dated and sourced like any save: the note behind it says it was said.
        expect(await prisma.observation.findFirstOrThrow({ where: { memoryId: kept.id } })).toMatchObject({ basis: 'said', via: 'agent' });
    });

    it('a finished session of something that recurs does not end it; a real end does', async () => {
        const { user, chat } = await person();
        const guitar = await thread(user.id, 'Evening guitar practice', ['guitar', 'practice'], 'daily');
        const session = (await chat.post('/api/buddy/update', { on: guitar.id, update: 'finished', text: 'Finished my practice session tonight, the scales are getting easier' })).body.data;
        expect(session).toMatchObject({ outcome: 'seen', readAs: { from: 'finished', to: 'done' }, thread: { stage: 'active' } });
        const end = (await chat.post('/api/buddy/update', { on: guitar.id, update: 'finished', text: "I've quit guitar practice for good, no time with the new job" })).body.data;
        expect(end).toMatchObject({ outcome: 'closed', thread: { stage: 'done' } });
        expect(end.readAs).toBeUndefined();
    });

    it('too few words to tell: the assistant\'s choice of thing stands', async () => {
        const { user, chat } = await person();
        const stretch = await thread(user.id, 'Morning stretches', ['stretch', 'stretching']);
        expect((await chat.post('/api/buddy/update', { on: stretch.id, update: 'done', text: 'Done for today!' })).body.data).toMatchObject({ outcome: 'seen' });
        expect(await events(stretch.id)).toEqual([expect.objectContaining({ kind: 'done' })]);
    });
});

describe('update_memory on a memory (the buddy\'s AI never ran: no threads, habits are memories)', () => {
    it('one morning\'s run named as a change leaves the habit as it is; a real change of routine replaces it', async () => {
        const { user, chat } = await person(false);
        const runs = (await chat.post('/api/buddy/remember', { text: 'Runs 5k on weekday mornings', kind: 'pattern', inferred: false })).body.data.notes[0].memory;
        const once = (await chat.post('/api/buddy/update', { on: runs._id, update: 'changed', text: 'Ran 5k this morning, legs felt heavy' })).body.data;
        expect(once).toMatchObject({ outcome: 'seen', readAs: { from: 'changed', to: 'done' }, memory: { _id: runs._id, text: 'Runs 5k on weekday mornings', seenCount: 2 } });
        expect((await prisma.memory.findMany({ where: { userId: user.id, status: 'active' } })).map((m) => m.text)).toEqual(['Runs 5k on weekday mornings']);
        const moved = (await chat.post('/api/buddy/update', { on: runs._id, update: 'changed', text: 'I run in the evenings now, mornings are too rushed' })).body.data;
        expect(moved).toMatchObject({ outcome: 'replaced', memory: { text: 'I run in the evenings now, mornings are too rushed' } });
    });

    it('one skipped session named as dropping an aim keeps the aim', async () => {
        const { chat } = await person(false);
        const novel = (await chat.post('/api/buddy/remember', { text: 'Writing a short novel', kind: 'aim', inferred: false })).body.data.notes[0].memory;
        const r = (await chat.post('/api/buddy/update', { on: novel._id, update: 'dropped', text: 'Skipped my writing session today' })).body.data;
        expect(r).toMatchObject({ outcome: 'seen', readAs: { from: 'dropped', to: 'skipped' }, memory: { status: 'active' } });
    });

    it('not about the memory: kept apart, the memory untouched', async () => {
        const { user, chat } = await person(false);
        const runs = (await chat.post('/api/buddy/remember', { text: 'Runs 5k on weekday mornings', kind: 'pattern', inferred: false })).body.data.notes[0].memory;
        const r = (await chat.post('/api/buddy/update', { on: runs._id, update: 'changed', text: 'Booked flights to Lisbon for the conference' })).body.data;
        expect(r).toMatchObject({ outcome: 'apart', apart: { from: { _id: runs._id } } });
        expect(await prisma.memory.findUniqueOrThrow({ where: { id: runs._id } })).toMatchObject({ status: 'active', text: 'Runs 5k on weekday mornings', seenCount: 1 });
        expect(await prisma.memory.count({ where: { userId: user.id, status: 'active' } })).toBe(2);
    });
});

describe('remember for one day\'s doing of something followed', () => {
    it('is that thread\'s day news when exactly one followed thing holds its words; no new memory', async () => {
        const { user, chat } = await person();
        const guitar = await thread(user.id, 'Evening guitar practice', ['guitar', 'practice', 'practise'], 'daily');
        const r = (await chat.post('/api/buddy/remember', { text: 'Practised guitar for half an hour this morning', inferred: false })).body.data;
        expect(r.notes).toEqual([expect.objectContaining({ status: 'linked', target: 'thread', update: 'done', label: 'Evening guitar practice' })]);
        expect(await prisma.memory.count({ where: { userId: user.id } })).toBe(0);
        expect(await events(guitar.id)).toEqual([expect.objectContaining({ kind: 'done' })]);
    });

    it('stays a new memory when it is not one day\'s doing, or when two followed things could be meant', async () => {
        const { user, chat } = await person();
        await thread(user.id, 'Evening guitar practice', ['guitar', 'practice'], 'daily');
        expect((await chat.post('/api/buddy/remember', { text: 'Thinking about buying a better guitar amp', inferred: false })).body.data.notes[0].status).toBe('saved');
        await thread(user.id, 'Guitar lessons with a teacher', ['guitar', 'lessons']);
        expect((await chat.post('/api/buddy/remember', { text: 'Played guitar for an hour today', inferred: false })).body.data.notes[0].status).toBe('saved');
    });

    it('is that habit\'s day news when the buddy\'s AI never ran (a memory, not a thread)', async () => {
        const { user, chat } = await person(false);
        const swims = (await chat.post('/api/buddy/remember', { text: 'Swims at the local pool on Sundays', kind: 'pattern', inferred: false })).body.data.notes[0].memory;
        const r = (await chat.post('/api/buddy/remember', { text: 'Swam 20 laps this morning', inferred: false })).body.data;
        expect(r.notes).toEqual([expect.objectContaining({ status: 'linked', target: 'memory', update: 'done', memory: expect.objectContaining({ _id: swims._id, seenCount: 2 }) })]);
        expect(await prisma.memory.count({ where: { userId: user.id } })).toBe(1);
    });
});

// MCP_MEMORY_PLAN §12.4 (the final look, 11-19): what the fresh live test showed, with its own sentences. The person
// of that test: a yoga thread with its question; a reading habit, a coffee aim, a charity ride and a peanut allergy
// kept as memories of their own (with no credits nothing turns them into threads).
async function noor() {
    const p = await person();
    const yoga = await thread(p.user.id, 'Yoga before work, three mornings a week', ['yoga', 'mat', 'asanas']);
    const mem = async (text: string, kind: 'pattern' | 'aim' | 'fact') => (await api(p.user).post('/api/buddy/memories', { text, kind })).body.data;
    return { ...p, yoga, reading: await mem('Reads 20 pages of a novel before bed', 'pattern'), coffee: await mem('Cutting down to one coffee a day', 'aim'), ride: await mem('Training for a 50 km charity cycle ride in December', 'aim'), allergy: await mem('Allergic to peanuts', 'fact') };
}

describe('§12.4 A: the brief lists what the person has going, threads first, then habits and aims kept as memories', () => {
    it('with their ids, never private ones, never one a listed thread stands for, never one in doubt', async () => {
        const n = await noor();
        await api(n.user).post('/api/buddy/memories', { text: 'Worried about the knee surgery', kind: 'aim', private: true });
        // The digest's thread for the coffee aim: the memory behind it is not listed twice.
        await thread(n.user.id, 'Cut down on coffee', ['coffee', 'caffeine']);
        const v = (await api(n.user).get('/api/brief?view=buddy')).body.data;
        expect(v.inMotion.map((x: { type: string; text: string }) => `${x.type}: ${x.text}`)).toEqual([
            'thread: Cut down on coffee',
            'thread: Yoga before work, three mornings a week',
            // Newest said first; the allergy is a fact (found by search, not listed), the private aim stays out.
            'memory: Training for a 50 km charity cycle ride in December',
            'memory: Reads 20 pages of a novel before bed',
        ]);
        expect(v.inMotion.find((x: { _id: string }) => x._id === n.ride._id)).toMatchObject({ type: 'memory', kind: 'aim' });
        // A check mark with no newer version (the ordering rule's: two versions of one day) leaves it listed.
        await prisma.memory.update({ where: { id: n.reading._id }, data: { checkSince: new Date() } });
        expect((await api(n.user).get('/api/brief?view=buddy')).body.data.inMotion.map((x: { text: string }) => x.text)).toContain('Reads 20 pages of a novel before bed');
        await prisma.memory.update({ where: { id: n.reading._id }, data: { checkSince: null } });
        // Newer words that may replace it: the old habit is in doubt and left out until settled; the new one is listed.
        await n.chat.post('/api/buddy/remember', { text: 'Stopped reading before bed; now listens to audiobooks on the commute instead.', kind: 'pattern', inferred: false });
        const after = (await api(n.user).get('/api/brief?view=buddy')).body.data.inMotion.map((x: { text: string }) => x.text);
        expect(after).not.toContain('Reads 20 pages of a novel before bed');
        expect(after).toContain('Stopped reading before bed; now listens to audiobooks on the commute instead.');
    });

    it('at most 4 memories after the threads, newest said first, seen in the last 90 days', async () => {
        const { user } = await person();
        await thread(user.id, 'Morning stretches', ['stretch']);
        for (const [i, text] of ['Plays chess on Sundays', 'Learning to bake sourdough', 'Runs on weekday mornings', 'Paints watercolours at night', 'Saving for a motorbike'].entries()) {
            const m = (await api(user).post('/api/buddy/memories', { text, kind: i % 2 ? 'aim' : 'pattern' })).body.data;
            await prisma.memory.update({ where: { id: m._id }, data: { lastSeenDay: new Date(`${today()}T00:00:00Z`), updatedAt: new Date(Date.now() + i * 1000) } });
        }
        const old = (await api(user).post('/api/buddy/memories', { text: 'Collects old maps', kind: 'pattern' })).body.data;
        await prisma.memory.update({ where: { id: old._id }, data: { lastSeenDay: new Date(Date.now() - 120 * 86_400_000) } });
        const v = (await api(user).get('/api/brief?view=buddy')).body.data;
        expect(v.inMotion.filter((x: { type: string }) => x.type === 'memory')).toHaveLength(4);
        expect(v.inMotion.map((x: { text: string }) => x.text)).not.toContain('Collects old maps');
    });
});

describe('§12.4 B: remember is resolved by the words', () => {
    it('B1: one day\'s news about one followed aim, with no doing word, is its progress (no new memory)', async () => {
        const n = await noor();
        const r = (await n.chat.post('/api/buddy/remember', { text: "Had two coffees today and says cutting down isn't going great.", kind: 'pattern', inferred: false })).body.data;
        expect(r.notes).toEqual([expect.objectContaining({ status: 'linked', target: 'memory', update: 'progress', label: 'Cutting down to one coffee a day' })]);
        expect(await prisma.memory.count({ where: { userId: n.user.id, text: { contains: 'two coffees' } } })).toBe(0);
        expect(await prisma.observation.findFirstOrThrow({ where: { memoryId: n.coffee._id, updateKind: 'progress' } })).toMatchObject({ basis: 'said' });
    });

    it('B1: a remark the assistant marked private is never put on an open thing: kept as it came', async () => {
        const n = await noor();
        const r = (await n.chat.post('/api/buddy/remember', { text: "Had two coffees already today; cutting down isn't going great.", kind: 'state', private: true, inferred: false })).body.data;
        expect(r.notes[0]).toMatchObject({ status: 'saved', memory: { sensitivity: 'private' } });
        expect(await prisma.observation.count({ where: { memoryId: n.coffee._id, updateKind: { not: null } } })).toBe(0);
    });

    it('B2: words that may replace one older memory: both kept, the older marked to check, the answer names it', async () => {
        const n = await noor();
        const r = (await n.chat.post('/api/buddy/remember', { text: 'Stopped reading before bed; now listens to audiobooks on the commute instead.', kind: 'pattern', inferred: false })).body.data;
        expect(r.notes[0]).toMatchObject({ status: 'saved', mayReplace: { _id: n.reading._id, text: 'Reads 20 pages of a novel before bed' } });
        const old = await prisma.memory.findUniqueOrThrow({ where: { id: n.reading._id } });
        expect(old).toMatchObject({ status: 'active' });
        expect(old.checkSince).not.toBeNull();
        // The assistant follows the hint: the new memory becomes the replacement, the old one closes, the mark goes.
        const u = (await n.chat.post('/api/buddy/update', { on: n.reading._id, update: 'changed', text: 'Stopped reading before bed; now listens to audiobooks on the commute instead.' })).body.data;
        expect(u).toMatchObject({ outcome: 'replaced', memory: { _id: r.notes[0].memory._id } });
        expect(await prisma.memory.findUniqueOrThrow({ where: { id: n.reading._id } })).toMatchObject({ status: 'closed', checkSince: null });
    });

    it('B2: a correction said with remember marks the fact it corrects', async () => {
        const n = await noor();
        const r = (await n.chat.post('/api/buddy/remember', { text: 'Allergic to cashews, not peanuts', kind: 'fact', inferred: false })).body.data;
        expect(r.notes[0]).toMatchObject({ status: 'saved', mayReplace: { _id: n.allergy._id } });
    });

    it('must not link or mark: an addition, a purchase, a thought, a new interest', async () => {
        const n = await noor();
        for (const text of ['Also allergic to shellfish', 'Bought a rain cover for the charity ride today', 'Thinking about a coffee machine', 'Has gotten into birdwatching lately; went to the lake on Sunday with binoculars.']) {
            const note = (await n.chat.post('/api/buddy/remember', { text, inferred: false })).body.data.notes[0];
            expect(note.status).toBe('saved');
            expect(note.mayReplace).toBeUndefined();
        }
        expect(await prisma.memory.count({ where: { userId: n.user.id, checkSince: { not: null } } })).toBe(0);
        expect(await prisma.observation.count({ where: { userId: n.user.id, updateKind: { not: null } } })).toBe(0);
    });

    it('an inference never links or marks anything', async () => {
        const n = await noor();
        const note = (await n.chat.post('/api/buddy/remember', { text: 'Stopped reading before bed; now listens to audiobooks on the commute instead.', kind: 'pattern', inferred: true })).body.data.notes[0];
        expect(note.mayReplace).toBeUndefined();
        expect((await prisma.memory.findUniqueOrThrow({ where: { id: n.reading._id } })).checkSince).toBeNull();
    });
});

describe('§12.4 C and D: the brief says how to end or correct what is not listed; a look-up finds other forms of a word', () => {
    it('the how-to names recall_memory then update_memory', async () => {
        const { user } = await person();
        const v = (await api(user).get('/api/brief?view=buddy')).body.data;
        expect(v.howTo.join(' ')).toMatch(/end or correct something not listed: find it with recall_memory, then update_memory/);
    });

    it('"allergies" finds "Allergic to cashews, not peanuts"; "cycling" finds the ride', async () => {
        const n = await noor();
        await n.chat.post('/api/buddy/update', { on: n.allergy._id, update: 'changed', text: 'Allergic to cashews, not peanuts' });
        const found = (await n.chat.get('/api/buddy/memories?q=allergies&limit=20')).body.data;
        expect(found.map((m: { text: string }) => m.text)).toEqual(['Allergic to cashews, not peanuts']);
        expect((await n.chat.get('/api/buddy/memories?q=cycling&limit=20')).body.data.map((m: { text: string }) => m.text)).toEqual(['Training for a 50 km charity cycle ride in December']);
    });

    it('several words with a status named: when none holds them all, any of them (the live rerun\'s "seat window aisle flight")', async () => {
        const { user, chat } = await person();
        await api(user).post('/api/buddy/memories', { text: 'Prefers window seats on flights', kind: 'preference' });
        const found = (await chat.get('/api/buddy/memories?q=seat+window+aisle+flight&status=all&limit=20')).body.data;
        expect(found.map((m: { text: string }) => m.text)).toEqual(['Prefers window seats on flights']);
    });
});

describe('a thread changed since its title was written', () => {
    it('shows the change beside the title in the brief, in the person\'s words', async () => {
        const { user, chat } = await person();
        const guitar = await thread(user.id, 'Evening guitar practice', ['guitar', 'practice'], 'daily');
        await chat.post('/api/buddy/update', { on: guitar.id, update: 'changed', text: 'Practising guitar in the mornings now, evenings are too busy' });
        const v = (await api(user).get('/api/brief?view=buddy')).body.data;
        expect(v.inMotion).toEqual([expect.objectContaining({ _id: guitar.id, text: 'Evening guitar practice', now: { day: today(), text: 'Practising guitar in the mornings now, evenings are too busy' } })]);
        // Another change, then the first said again: the one said last is how it goes now (a repeat is a duplicate event).
        await chat.post('/api/buddy/update', { on: guitar.id, update: 'changed', text: 'Practising guitar at lunch now' });
        await chat.post('/api/buddy/update', { on: guitar.id, update: 'changed', text: 'Practising guitar in the mornings now, evenings are too busy' });
        const again = (await api(user).get('/api/brief?view=buddy')).body.data;
        expect(again.inMotion[0].now.text).toBe('Practising guitar in the mornings now, evenings are too busy');
    });
});
