// SYNC_SPINE_SPEC 1.1: Today's `next` (each path's next topic), a doc written as a planned topic's
// note (create_doc topicId), and update_doc (rename live, file under a subject, move, attach), each
// logged and undoable.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { prisma } from '../../src/db/prisma';
import { hocuspocusServer } from '../../src/collaboration/hocuspocus';
import { initializeCollaboration } from '../../src/collaboration';
import { signAuthToken } from '../../src/services/auth/token';
import { docJsonToYjsState } from '../../src/services/docs/docContent';
import { markdownToDocJson } from '../../src/services/docs/markdown/docMarkdown';
import { createTestUser } from '../helpers/auth';
import { api, createSubjectRow, createTopicRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

async function agentFor(user: { id: string }) {
    const { token } = await createTestToken(user);
    return asAgent(token, 'study-chat');
}

async function plan(user: { id: string }, subjectId: string, titles: string[]) {
    const res = await api(user).post(`/api/subjects/${subjectId}/path`, { titles });
    expect(res.status).toBe(201);
    return res.body.data.path.topics as Array<{ _id: string; title: string; status: string }>;
}

const topicRow = (id: string) => prisma.topic.findUniqueOrThrow({ where: { id }, select: { docId: true, title: true, status: true, startedAt: true, doneAt: true, subjectId: true } });
const lastEdit = (userId: string) => prisma.agentEdit.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: 'desc' } });

describe("Today's next", () => {
    it("one entry per path with something to do: goal-linked subjects first, then the most active; a finished path isn't there", async () => {
        const user = await createTestUser();
        const dsa = await createSubjectRow(user.id, 'DSA');
        const sys = await createSubjectRow(user.id, 'System Design');
        const done = await createSubjectRow(user.id, 'Finished');
        await createTopicRow(user.id, done.id, 'All learned');
        await createTopicRow(user.id, sys.id, '01 · How the web works');
        const sysPath = await plan(user, sys.id, ['Caching', 'Queues']);
        await plan(user, dsa.id, ['Graphs']);
        await api(user).patch(`/api/topics/${sysPath[2]!._id}/path`, { status: 'in_progress', nextStep: 'Do the outbox exercise' });
        // DSA was touched last, but System Design belongs to a goal.
        await api(user).patch(`/api/topics/${(await plan(user, dsa.id, ['Trees']))[1]!._id}/path`, { nextStep: 'Read the tries chapter' });
        const goal = await api(user).post('/api/goals', { title: 'SDE offer', deadline: '2027-05-16', subjectIds: [sys.id] });
        expect(goal.status).toBe(201);

        const today = (await api(user).get('/api/today')).body.data;
        expect(today.next).toEqual([
            {
                subject: { _id: sys.id, name: 'System Design', color: '#007acc' },
                topic: { _id: sysPath[2]!._id, title: 'Queues', position: 3, status: 'in_progress' },
                done: 1,
                total: 3,
                nextStep: 'Do the outbox exercise',
            },
            { subject: { _id: dsa.id, name: 'DSA', color: '#007acc' }, topic: expect.objectContaining({ title: 'Graphs', position: 1, status: 'planned' }), done: 0, total: 2, nextStep: null },
        ]);
        // Agents get it too.
        expect((await (await agentFor(user)).get('/api/today')).body.data.next).toHaveLength(2);
    });
});

