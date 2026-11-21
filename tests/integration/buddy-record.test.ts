// The record (MCP_MEMORY_PLAN stage 1, §4.2-§4.4): what a connected assistant saves is kept by code with no AI
// call, true months later. Saving in every gate state (only the person's pause refuses); when it was said; repeats
// (exact, near, close to one marked wrong, of a closed one); progress; a said change with its Undo; a stale id; a
// late older statement; two corrections on one day (the owner's case: never guessed); a preference said once and
// found six months later from another app; ending and resuming; the person's own memory; retries; "Related".
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import { FakeClaude } from '../helpers/claude';
import { setAiClientForTests } from '../../src/services/claude/client';
import { HOUSE_KEY } from '../../src/services/claude/access';
import { rememberNotes } from '../../src/services/buddy/memory.service';
import { updateRecord } from '../../src/services/buddy/record.service';
import { fadeMemories } from '../../src/services/buddy/think';
import { drainBuddyQueue } from '../../src/services/buddy/worker';
import { closeToWrong, laterOf, nearSame, saidTimeOf } from '../../src/services/buddy/recordRules';

const house = new FakeClaude();
beforeAll(() => setAiClientForTests(house));
afterAll(() => setAiClientForTests(null));
const KEY = process.env.CLAUDE_API_KEY;
afterEach(async () => {
    process.env.CLAUDE_API_KEY = KEY ?? '';
    delete process.env.AI_ALLOWED_EMAILS;
    await prisma.aiKeyState.deleteMany({ where: { keyId: HOUSE_KEY } });
    await prisma.buddyChunk.deleteMany({});
});

type Chat = ReturnType<typeof asAgent>;
const remember = (chat: Chat, body: Record<string, unknown>, headers: Record<string, string> = {}) => chat.post('/api/buddy/remember', body, headers);
const update = (chat: Chat, body: Record<string, unknown>) => chat.post('/api/buddy/update', body);

async function person(opts: { enabled?: boolean; loop?: boolean } = {}) {
    const user = await createTestUser();
    if (opts.enabled) await api(user).patch('/api/buddy/settings', { enabled: true });
    if (opts.loop) await prisma.buddyState.update({ where: { userId: user.id }, data: { loop: true } });
    return user;
}
const chatOf = async (user: { id: string }, name = 'Claude') => asAgent((await createTestToken(user, undefined, name)).token);

/** A signed-in app's token (OAuth): its notes come in "via connector". */
async function connectorChat(user: { id: string }, name = 'ChatGPT') {
    const client = await prisma.oAuthClient.upsert({ where: { id: `test-client-${name}` }, create: { id: `test-client-${name}`, name, redirectUris: [], kind: 'dcr' }, update: {} });
    const t = await createTestToken(user, undefined, name);
    await prisma.apiToken.update({ where: { id: t.id }, data: { oauthClientId: client.id } });
    return asAgent(t.token);
}

const notesOf = (userId: string) => prisma.observation.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
const writer = (userId: string, agentName = 'ChatGPT') => ({ userId, source: 'agent' as const, agentName, via: 'connector' });
const actor = (userId: string, agentName = 'ChatGPT') => ({ actor: { userId, agentName, tokenId: null }, source: 'agent' as const, via: 'connector' });

