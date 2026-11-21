// Stage 8 of ECOSYSTEM_V2_PLAN (other chats), E5 on scripted models: an export from Claude or ChatGPT brings his
// own messages only, with their own dates; an estimate before anything is read; on his yes, the newest pieces up
// to the limit he approves; the same export twice adds nothing (§4.11 rule 3); an imported old plan opens a
// quiet thread and never a question, and never changes a thread he has now; his live words are read first.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { IMPORT_PIECE_USD, approveImport, estimateImport, parseExport, piecesOf } from '../../src/services/buddy/import.service';
import { drainBuddyQueue } from '../../src/services/buddy/worker';
import { openOrFindThread, withPersonLock } from '../../src/services/buddy/threads';
import { queueOwnWords } from '../../src/services/buddy/capture.service';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

const fake = new FakeClaude();
beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    setAiClientForTests(fake);
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = '';
    setAiClientForTests(null);
});
beforeEach(() => fake.reset());

/** A Claude export: his messages and the assistant's, in two chats. */
const claudeExport = (days: number) => [
    {
        uuid: 'c-1',
        name: 'Running plan',
        chat_messages: [
            { uuid: 'm1', sender: 'human', text: 'I want to start running again in March, three mornings a week.', created_at: '2025-01-10T06:00:00Z' },
            { uuid: 'm2', sender: 'assistant', text: 'Great plan! Here is a schedule...', created_at: '2025-01-10T06:00:05Z' },
            { uuid: 'm3', sender: 'human', text: '', content: [{ type: 'text', text: 'Also my knee hurts a bit.' }], created_at: '2025-01-10T06:02:00Z' },
        ],
    },
    {
        uuid: 'c-2',
        name: 'Daily notes',
        chat_messages: Array.from({ length: days }, (_, i) => ({ uuid: `d${i}`, sender: 'human', text: `Day ${i}: worked on the dashboard and read twenty pages.`, created_at: new Date(Date.UTC(2025, 5, 1 + i, 9)).toISOString() })),
    },
];

/** A ChatGPT export: a mapping of nodes, his ("user") and the assistant's. */
const chatgptExport = [
    {
        id: 'g-1',
        title: 'Spanish',
        mapping: {
            a: { message: { author: { role: 'system' }, content: { parts: ['You are helpful'] }, create_time: 1736496000 } },
            b: { message: { author: { role: 'user' }, content: { parts: ['Help me practise Spanish ten minutes a day'] }, create_time: 1736496100 } },
            c: { message: { author: { role: 'assistant' }, content: { parts: ['¡Claro!'] }, create_time: 1736496105 } },
            d: { message: null },
        },
    },
];

async function person() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, loop: true });
    return user;
}