describe('create_doc with topicId', () => {
    it("revise: the planned topic gets the doc and its title, is done, and its revisions start; Undo puts the topic back as it was", async () => {
        const user = await createTestUser();
        const sys = await createSubjectRow(user.id, 'System Design');
        const [caching] = await plan(user, sys.id, ['Caching', 'Queues']);
        const agent = await agentFor(user);

        const res = await agent.post('/api/agent/docs', { title: '02 · Caching', markdown: '## The point\n\nKeep hot data close.', topicId: caching!._id, revise: true });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ subject: { id: sys.id, name: 'System Design' }, topicId: caching!._id, topicStatus: 'done', nextRevision: expect.any(String) });
        expect(res.body.data.attached).toBeUndefined();
        const row = await topicRow(caching!._id);
        expect(row).toMatchObject({ docId: res.body.data.id, title: '02 · Caching', status: 'done' });
        expect(row.startedAt).not.toBeNull();
        expect(await prisma.revision.count({ where: { topicId: caching!._id } })).toBe(4);
        const path = (await api(user).get(`/api/subjects/${sys.id}/path`)).body.data;
        expect(path.topics.map((t: { title: string; status: string }) => `${t.title}:${t.status}`)).toEqual(['02 · Caching:done', 'Queues:planned']);
        expect((await lastEdit(user.id)).summary).toBe('Created "02 · Caching" in System Design as a topic of its path and scheduled it for revision');

        expect((await api(user).post(`/api/agent/edits/${(await lastEdit(user.id)).id}/undo`)).status).toBe(200);
        expect(await topicRow(caching!._id)).toMatchObject({ docId: null, title: 'Caching', status: 'planned', startedAt: null, doneAt: null });
        expect(await prisma.revision.count({ where: { topicId: caching!._id } })).toBe(0);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: res.body.data.id } })).isArchived).toBe(true);
    });

    it('without revise the topic is in progress; refused: a topic with a doc, another subject, an unknown topic', async () => {
        const user = await createTestUser();
        const sys = await createSubjectRow(user.id, 'System Design');
        const dsa = await createSubjectRow(user.id, 'DSA');
        const [queues] = await plan(user, sys.id, ['Queues']);
        const agent = await agentFor(user);

        const res = await agent.post('/api/agent/docs', { title: 'Queues', markdown: 'x', topicId: queues!._id });
        expect(res.status).toBe(201);
        expect(res.body.data.topicStatus).toBe('in_progress');
        expect(await topicRow(queues!._id)).toMatchObject({ status: 'in_progress', doneAt: null });

        const again = await agent.post('/api/agent/docs', { title: 'Queues 2', markdown: 'x', topicId: queues!._id });
        expect(again.status).toBe(400);
        expect(again.body.message).toMatch(/already has a doc/);
        const graphs = (await plan(user, sys.id, ['Graphs'])).find((t) => t.title === 'Graphs');
        const wrong = await agent.post('/api/agent/docs', { title: 'Graphs', markdown: 'x', topicId: graphs!._id, subjectId: dsa.id });
        expect(wrong.status).toBe(400);
        expect(wrong.body.message).toMatch(/not on the path of "DSA"/);
        expect((await agent.post('/api/agent/docs', { title: 'X', markdown: 'x', topicId: 'nope0000000000000000000' })).status).toBe(404);
        // Nothing half-made: only the one doc exists.
        expect(await prisma.doc.count({ where: { userId: user.id } })).toBe(1);
    });
});