describe('the rules, pure', () => {
    it('said_on: now, a day, a day and time; the future cut to now; more than a year back refused', () => {
        const ctx = { today: '2026-11-19' as const, tz: 'Asia/Kolkata' };
        const now = new Date('2026-11-19T10:00:00Z');
        expect(saidTimeOf(undefined, ctx, now)).toEqual({ at: now, dayOnly: false, day: '2026-11-19' });
        expect(saidTimeOf('2026-11-10', ctx, now)).toMatchObject({ dayOnly: true, day: '2026-11-10' });
        expect(saidTimeOf('2026-11-10T08:30', ctx, now)).toEqual({ at: new Date('2026-11-10T03:00:00Z'), dayOnly: false, day: '2026-11-10' });
        expect(saidTimeOf('2026-11-25', ctx, now)).toEqual({ at: now, dayOnly: false, day: '2026-11-19' });
        expect(saidTimeOf('2026-11-19T23:00', ctx, now)).toEqual({ at: now, dayOnly: false, day: '2026-11-19' });
        expect(() => saidTimeOf('2025-11-01', ctx, now)).toThrow(/a year/);
        expect(() => saidTimeOf('2026-02-30', ctx, now)).toThrow(/not a day/);
        expect(() => saidTimeOf('last Tuesday', ctx, now)).toThrow(/said_on/);
    });

    it('which was said later: exact times compare; a day-only one on the same day is unknown unless it arrived before the other was said', () => {
        const at = (iso: string) => new Date(iso);
        const exact = (iso: string, arrived = iso) => ({ at: at(iso), dayOnly: false, arrivedAt: at(arrived) });
        const day = (noonIso: string, arrived: string) => ({ at: at(noonIso), dayOnly: true, arrivedAt: at(arrived) });
        expect(laterOf(exact('2026-06-10T09:00:00Z'), exact('2026-06-10T03:00:00Z'))).toBe(1);
        expect(laterOf(exact('2026-06-10T03:00:00Z', '2026-06-10T12:00:00Z'), exact('2026-06-10T09:00:00Z'))).toBe(-1);
        // The owner's case: the earlier correction arrives last with only its day: nobody can know.
        expect(laterOf(day('2026-06-10T06:30:00Z', '2026-06-10T12:00:00Z'), exact('2026-06-10T08:30:00Z'))).toBe(0);
        // Said now, after a day-only one arrived: surely later.
        expect(laterOf(exact('2026-06-10T14:00:00Z'), day('2026-06-10T06:30:00Z', '2026-06-10T04:00:00Z'))).toBe(1);
        // Different days order by the day.
        expect(laterOf(day('2026-06-09T06:30:00Z', '2026-06-12T00:00:00Z'), exact('2026-06-10T01:00:00Z'))).toBe(-1);
    });

    it('nearly the same words merge; more information, another tense or a negation does not; close to a wrong one needs three shared words', () => {
        expect(nearSame('Studies at the night', 'studies at night!')).toBe(true);
        expect(nearSame('Prefers working on backend', 'Prefers backend working')).toBe(true);
        for (const [a, b] of [
            ['Has a dog', 'Has a dog named Rex who is sick'],
            ['Walks after work', 'Walks after work with a friend'],
            ['Had a dog', 'Has a dog'],
            ['Walks after work', 'No longer walks after work'],
            ['Walks in the mornings', 'Walks in the evenings'],
            ['Prefers backend work', 'Prefers frontend work'],
        ]) expect(nearSame(a!, b!), `${a} / ${b}`).toBe(false);
        expect(closeToWrong('Likes long detailed explanations', 'Likes long explanations')).toBe(true);
        expect(closeToWrong('Prefers working late at night', 'Prefers working at night')).toBe(true);
        expect(closeToWrong('Likes long walks', 'Likes long explanations')).toBe(false);
        expect(closeToWrong('Prefers working in the morning', 'Prefers working at night')).toBe(false);
    });
});

