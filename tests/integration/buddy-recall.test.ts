// Looking things up (ECOSYSTEM_V2_PLAN §4.12, stage 3, after the evaluation of 11-17, where a health
// limit was lost twice: its memory had faded, and the words asked for were not all in it). An agent's
// search that names no status falls back to any of its words, then to what has faded or closed, never
// to what the person marked wrong; what is going on in their life (threads) is found by its title, its
// keywords and the words of its history, open ones and those closed lately, never another person's.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { addThreadEvent, openOrFindThread, withPersonLock } from '../../src/services/buddy/threads';
import { createTestUser } from '../helpers/auth';
import { asAgent, createTestToken } from '../helpers/agent';

const remember = (chat: ReturnType<typeof asAgent>, body: Record<string, unknown>) => chat.post('/api/buddy/remember', body);
const texts = (res: { body: { data: Array<{ text: string }> } }) => res.body.data.map((m) => m.text);

describe('recall: memories', () => {
    it('any word when none holds them all; then faded and closed ones; never one marked wrong; a named status is kept as asked', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token);
        await remember(chat, { text: 'Plays guitar on weekend mornings', kind: 'fact' });
        await remember(chat, { text: 'Repetitive strain in the left wrist: at most twenty minutes of tight grip at a time', kind: 'state' });
        await remember(chat, { text: 'Hates the gym', kind: 'preference' });
        await prisma.memory.updateMany({ where: { userId: user.id, text: { contains: 'wrist' } }, data: { status: 'faded' } });
        await prisma.memory.updateMany({ where: { userId: user.id, text: { contains: 'gym' } }, data: { status: 'wrong' } });

        // Every word first (unchanged), then any of them.
        expect(texts(await chat.get('/api/buddy/memories?q=guitar+mornings'))).toEqual(['Plays guitar on weekend mornings']);
        expect(texts(await chat.get('/api/buddy/memories?q=guitar+practice'))).toEqual(['Plays guitar on weekend mornings']);
        // What faded is still found when nothing in mind holds the words; it says it faded.
        const wrist = (await chat.get('/api/buddy/memories?q=wrist')).body.data;
        expect(wrist).toHaveLength(1);
        expect(wrist[0]).toMatchObject({ status: 'faded', sensitivity: 'private' });
        expect(texts(await chat.get('/api/buddy/memories?q=grip+exercise'))).toEqual([wrist[0].text]);
        // Never what was marked wrong; a status asked for is kept.
        expect(texts(await chat.get('/api/buddy/memories?q=gym'))).toEqual([]);
        expect(texts(await chat.get('/api/buddy/memories?q=wrist&status=active'))).toEqual([]);
        expect(texts(await chat.get('/api/buddy/memories?q=nothing+like+this'))).toEqual([]);
    });
});

describe('recall: what is going on (threads)', () => {
    it('by title, keywords and the words of its history; closed lately too; newest word first; never another person’s; a read token is enough', async () => {
        const user = await createTestUser();
        const other = await createTestUser();
        const now = new Date('2026-11-25T06:00:00Z');
        const at = (iso: string) => new Date(iso);
        await withPersonLock(user.id, async (tx) => {
            const wrist = (await openOrFindThread(tx, user.id, { title: 'Wrist strain recovery', keywords: ['wrist', 'physio', 'strain'], sensitive: true }, { saidAt: at('2026-09-08T14:31:00Z'), forDay: '2026-09-08' }, now)).thread;
            await addThreadEvent(tx, user.id, wrist, { kind: 'said', text: 'At most twenty minutes of tight grip at a time', saidAt: at('2026-09-08T14:31:00Z'), forDay: '2026-09-08', direct: true, via: 'ask_ai', originKey: 'r:1' }, now);
            const guitar = (await openOrFindThread(tx, user.id, { title: 'Guitar on weekend mornings', keywords: ['guitar', 'music'] }, { saidAt: at('2026-11-20T14:30:00Z'), forDay: '2026-11-20' }, now)).thread;
            await addThreadEvent(tx, user.id, guitar, { kind: 'progress', text: 'Played for fifteen minutes', saidAt: at('2026-11-22T15:30:00Z'), forDay: '2026-11-22', direct: true, via: 'ask_ai', originKey: 'r:2' }, now);
            const pottery = (await openOrFindThread(tx, user.id, { title: 'A pottery class', keywords: ['pottery', 'ceramics'] }, { saidAt: at('2026-10-01T10:00:00Z'), forDay: '2026-10-01' }, now)).thread;
            await tx.buddyThread.update({ where: { id: pottery.id }, data: { stage: 'dropped', closedAt: at('2026-11-15T10:00:00Z') } });
            const chess = (await openOrFindThread(tx, user.id, { title: 'Chess club', keywords: ['chess'] }, { saidAt: at('2026-03-01T10:00:00Z'), forDay: '2026-03-01' }, now)).thread;
            await tx.buddyThread.update({ where: { id: chess.id }, data: { stage: 'dropped', closedAt: at('2026-03-10T10:00:00Z') } });
        });
        await withPersonLock(other.id, (tx) => openOrFindThread(tx, other.id, { title: 'Guitar lessons', keywords: ['guitar'] }, { saidAt: at('2026-11-21T10:00:00Z'), forDay: '2026-11-21' }, now));

        const chat = asAgent((await createTestToken(user, ['read'])).token);
        const find = async (q: string) => (await chat.get(`/api/buddy/threads?q=${encodeURIComponent(q)}`)).body.data as Array<{ title: string; sensitive: boolean; stage: string; last: Array<{ text: string }> }>;
        const titles = async (q: string) => (await find(q)).map((t) => t.title);

        expect(await titles('physio')).toEqual(['Wrist strain recovery']);
        const grip = await find('tight grip');
        expect(grip.map((t) => t.title)).toEqual(['Wrist strain recovery']);
        expect(grip[0]).toMatchObject({ sensitive: true, stage: 'noticed', last: [{ text: 'At most twenty minutes of tight grip at a time' }] });
        expect(await titles('fifteen minutes')).toEqual(['Guitar on weekend mornings']);
        expect(await titles('guitar practice')).toEqual(['Guitar on weekend mornings']);
        expect(await titles('pottery')).toEqual(['A pottery class']);
        expect(await titles('chess')).toEqual([]);
        // Without words: the open ones, the newest word first.
        expect((await chat.get('/api/buddy/threads')).body.data.map((t: { title: string }) => t.title)).toEqual(['Guitar on weekend mornings', 'Wrist strain recovery']);
    });
});