describe('update_doc', () => {
    it('renames, files under a subject, moves, and makes a doc a planned topic’s note; each change is undoable', async () => {
        const user = await createTestUser();
        const sys = await createSubjectRow(user.id, 'System Design');
        const dsa = await createSubjectRow(user.id, 'DSA');
        const agent = await agentFor(user);
        const made = (await agent.post('/api/agent/docs', { title: 'Untitled notes', markdown: 'x' })).body.data;

        // Rename + file under a subject: one edit.
        const first = await agent.patch(`/api/agent/docs/${made.id}`, { title: 'Rate limiter', subjectId: dsa.id });
        expect(first.status).toBe(200);
        expect(first.body.data).toMatchObject({ title: 'Rate limiter', subject: { id: dsa.id, name: 'DSA' }, changes: ['renamed it "Rate limiter"', 'filed it under DSA'], editId: expect.any(String) });
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: made.id } })).title).toBe('Rate limiter');
        const topicId = first.body.data.topicId as string;

        // Move to another subject: the topic goes along (to the end of that path).
        const moved = await agent.patch(`/api/agent/docs/${made.id}`, { subjectId: sys.id });
        expect(moved.body.data.changes).toEqual(['moved it from DSA to System Design']);
        expect((await topicRow(topicId)).subjectId).toBe(sys.id);

        // Nothing to change: no edit.
        const same = await agent.patch(`/api/agent/docs/${made.id}`, { title: 'Rate limiter' });
        expect(same.body.data).toMatchObject({ changes: [], editId: null });

        // Undo the move, then the rename + filing.
        expect((await api(user).post(`/api/agent/edits/${moved.body.data.editId}/undo`)).status).toBe(200);
        expect((await topicRow(topicId)).subjectId).toBe(dsa.id);
        expect((await api(user).post(`/api/agent/edits/${first.body.data.editId}/undo`)).status).toBe(200);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: made.id } })).title).toBe('Untitled notes');
        expect(await prisma.topic.count({ where: { id: topicId } })).toBe(0);

        // Attach to a planned topic; a doc already on a path can't be attached to another topic.
        const [caching, queues] = await plan(user, sys.id, ['Caching', 'Queues']);
        const attached = await agent.patch(`/api/agent/docs/${made.id}`, { topicId: caching!._id });
        expect(attached.status).toBe(200);
        expect(attached.body.data.changes).toEqual(['made it a topic of the System Design path']);
        expect(await topicRow(caching!._id)).toMatchObject({ docId: made.id, status: 'in_progress', title: 'Untitled notes' });
        const twice = await agent.patch(`/api/agent/docs/${made.id}`, { topicId: queues!._id });
        expect(twice.status).toBe(409);
        expect(twice.body.message).toMatch(/already topic/);
        expect((await api(user).post(`/api/agent/edits/${attached.body.data.editId}/undo`)).status).toBe(200);
        expect(await topicRow(caching!._id)).toMatchObject({ docId: null, status: 'planned', title: 'Caching' });
    });

    it("Undo of a rename keeps Ramin's own later rename", async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const made = (await agent.post('/api/agent/docs', { title: 'Draft', markdown: 'x' })).body.data;
        const renamed = await agent.patch(`/api/agent/docs/${made.id}`, { title: 'Agent title' });
        await prisma.doc.update({ where: { id: made.id }, data: { title: 'My own title', yjsState: docJsonToYjsState(markdownToDocJson('x'), { title: 'My own title', coverImage: null }) } });
        expect((await api(user).post(`/api/agent/edits/${renamed.body.data.editId}/undo`)).status).toBe(200);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: made.id } })).title).toBe('My own title');
    });
});

describe('update_doc reaches an open editor', () => {
    let url = '';
    let provider: HocuspocusProvider | null = null;

    beforeAll(async () => {
        initializeCollaboration();
        const server = hocuspocusServer as any;
        server.configuration.port = 0;
        server.configuration.quiet = true;
        server.configuration.stopOnSignals = false;
        server.hocuspocus.configuration.debounce = 50;
        server.hocuspocus.configuration.maxDebounce = 200;
        await hocuspocusServer.listen();
        url = `ws://127.0.0.1:${hocuspocusServer.address.port}`;
    });

    afterAll(async () => {
        provider?.destroy();
        await hocuspocusServer.destroy();
    });

    it("the open editor's title changes at once; Undo changes it back", async () => {
        const user = await createTestUser();
        const doc = await prisma.doc.create({ data: { userId: user.id, title: 'Before', yjsState: docJsonToYjsState(markdownToDocJson('body'), { title: 'Before', coverImage: null }) } });
        const document = new Y.Doc();
        provider = new HocuspocusProvider({ url, name: `doc_${doc.id}`, document, token: signAuthToken(user.id) });
        await vi.waitFor(() => expect(provider!.synced).toBe(true), { timeout: 10_000, interval: 20 });
        const meta = document.getMap('metadata');
        expect(meta.get('title')).toBe('Before');

        const res = await (await agentFor(user)).patch(`/api/agent/docs/${doc.id}`, { title: 'After' });
        expect(res.status).toBe(200);
        await vi.waitFor(() => expect(meta.get('title')).toBe('After'), { timeout: 10_000, interval: 20 });
        await vi.waitFor(async () => expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).title).toBe('After'), { timeout: 10_000, interval: 50 });

        expect((await api(user).post(`/api/agent/edits/${res.body.data.editId}/undo`)).status).toBe(200);
        await vi.waitFor(() => expect(meta.get('title')).toBe('Before'), { timeout: 10_000, interval: 20 });
    });
});