describe('saving (R1, R2, R3)', () => {
    it('a save is kept in every gate state with its day, whose word it is, the app and how it came in; a thing in motion waits for the AI', async () => {
        process.env.CLAUDE_API_KEY = 'test-key-not-real';
        const cases: Array<[string, () => Promise<{ id: string; email: string }>]> = [
            ['no AI on the server', async () => {
                process.env.CLAUDE_API_KEY = '';
                return person({ enabled: true, loop: true });
            }],
            ['the buddy off', () => person()],
            ['AI not allowed for the account', async () => {
                const u = await person({ enabled: true, loop: true });
                process.env.AI_ALLOWED_EMAILS = 'someone-else@test.local';
                return u;
            }],
            ['the key out of credit', async () => {
                const u = await person({ enabled: true, loop: true });
                await prisma.aiKeyState.create({ data: { keyId: HOUSE_KEY, state: 'no_credit' } });
                return u;
            }],
            ['the buddy at its cap', async () => {
                const u = await person({ enabled: true, loop: true });
                await prisma.buddyState.update({ where: { userId: u.id }, data: { capUsd: 1 } });
                await prisma.aiUsage.create({ data: { userId: u.id, feature: 'buddy_digest', model: 'claude-sonnet-5-5', inputTokens: 1, outputTokens: 1, costUsd: 2 } });
                return u;
            }],
        ];
        for (const [name, setup] of cases) {
            process.env.CLAUDE_API_KEY = 'test-key-not-real';
            const user = await setup();
            const chat = await connectorChat(user);
            const res = await remember(chat, { text: 'Started walking after work', kind: 'pattern', saidOn: '2026-11-17', inferred: false });
            expect(res.status, name).toBe(201);
            const [note] = await notesOf(user.id);
            expect(note, name).toMatchObject({ basis: 'said', via: 'connector', agentName: 'ChatGPT', dayOnly: true });
            expect(note!.day.toISOString().slice(0, 10), name).toBe('2026-11-17');
            expect(note!.waitingSince, name).not.toBeNull();
            expect(await prisma.buddyChunk.count({ where: { userId: user.id } }), name).toBe(0);
            const memory = await prisma.memory.findFirstOrThrow({ where: { userId: user.id } });
            expect(memory.firstSeenDay.toISOString().slice(0, 10), name).toBe('2026-11-17');
            delete process.env.AI_ALLOWED_EMAILS;
            await prisma.aiKeyState.deleteMany({ where: { keyId: HOUSE_KEY } });
        }

        // The AI can run (the loop on): it is read now, as a piece, and does not wait. A plain fact needs no AI at all.
        process.env.CLAUDE_API_KEY = 'test-key-not-real';
        const ok = await person({ enabled: true, loop: true });
        const chat = await chatOf(ok);
        await remember(chat, { text: 'Started walking after work', kind: 'pattern', inferred: false });
        await remember(chat, { text: 'Prefers backend work', kind: 'preference', inferred: false });
        const notes = await notesOf(ok.id);
        expect(notes.map((n) => [n.basis, n.via, n.waitingSince])).toEqual([
            ['said', 'agent', null],
            ['said', 'agent', null],
        ]);
        const pieces = await prisma.buddyChunk.findMany({ where: { userId: ok.id } });
        expect(pieces.map((p) => p.noteId)).toEqual([notes[0]!.id]);
        expect(pieces[0]!.messages).toEqual([expect.objectContaining({ text: 'Started walking after work', noteId: notes[0]!.id })]);

        // Paused by the person: nothing is kept, and the answer says so (R2).
        const paused = await person({ enabled: true });
        await api(paused).patch('/api/buddy/settings', { paused: true });
        const refused = await remember(await chatOf(paused), { text: 'Started walking after work', inferred: false });
        expect(refused.body.data).toMatchObject({ paused: true, notes: [] });
        expect(await prisma.observation.count({ where: { userId: paused.id } })).toBe(0);
    });

    it('a piece of saved notes that cannot be read is not dropped: its notes wait (R1)', async () => {
        process.env.CLAUDE_API_KEY = 'test-key-not-real';
        const user = await person({ enabled: true, loop: true });
        const chat = await chatOf(user);
        await remember(chat, { text: 'Started walking after work', kind: 'pattern', inferred: false });
        const [note] = await notesOf(user.id);
        expect(note!.waitingSince).toBeNull();
        process.env.AI_ALLOWED_EMAILS = 'someone-else@test.local';
        const r = await drainBuddyQueue();
        expect(r.dropped).toBe(0);
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0);
        expect((await prisma.observation.findUniqueOrThrow({ where: { id: note!.id } })).waitingSince).not.toBeNull();
        const day = await prisma.buddyCaptureDay.findFirst({ where: { userId: user.id } });
        expect(day?.dropped ?? 0).toBe(0);
    });

    it('when it was said: a past day sets the first day; a future one is now; more than a year back is refused', async () => {
        const user = await person();
        const chat = await chatOf(user);
        await remember(chat, { text: 'Walks after work', kind: 'pattern', saidOn: '2026-11-10', inferred: false });
        expect((await prisma.memory.findFirstOrThrow({ where: { userId: user.id } })).firstSeenDay.toISOString().slice(0, 10)).toBe('2026-11-10');
        const future = await remember(chat, { text: 'Reads before bed', saidOn: '2099-01-01', inferred: false });
        const today = future.body.data.notes[0].memory.firstSeenDay;
        expect(today > '2026-11-10').toBe(true);
        const old = await remember(chat, { text: 'Liked chess as a kid', saidOn: '2020-01-01', inferred: false });
        expect(old.status).toBe(400);
        expect(old.body.message).toMatch(/year/);
    });
});

