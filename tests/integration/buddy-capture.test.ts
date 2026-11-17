// Capture (BUDDY_MEMORY_PLAN B2): the hooks' words are scrubbed and queued; the worker gates them
// (Haiku), digests what the gate keeps (Sonnet), writes notes and the buddy's items, and deletes the
// piece; plain coding requests end at the gate; paused, too old or failing pieces are dropped and
// counted; only counts stay. The done-when items of B2, on a fake Claude.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { drainBuddyQueue } from '../../src/services/buddy/worker';
import { DIGEST_SCHEMA, GATE_SCHEMA } from '../../src/services/buddy/digest';
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
beforeEach(async () => {
    fake.reset();
    await prisma.buddyChunk.deleteMany({});
});

const KEY = `sk-ant-api03-${'Ab1'.repeat(12)}`;
const words = (chat: ReturnType<typeof asAgent>, seq: number, texts: string[], over: Record<string, unknown> = {}) =>
    chat.post('/api/buddy/words', { sessionKey: 'cc_s1', seq, project: 'second_brain', messages: texts.map((text, i) => ({ at: new Date(Date.UTC(2026, 10, 16, 9, i)).toISOString(), text })), ...over });

async function hookUser(enabled = true) {
    const user = await createTestUser();
    if (enabled) await api(user).patch('/api/buddy/settings', { enabled: true });
    const hook = asAgent((await createTestToken(user, ['read', 'sessions:write'], 'Claude Code hooks')).token, 'Claude Code hook');
    return { user, hook };
}

