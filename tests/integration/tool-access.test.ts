// TOOL_ACCESS_PLAN §4.7 (11-27): the tools that were missing. Pocket notes stay private until the person allows chats
// at them (Settings › Agents, off by default; an agent can't turn it on): then a chat lists, changes and deletes them,
// each with an Undo. A subject is renamed or described with an Undo; an empty one is deleted at once (the app's own
// undo brings it back); one that holds topics only asks, with a card that waits for their tap.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createLearner, api, createSubjectRow, createTopicRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

const undo = (user: { id: string }, editId: string) => api(user).post(`/api/agent/edits/${editId}/undo`, {});

describe('pocket notes for chats (TOOL_ACCESS_PLAN §4.7)', () => {
    it('stay private until the person allows it; an agent cannot allow it', async () => {
        const NOTE = randomUUID();
        const user = await createLearner();
        await prisma.quickNote.create({ data: { id: NOTE, userId: user.id, content: 'idea: a habit tracker' } });
        const { token } = await createTestToken(user);
        const agent = asAgent(token, 'ChatGPT');
        for (const res of [await agent.get('/api/agent/pocket'), await agent.patch(`/api/agent/pocket/${NOTE}`, { text: 'x' }), await agent.post(`/api/agent/pocket/${NOTE}/delete`, {})]) {
            expect(res.status).toBe(403);
            expect(res.body.message).toBe('Their pocket notes are private. They can allow it in Settings › Agents.');
        }
        expect((await prisma.quickNote.findUniqueOrThrow({ where: { id: NOTE } })).content).toBe('idea: a habit tracker');
        // The switch is the app's only.
        const self = await agent.patch('/api/learning/settings', { pocketForAgents: true });
        expect(self.status).toBe(403);
        expect((await api(user).get('/api/learning/settings')).body.data.pocketForAgents).toBe(false);
    });

    it('once allowed: listed (pinned first, the text cut at 300), changed and deleted, each undoable; scopes hold', async () => {
        const NOTE = randomUUID();
        const user = await createLearner();
        await prisma.quickNote.create({ data: { id: NOTE, userId: user.id, content: `long ${'word '.repeat(80)}` } });
        await prisma.quickNote.create({ data: { id: randomUUID(), userId: user.id, content: 'pinned link', isPinned: true } });
        expect((await api(user).patch('/api/learning/settings', { pocketForAgents: true })).body.data.pocketForAgents).toBe(true);
        const { token } = await createTestToken(user);
        const agent = asAgent(token, 'ChatGPT');

        const list = await agent.get('/api/agent/pocket');
        expect(list.status).toBe(200);
        expect(list.body.data.total).toBe(2);
        expect(list.body.data.notes[0]).toMatchObject({ text: 'pinned link', pinned: true });
        expect(list.body.data.notes[1].cut).toBe(true);
        const one = await agent.get(`/api/agent/pocket?id=${NOTE}`);
        expect(one.body.data.notes[0].cut).toBe(false);

        const changed = await agent.patch(`/api/agent/pocket/${NOTE}`, { text: 'shorter now', pinned: true });
        expect(changed.status).toBe(200);
        expect(changed.body.data).toMatchObject({ text: 'shorter now', pinned: true });
        expect((await undo(user, changed.body.data.editId)).status).toBe(200);
        expect(await prisma.quickNote.findUniqueOrThrow({ where: { id: NOTE } })).toMatchObject({ content: `long ${'word '.repeat(80)}`, isPinned: false });

        const gone = await agent.post(`/api/agent/pocket/${NOTE}/delete`, {});
        expect(gone.body.data).toMatchObject({ id: NOTE, deleted: true });
        expect(await prisma.quickNote.findUnique({ where: { id: NOTE } })).toBeNull();
        expect((await undo(user, gone.body.data.editId)).status).toBe(200);
        expect((await prisma.quickNote.findUniqueOrThrow({ where: { id: NOTE } })).content).toBe(`long ${'word '.repeat(80)}`);

        // A read-only token reads, never changes.
        const reader = asAgent((await createTestToken(user, ['read'])).token);
        expect((await reader.get('/api/agent/pocket')).status).toBe(200);
        expect((await reader.patch(`/api/agent/pocket/${NOTE}`, { pinned: true })).status).toBe(403);
    });
});

describe('subjects for chats (TOOL_ACCESS_PLAN §4.7)', () => {
    it('renamed or described by id or by name, with an Undo; a name they already have is refused', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id, 'DSA');
        await createSubjectRow(user.id, 'System Design');
        const agent = asAgent((await createTestToken(user)).token, 'Claude');
        const renamed = await agent.patch('/api/agent/subjects/dsa', { name: 'Algorithms', description: 'Interview prep' });
        expect(renamed.status).toBe(200);
        expect(renamed.body.data).toMatchObject({ id: s.id, name: 'Algorithms', description: 'Interview prep' });
        expect((await agent.patch(`/api/agent/subjects/${s.id}`, { name: 'system design' })).status).toBe(409);
        expect((await undo(user, renamed.body.data.editId)).status).toBe(200);
        expect(await prisma.subject.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ name: 'DSA', description: null });
    });

    it('an empty one is deleted at once and Undo brings it back; one with topics only asks (a card for their tap)', async () => {
        const user = await createLearner();
        const empty = await createSubjectRow(user.id, 'Scratch');
        const full = await createSubjectRow(user.id, 'DSA');
        await createTopicRow(user.id, full.id, 'Graphs');
        const agent = asAgent((await createTestToken(user)).token, 'ChatGPT');

        const gone = await agent.post(`/api/agent/subjects/${empty.id}/delete`, {});
        expect(gone.status).toBe(200);
        expect(gone.body.data).toMatchObject({ deleted: true, asked: false });
        expect(await prisma.subject.findUnique({ where: { id: empty.id } })).toBeNull();
        expect((await undo(user, gone.body.data.editId)).status).toBe(200);
        expect(await prisma.subject.findUnique({ where: { id: empty.id } })).not.toBeNull();

        const asked = await agent.post('/api/agent/subjects/DSA/delete', { reason: 'They are done with it' });
        expect(asked.status).toBe(200);
        expect(asked.body.data).toMatchObject({ deleted: false, asked: true });
        expect(asked.body.data.text).toMatch(/^Delete the subject "DSA" with 1 topic/);
        expect(await prisma.subject.findUnique({ where: { id: full.id } })).not.toBeNull();
        const card = await prisma.suggestion.findUniqueOrThrow({ where: { id: asked.body.data.suggestionId } });
        expect(card).toMatchObject({ kind: 'action', status: 'pending', agentName: 'ChatGPT' });
    });
});