describe('repeats (R6, R9)', () => {
    it('an exact repeat and a near one are seen again; one close to a memory marked wrong is refused', async () => {
        const user = await person();
        const chat = await chatOf(user);
        const first = (await remember(chat, { text: 'Studies at night after dinner', inferred: false })).body.data.notes[0].memory;
        expect((await remember(chat, { text: 'studies at night, after dinner!', inferred: false })).body.data.notes[0]).toMatchObject({ status: 'seen', memory: { _id: first._id, seenCount: 2 } });
        expect((await remember(chat, { text: 'Studies at the night after dinner', inferred: false })).body.data.notes[0]).toMatchObject({ status: 'seen', memory: { _id: first._id, seenCount: 3 } });
        expect(await prisma.memory.count({ where: { userId: user.id } })).toBe(1);

        const wrong = (await remember(chat, { text: 'Likes long explanations', kind: 'preference', inferred: false })).body.data.notes[0].memory;
        await api(user).patch(`/api/buddy/memories/${wrong._id}`, { status: 'wrong' });
        expect((await remember(chat, { text: 'Likes long detailed explanations', inferred: false })).body.data.notes[0]).toMatchObject({ status: 'wrong', similar: true });
        expect((await remember(chat, { text: 'Likes long walks', inferred: false })).body.data.notes[0].status).toBe('saved');
    });

    it('a closed memory stays closed when passed on or said on its day, and comes back when the person says it later', async () => {
        const user = await person();
        const chat = await chatOf(user);
        const t0 = new Date('2026-06-01T06:00:00Z');
        const [saved] = (await rememberNotes(writer(user.id), [{ text: 'Plays chess on Sundays', kind: 'pattern', inferred: false }], t0)).notes;
        const id = saved!.status === 'saved' ? saved!.memory._id : '';
        const closeDay = new Date('2026-06-05T06:00:00Z');
        await updateRecord(actor(user.id), { on: id, update: 'dropped', text: 'Stopped playing chess' }, closeDay);
        // An older build's repeat (passed on), and a said one on the close day: kept as a note, still closed.
        expect((await rememberNotes(writer(user.id), [{ text: 'Plays chess on Sundays' }], new Date('2026-06-20T06:00:00Z'))).notes[0]).toMatchObject({ status: 'closed', memory: { status: 'closed' } });
        expect((await rememberNotes(writer(user.id), [{ text: 'Plays chess on Sundays', inferred: false, saidOn: '2026-06-05' }], new Date('2026-06-20T06:00:00Z'))).notes[0]).toMatchObject({ status: 'closed' });
        expect((await rememberNotes(writer(user.id), [{ text: 'Plays chess on Sundays', inferred: true }], new Date('2026-06-20T06:00:00Z'))).notes[0]).toMatchObject({ status: 'closed' });
        expect((await prisma.memory.findUniqueOrThrow({ where: { id } })).status).toBe('closed');
        // Said on a later day: it comes back.
        expect((await rememberNotes(writer(user.id), [{ text: 'Plays chess on Sundays', inferred: false }], new Date('2026-06-21T06:00:00Z'))).notes[0]).toMatchObject({ status: 'seen', reopened: true, memory: { status: 'active' } });
        // A replaced one never comes back by a repeat: the answer points at the newest version.
        const v1 = (await remember(chat, { text: 'Runs in the evenings', kind: 'pattern', inferred: false })).body.data.notes[0].memory;
        const v2 = (await update(chat, { on: v1._id, update: 'changed', text: 'Runs in the mornings now' })).body.data.memory;
        const again = (await remember(chat, { text: 'Runs in the evenings', inferred: false, saidOn: undefined })).body.data.notes[0];
        expect(again).toMatchObject({ status: 'closed', replacedBy: { _id: v2._id } });
    });
});