describe('the capture queue', () => {
    it('queues scrubbed words once per piece; paused drops them; tokens need sessions:write', async () => {
        const { user, hook } = await hookUser();
        const res = await words(hook, 1, [`here is my key ${KEY} for the deploy`, 'and another message']);
        expect(res.status).toBe(202);
        expect(res.body.data).toEqual({ queued: 2 });
        expect((await words(hook, 1, ['same piece again'])).body.data).toEqual({ queued: 0, duplicate: true });
        const chunk = await prisma.buddyChunk.findFirstOrThrow({ where: { userId: user.id } });
        expect(JSON.stringify(chunk.messages)).not.toContain('sk-ant-');
        expect(JSON.stringify(chunk.messages)).toContain('[secret]');

        await api(user).patch('/api/buddy/settings', { paused: true });
        expect((await words(hook, 2, ['while paused'])).body.data).toEqual({ queued: 0, paused: true });
        const day = await prisma.buddyCaptureDay.findFirstOrThrow({ where: { userId: user.id } });
        expect(day).toMatchObject({ seen: 3, chunks: 1, dropped: 1, secrets: 1 });

        const readOnly = asAgent((await createTestToken(user, ['read'])).token);
        expect((await words(readOnly, 3, ['x'])).status).toBe(403);
        expect((await hook.get('/api/buddy/note')).status).toBe(204);
        expect((await hook.get('/api/buddy/usage')).status).toBe(403);
    });

    it('done when: a task and a private worry from one message; the piece is gone; the task is accepted from Suggested', async () => {
        const { user, hook } = await hookUser();
        await words(hook, 1, ['fix the flaky test in the hook', "remind me to send the form by Friday, and I'm worried I'm behind on graphs", 'yes do it']);
        fake.push(
            fakeMessage({ labels: [{ i: 1, label: 'none' }, { i: 2, label: 'item' }, { i: 3, label: 'none' }] }, { model: 'claude-haiku-5-5' }),
            fakeMessage(
                {
                    notes: [{ text: 'Worried he is behind on graphs', kind: 'state', private: true, seenMemoryId: '' }],
                    items: [{ kind: 'task', text: 'Send the form', dueDay: '2026-11-17', why: '' }],
                },
                { model: 'claude-sonnet-5-5' }
            )
        );
        const r = await drainBuddyQueue(new Date(Date.UTC(2026, 10, 16, 10, 0)));
        expect(r).toEqual({ digested: 1, dropped: 0, failed: 0, waiting: 0 });
        expect(fake.calls.map((c) => c.output_config?.format?.schema)).toEqual([GATE_SCHEMA, DIGEST_SCHEMA]);
        // The digest saw the kept message as KEEP and its neighbours as context only.
        const digestText = JSON.stringify(fake.calls[1]!.messages);
        expect(digestText).toContain('KEEP: remind me to send the form by Friday');
        expect(digestText).toContain('context: fix the flaky test');
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0);

        const note = await prisma.observation.findFirstOrThrow({ where: { userId: user.id } });
        expect(note).toMatchObject({ text: 'Worried he is behind on graphs', kind: 'state', sensitivity: 'private', source: 'hook', sessionKey: 'cc_s1', project: 'second_brain', memoryId: null });
        const item = await prisma.suggestion.findFirstOrThrow({ where: { userId: user.id } });
        // Due within two days: straight to Suggested (pending), from the buddy.
        expect(item).toMatchObject({ kind: 'task', text: 'Send the form', proposedBy: 'buddy', status: 'pending', reason: 'From your chat in second_brain' });
        expect((await api(user).get('/api/buddy/you')).body.data.counts.pending).toBe(1);

        const accepted = await api(user).post(`/api/suggestions/${item.id}/accept`);
        expect(accepted.status).toBe(200);
        expect(accepted.body.data.result).toBe('Added to your tasks, with its day');
        expect(await prisma.todo.count({ where: { userId: user.id, title: 'Send the form' } })).toBe(1);

        const usage = (await api(user).get('/api/buddy/usage')).body.data;
        expect(usage.month.capUsd).toBe(25);
        // Words land on the real day, the drain on 2026-11-16: sum the days so the date of the run doesn't matter.
        const days = usage.days as Array<Record<string, number> & { steps: Record<string, unknown> }>;
        const total = (k: string) => days.reduce((s, d) => s + (d[k] ?? 0), 0);
        expect({ seen: total('seen'), kept: total('kept'), chunks: total('chunks'), notes: total('notes'), items: total('items') }).toEqual({ seen: 3, kept: 1, chunks: 1, notes: 1, items: 1 });
        expect([...new Set(days.flatMap((d) => Object.keys(d.steps)))].sort()).toEqual(['buddy_digest', 'buddy_gate']);
    });

    it('plain coding requests end at the gate (no digest call); a later item waits as a candidate; a repeat bumps the memory it repeats', async () => {
        const { user, hook } = await hookUser();
        const memory = (await api(user).post('/api/buddy/memories', { text: 'Studies best after 9 pm', kind: 'pattern' })).body.data;
        await words(hook, 1, ['rename this function', 'run the tests again']);
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'none' }, { i: 2, label: 'none' }] }));
        await drainBuddyQueue(new Date(Date.UTC(2026, 10, 16, 10, 0)));
        expect(fake.calls).toHaveLength(1);
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0);

        await words(hook, 2, ['again I only got going after 9 pm, and I should read DDIA chapter 6 some time']);
        fake.push(
            fakeMessage({ labels: [{ i: 1, label: 'item' }] }),
            fakeMessage({ notes: [{ text: 'Got going only after 9 pm', kind: 'pattern', private: false, seenMemoryId: memory._id }], items: [{ kind: 'note', text: 'Read DDIA chapter 6', dueDay: '', why: '' }] })
        );
        await drainBuddyQueue(new Date(Date.UTC(2026, 10, 16, 11, 0)));
        expect((await prisma.memory.findUniqueOrThrow({ where: { id: memory._id } })).seenCount).toBe(2);
        expect((await prisma.observation.findFirstOrThrow({ where: { userId: user.id } })).memoryId).toBe(memory._id);
        expect(await prisma.suggestion.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ kind: 'note', status: 'candidate' });
        // Candidates are not shown under Suggested.
        expect((await api(user).get('/api/suggestions')).body.data).toEqual([]);
    });

    it('waits while the buddy is off; drops a piece after 48 hours or three failed tries', async () => {
        const { user, hook } = await hookUser(false);
        await words(hook, 1, ['a thing about me']);
        expect(await drainBuddyQueue(new Date(Date.UTC(2026, 10, 16, 10, 0)))).toMatchObject({ waiting: 1, digested: 0 });
        expect(fake.calls).toHaveLength(0);
        await prisma.buddyChunk.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(Date.now() - 49 * 3600_000) } });
        expect(await drainBuddyQueue()).toMatchObject({ dropped: 1 });
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0);

        await api(user).patch('/api/buddy/settings', { enabled: true });
        await words(hook, 2, ['another thing']);
        // A failure of the piece itself (the model answered in a shape the gate can't read) counts toward its 3 tries.
        fake.push(fakeMessage('not json'), fakeMessage('not json'), fakeMessage('not json'));
        for (let i = 0; i < 3; i++) expect((await drainBuddyQueue()).failed).toBe(1);
        expect(await drainBuddyQueue()).toMatchObject({ dropped: 1 });
        const day = await prisma.buddyCaptureDay.findFirstOrThrow({ where: { userId: user.id } });
        expect(day.dropped).toBe(2);
    });
});