describe('the import (E5)', () => {
    it('reads his own messages only, with their own dates, from Claude’s and ChatGPT’s exports; anything else is not an export', () => {
        const claude = parseExport(claudeExport(1))!;
        expect(claude.source).toBe('claude');
        expect(claude.chats.map((c) => [c.key, c.messages.map((m) => m.text)])).toEqual([
            ['c-1', ['I want to start running again in March, three mornings a week.', 'Also my knee hurts a bit.']],
            ['c-2', ['Day 0: worked on the dashboard and read twenty pages.']],
        ]);
        expect(claude.chats[0]!.messages[0]!.at.toISOString()).toBe('2025-01-10T06:00:00.000Z');
        const gpt = parseExport(chatgptExport)!;
        expect(gpt).toMatchObject({ source: 'chatgpt', chats: [{ key: 'g-1', title: 'Spanish' }] });
        expect(gpt.chats[0]!.messages.map((m) => [m.text, m.at.toISOString()])).toEqual([['Help me practise Spanish ten minutes a day', '2025-01-10T08:01:40.000Z']]);
        expect(parseExport({ hello: 'world' })).toBeNull();
        // A piece is one chat's day, up to 2,000 characters.
        expect(piecesOf({ key: 'x', title: '', messages: [0, 1, 2].map((i) => ({ text: 'a'.repeat(900), at: new Date(Date.UTC(2025, 0, 1, 9, i)) })) }).map((p) => p.length)).toEqual([2, 1]);
    });

    it('an estimate first; his yes queues the newest pieces his limit covers; the same export twice adds nothing; only through the app', async () => {
        const user = await person();
        const est = (await api(user).post('/api/buddy/import', { export: claudeExport(10), fileName: 'conversations.json' })).body.data;
        expect(est).toMatchObject({ source: 'claude', chats: 2, messages: 12, known: 0, pieces: 11, state: 'estimated', fileName: 'conversations.json' });
        expect(est.estimateUsd).toBeCloseTo(11 * IMPORT_PIECE_USD, 4);
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0); // nothing read yet
        // His limit covers 4 pieces: the 4 newest.
        const approved = (await api(user).post(`/api/buddy/imports/${est._id}/approve`, { limitUsd: 4 * IMPORT_PIECE_USD })).body.data;
        expect(approved).toMatchObject({ state: 'queued', queued: 4, waiting: 4 });
        const chunks = await prisma.buddyChunk.findMany({ where: { userId: user.id }, orderBy: { saidFrom: 'desc' } });
        expect(chunks.map((c) => (c.messages as Array<{ text: string }>)[0]!.text.slice(0, 6))).toEqual(['Day 9:', 'Day 8:', 'Day 7:', 'Day 6:']);
        expect(chunks.every((c) => c.via === 'import')).toBe(true);
        // Uploaded again: what was queued is known; the rest (not read) comes again.
        const again = await estimateImport(user.id, claudeExport(10), null);
        expect(again).toMatchObject({ known: 4, messages: 8 });
        // A second yes is refused; an agent can't import.
        expect((await api(user).post(`/api/buddy/imports/${est._id}/approve`, { limitUsd: 1 })).status).toBe(400);
        expect((await asAgent((await createTestToken(user)).token).post('/api/buddy/import', { export: claudeExport(1) })).status).toBe(403);
        expect((await api(user).get('/api/buddy/imports')).body.data.map((i: { state: string }) => i.state)).toEqual(['estimated', 'queued']);
        // Cancelled: what waits goes (the queue drains for everyone: leave nothing for the next test).
        expect((await api(user).post(`/api/buddy/imports/${est._id}/cancel`)).body.data).toMatchObject({ state: 'cancelled', waiting: 0 });
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0);
    });

    it('an imported old plan opens a quiet thread (no day of the past, no question) and never changes a thread he has now; his live words are read first', async () => {
        const user = await person();
        const now = new Date();
        const t = (await withPersonLock(user.id, (tx) => openOrFindThread(tx, user.id, { title: 'Learn Spanish ten minutes a day', keywords: ['spanish'] }, { saidAt: now, forDay: '2026-11-17' }))).thread;
        await prisma.buddyThread.update({ where: { id: t.id }, data: { stage: 'active', rhythm: 'daily' } });
        const est = await estimateImport(user.id, claudeExport(0), null, now);
        await approveImport(user.id, est._id, 1, now);
        await queueOwnWords(user.id, { key: 'ask:live', seq: 1, via: 'ask_ai', messages: [{ at: now.toISOString(), text: 'Did my Spanish practice tonight' }] }, now);
        const op = (over: Record<string, unknown>) => ({ op: 'open', threadId: '', title: '', keywords: [], kind: 'said', text: '', day: '', message: 1, askId: '', sensitive: false, lookAgainOn: '', rhythm: 'none', steer: '', ...over });
        // The live words first (the Spanish thread), then the import (an old running plan, and a word about Spanish).
        fake.push(fakeMessage({ notes: [], items: [], threads: [op({ op: 'event', threadId: t.id, kind: 'done', text: 'Practised tonight' })] }, { model: 'claude-sonnet-5-5' }));
        // An import goes through the gate like any chat with an AI (his work questions are not about him).
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'update' }, { i: 2, label: 'update' }] }, { model: 'claude-haiku-5-5' }));
        fake.push(
            fakeMessage(
                {
                    notes: [],
                    items: [],
                    threads: [
                        op({ title: 'Start running again, three mornings a week', keywords: ['running', 'run'], kind: 'said', text: 'Wants to start running in March', lookAgainOn: '2025-03-01', rhythm: 'weekly' }),
                        op({ op: 'event', threadId: t.id, kind: 'changed', text: 'Spanish only on weekends now', lookAgainOn: '2025-02-01', rhythm: 'weekly', message: 2 }),
                    ],
                },
                { model: 'claude-sonnet-5-5' }
            )
        );
        await drainBuddyQueue(new Date(now.getTime() + 20 * 60_000));
        expect(JSON.stringify(fake.calls[0]!.messages)).toContain('Did my Spanish practice tonight');
        const running = (await prisma.buddyThread.findMany({ where: { userId: user.id } })).find((x) => /running/i.test(x.title))!;
        expect(running).toMatchObject({ stage: 'noticed', lookAgainOn: null });
        const spanish = await prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } });
        expect(spanish).toMatchObject({ stage: 'active', rhythm: 'daily', lookAgainOn: null });
        // Its history holds the old word, marked for its day.
        const events = await prisma.buddyThreadEvent.findMany({ where: { threadId: t.id }, orderBy: { saidAt: 'asc' } });
        expect(events.map((e) => [e.via, e.kind])).toEqual([
            ['import', 'changed'],
            ['ask_ai', 'done'],
        ]);
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0);
    });
});