describe('updates (R4, R5, R7, R8)', () => {
    it('progress strengthens the one memory and makes no new one; inferred progress does not strengthen', async () => {
        const user = await person();
        const chat = await chatOf(user);
        const m = (await remember(chat, { text: 'Walks 10,000 steps a day', kind: 'pattern', inferred: false })).body.data.notes[0].memory;
        const done = await update(chat, { on: m._id, update: 'done', text: 'Got my steps in today' });
        expect(done.body.data).toMatchObject({ outcome: 'seen', memory: { _id: m._id, seenCount: 2 } });
        expect((await update(chat, { on: m._id, update: 'progress', text: 'Seems to walk a lot', inferred: true })).body.data).toMatchObject({ outcome: 'noted', memory: { seenCount: 2 } });
        expect(await prisma.memory.count({ where: { userId: user.id } })).toBe(1);
        expect((await notesOf(user.id)).map((n) => [n.updateKind, n.basis])).toEqual([
            [null, 'said'],
            ['done', 'said'],
            ['progress', 'inferred'],
        ]);
    });

    it('a said change supersedes (tags, pin and privacy carried), the old one stays as history, and Undo puts it back', async () => {
        const user = await person();
        const chat = await connectorChat(user, 'Claude');
        const old = (await remember(chat, { text: 'Walks after work', kind: 'pattern', inferred: false, private: true })).body.data.notes[0].memory;
        await api(user).patch(`/api/buddy/memories/${old._id}`, { pinned: true });
        const r = (await update(chat, { on: old._id, update: 'changed', text: 'Walks in the mornings now' })).body.data;
        expect(r).toMatchObject({ outcome: 'replaced', memory: { text: 'Walks in the mornings now', supersedesId: old._id, pinned: true, sensitivity: 'private', kind: 'pattern' }, replaced: { _id: old._id, status: 'closed' } });
        expect(r.replaced.closeReason).toBe('Changed: now Walks in the mornings now');
        // Wherever memory is read, the new version: the list, the search.
        const mind = (await chat.get('/api/buddy/memories?q=walks')).body.data;
        expect(mind.map((m: { text: string }) => m.text)).toEqual(['Walks in the mornings now']);
        const all = (await chat.get('/api/buddy/memories?status=all')).body.data;
        expect(all.find((m: { _id: string }) => m._id === old._id)).toMatchObject({ status: 'closed', replacedBy: { _id: r.memory._id } });
        expect(all.find((m: { _id: string }) => m._id === r.memory._id)).toMatchObject({ replaces: { _id: old._id, text: 'Walks after work' } });

        // Undo from Home: the old version is back, the new one gone.
        expect((await api(user).post(`/api/agent/edits/${r.editId}/undo`, {})).status).toBe(200);
        expect(await prisma.memory.findUnique({ where: { id: r.memory._id } })).toBeNull();
        expect(await prisma.memory.findUniqueOrThrow({ where: { id: old._id } })).toMatchObject({ status: 'active', closedDay: null, pinned: true });
    });

    it('against a stale id it lands on the newest version; an older statement arriving late replaces nothing; an inference replaces nothing', async () => {
        const user = await person();
        const chat = await chatOf(user);
        const v1 = (await remember(chat, { text: 'Walks after work', kind: 'pattern', inferred: false, saidOn: '2026-11-01' })).body.data.notes[0].memory;
        const v2 = (await update(chat, { on: v1._id, update: 'changed', text: 'Walks in the mornings now', saidOn: '2026-11-10' })).body.data.memory;
        // The stale id: the chain is followed to v2.
        const stale = (await update(chat, { on: v1._id, update: 'changed', text: 'Walks at lunch now' })).body.data;
        expect(stale).toMatchObject({ outcome: 'replaced', movedFrom: v1._id, replaced: { _id: v2._id } });
        const v3 = stale.memory;
        // Said on 5 Nov, arriving now: history only.
        const late = (await update(chat, { on: v3._id, update: 'changed', text: 'Walks after dinner', saidOn: '2026-11-05' })).body.data;
        expect(late).toMatchObject({ outcome: 'history', memory: { _id: v3._id, text: 'Walks at lunch now' }, current: { text: 'Walks at lunch now', app: 'Claude' } });
        // An inference never replaces.
        expect((await update(chat, { on: v3._id, update: 'changed', text: 'Probably stopped walking', inferred: true })).body.data).toMatchObject({ outcome: 'noted', memory: { _id: v3._id, status: 'active' } });
        expect((await prisma.memory.findMany({ where: { userId: user.id, status: 'active' } })).map((m) => m.text)).toEqual(['Walks at lunch now']);
    });

    it('two corrections on one day (the owner’s case): with times the later said wins in either order; the earlier arriving last with only its day is never guessed', async () => {
        const at = (iso: string) => new Date(iso);
        // Asia/Kolkata: 14:00 is 08:30Z, 09:00 is 03:30Z.
        const setup = async () => {
            const user = await person();
            const [n] = (await rememberNotes(writer(user.id), [{ text: 'Walks after work', kind: 'pattern', inferred: false }], at('2026-06-01T12:00:00Z'))).notes;
            return { user, id: n!.status === 'saved' ? n!.memory._id : '' };
        };
        const activeText = async (userId: string) => (await prisma.memory.findMany({ where: { userId, status: 'active' } })).map((m) => m.text);

        // Times known, the later arriving first: the earlier joins the history.
        let { user, id } = await setup();
        await updateRecord(actor(user.id), { on: id, update: 'changed', text: 'Walks in the evenings now', saidOn: '2026-06-10T14:00' }, at('2026-06-10T09:00:00Z'));
        expect((await updateRecord(actor(user.id), { on: id, update: 'changed', text: 'Walks in the mornings now', saidOn: '2026-06-10T09:00' }, at('2026-06-10T12:00:00Z'))).outcome).toBe('history');
        expect(await activeText(user.id)).toEqual(['Walks in the evenings now']);

        // Times known, the earlier arriving first: the later replaces it.
        ({ user, id } = await setup());
        await updateRecord(actor(user.id), { on: id, update: 'changed', text: 'Walks in the mornings now', saidOn: '2026-06-10T09:00' }, at('2026-06-10T04:00:00Z'));
        expect((await updateRecord(actor(user.id), { on: id, update: 'changed', text: 'Walks in the evenings now', saidOn: '2026-06-10T14:00' }, at('2026-06-10T12:00:00Z'))).outcome).toBe('replaced');
        expect(await activeText(user.id)).toEqual(['Walks in the evenings now']);

        // The later said now; the earlier arrives last with only its day: the current version stays, the late one is
        // history, and the memory is marked "check".
        ({ user, id } = await setup());
        await updateRecord(actor(user.id), { on: id, update: 'changed', text: 'Walks in the evenings now' }, at('2026-06-10T08:30:00Z'));
        const unclear = await updateRecord(actor(user.id), { on: id, update: 'changed', text: 'Walks in the mornings now', saidOn: '2026-06-10' }, at('2026-06-10T12:00:00Z'));
        expect(unclear).toMatchObject({ outcome: 'check', memory: { text: 'Walks in the evenings now' }, current: { text: 'Walks in the evenings now', app: 'ChatGPT' } });
        expect(unclear.memory!.checkSince).not.toBeNull();
        expect(await activeText(user.id)).toEqual(['Walks in the evenings now']);
        const late = (await notesOf(user.id)).slice(-1)[0]!;
        expect(late).toMatchObject({ text: 'Walks in the mornings now', updateKind: 'unclear', dayOnly: true });
        // A later said statement settles it.
        const settled = await updateRecord(actor(user.id), { on: unclear.memory!._id, update: 'said', text: 'Still walking in the evenings' }, at('2026-06-11T05:00:00Z'));
        expect(settled.memory!.checkSince).toBeNull();

        // ...or the person on /you.
        ({ user, id } = await setup());
        await updateRecord(actor(user.id), { on: id, update: 'changed', text: 'Walks in the evenings now' }, at('2026-06-10T08:30:00Z'));
        const marked = await updateRecord(actor(user.id), { on: id, update: 'changed', text: 'Walks in the mornings now', saidOn: '2026-06-10' }, at('2026-06-10T12:00:00Z'));
        expect((await api(user).patch(`/api/buddy/memories/${marked.memory!._id}`, { settle: true })).body.data.checkSince).toBeNull();
    });

    it('dropped and finished close (with Undo); resumed reopens; paused only notes', async () => {
        const user = await person();
        const chat = await chatOf(user);
        const m = (await remember(chat, { text: 'Learning about RAG', kind: 'aim', inferred: false })).body.data.notes[0].memory;
        expect((await update(chat, { on: m._id, update: 'paused', text: 'Taking a break from RAG this week' })).body.data).toMatchObject({ outcome: 'noted', memory: { status: 'active' } });
        const fin = (await update(chat, { on: m._id, update: 'finished', text: 'Learned enough about RAG for now' })).body.data;
        expect(fin).toMatchObject({ outcome: 'closed', memory: { status: 'closed', closeReason: 'Finished: Learned enough about RAG for now' } });
        expect(fin.editId).toBeTruthy();
        expect((await update(chat, { on: m._id, update: 'resumed', text: 'Back to RAG: building a prototype' })).body.data).toMatchObject({ outcome: 'reopened', memory: { status: 'active' } });
        expect((await update(chat, { on: m._id, update: 'dropped', text: 'Dropping RAG' })).body.data).toMatchObject({ outcome: 'closed' });
    });

    it('a memory the person wrote takes their said update and refuses an inference', async () => {
        const user = await person();
        const chat = await chatOf(user);
        const mine = (await api(user).post('/api/buddy/memories', { text: 'Never schedule anything on Sunday mornings', kind: 'preference' })).body.data;
        expect((await update(chat, { on: mine._id, update: 'changed', text: 'Sunday mornings are fine now, but not before 9' })).body.data.outcome).toBe('replaced');
        const theirs = (await api(user).post('/api/buddy/memories', { text: 'Takes the train to work', kind: 'pattern' })).body.data;
        const refused = await update(chat, { on: theirs._id, update: 'changed', text: 'Probably drives now', inferred: true });
        expect(refused.status).toBe(403);
        expect((await update(chat, { on: 'nothing-like-this', text: 'x' })).status).toBe(404);
    });

    it('a retried call writes once', async () => {
        const user = await person();
        const chat = await chatOf(user);
        const m = (await remember(chat, { text: 'Walks 10,000 steps a day', kind: 'pattern', inferred: false }, { 'Idempotency-Key': 'k-remember-1' })).body.data.notes[0].memory;
        await remember(chat, { text: 'Walks 10,000 steps a day', kind: 'pattern', inferred: false }, { 'Idempotency-Key': 'k-remember-1' });
        const body = { on: m._id, update: 'done', text: 'Got my steps in today' };
        await chat.post('/api/buddy/update', body, { 'Idempotency-Key': 'k-update-1' });
        await chat.post('/api/buddy/update', body, { 'Idempotency-Key': 'k-update-1' });
        expect(await prisma.observation.count({ where: { userId: user.id } })).toBe(2);
        expect((await prisma.memory.findUniqueOrThrow({ where: { id: m._id } })).seenCount).toBe(2);
    });
});

describe('finding it again (R10) and what other apps saved', () => {
    it('"Related" names the newest related memory another app saved, with a hint when it looks like the old version', async () => {
        const user = await person();
        const claude = await connectorChat(user, 'Claude');
        const chatgpt = await connectorChat(user, 'ChatGPT');
        await remember(claude, { text: 'Walks after work most days', kind: 'pattern', inferred: false });
        const r = (await remember(chatgpt, { text: 'Walks after work with the dog', kind: 'pattern', inferred: false })).body.data;
        expect(r.related.memories[0]).toMatchObject({ text: 'Walks after work most days', app: 'Claude', looksLikeOld: true });
        expect(r.inMotion.map((x: { text: string }) => x.text)).toEqual(expect.arrayContaining(['Walks after work most days', 'Walks after work with the dog']));
        // An older build (no basis) gets today's answer, without the lists.
        const legacy = (await remember(chatgpt, { text: 'Likes green tea' })).body.data;
        expect(legacy.related).toBeUndefined();
    });

    it('new words of a changed routine name the older memory first and mark it to check (MCP_MEMORY_PLAN §12.4 B2)', async () => {
        const user = await person();
        const claude = await connectorChat(user, 'Claude');
        const chatgpt = await connectorChat(user, 'ChatGPT');
        const old = (await remember(claude, { text: 'Walks after work most days', kind: 'pattern', inferred: false })).body.data.notes[0].memory;
        const r = (await remember(chatgpt, { text: 'Walks in the mornings most days', kind: 'pattern', inferred: false })).body.data;
        expect(r.notes[0]).toMatchObject({ status: 'saved', mayReplace: { _id: old._id, text: 'Walks after work most days' } });
        // Named first, so not again under "Related"; in doubt, so not in motion while the newer one is there.
        expect(r.related.memories.map((m: { text: string }) => m.text)).not.toContain('Walks after work most days');
        expect(r.inMotion.map((x: { text: string }) => x.text)).toEqual(['Walks in the mornings most days']);
        expect((await prisma.memory.findUniqueOrThrow({ where: { id: old._id } })).checkSince).not.toBeNull();
    });

    it('a preference said once is still found six months later, by any of its words, from another app (the owner’s case)', async () => {
        const user = await person();
        const t0 = new Date('2026-05-01T06:00:00Z');
        await rememberNotes({ userId: user.id, source: 'agent', agentName: 'Claude', via: 'connector' }, [{ text: 'Prefers backend work', kind: 'preference', inferred: false }], t0);
        // 26 weeks on, no repeat: the code-only upkeep runs (fading and promotion), and it is still there.
        await fadeMemories(user.id, '2026-10-30');
        const m = await prisma.memory.findFirstOrThrow({ where: { userId: user.id } });
        expect(m).toMatchObject({ status: 'active', lasting: true, inferred: false, seenCount: 1 });
        const other = await connectorChat(user, 'ChatGPT');
        for (const q of ['backend', 'prefers', 'work', 'backend work', 'Backend']) {
            const found = (await other.get(`/api/buddy/memories?q=${encodeURIComponent(q)}`)).body.data;
            expect(found.map((x: { text: string }) => x.text), q).toEqual(['Prefers backend work']);
            expect(found[0], q).toMatchObject({ firstSeenDay: '2026-05-01', agentName: 'Claude' });
        }
    });

    it('an inference is a working memory marked inferred until their own words confirm it', async () => {
        const user = await person();
        const chat = await chatOf(user);
        const m = (await remember(chat, { text: 'Seems to prefer short answers', kind: 'preference', inferred: true })).body.data.notes[0].memory;
        expect(m).toMatchObject({ inferred: true, lasting: false });
        const again = (await remember(chat, { text: 'Seems to prefer short answers', inferred: true })).body.data.notes[0];
        expect(again).toMatchObject({ status: 'seen', noted: true, memory: { seenCount: 1 } });
        const said = (await remember(chat, { text: 'Seems to prefer short answers', inferred: false })).body.data.notes[0];
        expect(said.memory).toMatchObject({ inferred: false, lasting: true, seenCount: 2 });
    });
});
