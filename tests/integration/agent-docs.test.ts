// Docs for agents (/api/agent/docs): create, read as Markdown, search, append, replace a section,
// Undo, Idempotency-Key, and the live path: an editor connected to the doc over Hocuspocus gets an
// agent append at once and keeps its own concurrent typing, before and after Undo.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

vi.mock('upfly', async () => (await import('../helpers/uploads')).createUpflyMock());
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));

import { prisma } from '../../src/db/prisma';
import { hocuspocusServer } from '../../src/collaboration/hocuspocus';
import { initializeCollaboration } from '../../src/collaboration';
import { signAuthToken } from '../../src/services/auth/token';
import { readBoard } from '../../src/services/docs/canvas';
import { readBlocks } from '../../src/services/docs/blocks/serverEditor';
import { docJsonToYjsState, yjsStateToDocJson } from '../../src/services/docs/docContent';
import { docJsonToMarkdown, docJsonToYElements, markdownToBlocks, markdownToDocJson } from '../../src/services/docs/markdown/docMarkdown';
import { createTestUser } from '../helpers/auth';
import { api, createSubjectRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    // Hocuspocus logs every (direct) connection.
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

/** A doc owned by `userId` whose content is this Markdown (as the editor would have stored it). */
async function docFromMarkdown(userId: string, title: string, md: string) {
    return prisma.doc.create({ data: { userId, title, yjsState: docJsonToYjsState(markdownToDocJson(md)) } });
}

async function storedMarkdown(docId: string): Promise<string> {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
    return row.yjsState ? docJsonToMarkdown(yjsStateToDocJson(row.yjsState)) : '';
}

async function agentFor(user: { id: string }, name = 'Claude Code') {
    const { token } = await createTestToken(user);
    return asAgent(token, name);
}

describe('POST /api/agent/docs', () => {
    it('creates a doc from Markdown: content, title in the metadata map, preview, log line', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const md = '# Postgres locks\n\n> [!TIP]\n> Row locks are taken by **UPDATE**.\n\n- [ ] read MVCC';
        const res = await agent.post('/api/agent/docs', { title: '  Postgres locks ', markdown: md });
        expect(res.status).toBe(201);
        expect(res.body.data).toEqual({ id: expect.any(String), title: 'Postgres locks', subject: null, topicId: null, nextRevision: null, editId: expect.any(String) });

        const row = await prisma.doc.findUniqueOrThrow({ where: { id: res.body.data.id } });
        expect(row).toMatchObject({ userId: user.id, title: 'Postgres locks', isArchived: false });
        expect(row.previewState).toContain('Row locks are taken by');
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, row.yjsState!);
        expect(ydoc.getMap('metadata').get('title')).toBe('Postgres locks');
        ydoc.destroy();
        expect(await storedMarkdown(row.id)).toBe(md);

        const edit = await prisma.agentEdit.findUniqueOrThrow({ where: { id: res.body.data.editId } });
        expect(edit).toMatchObject({ kind: 'doc_create', docId: row.id, entityId: row.id, agentName: 'Claude Code', summary: 'Created "Postgres locks"' });
    });

    it('with subjectId + revise: filed under the subject and scheduled (1, 3, 7, 21 days) by the learning service', async () => {
        const user = await createTestUser();
        const subject = await createSubjectRow(user.id, 'Databases');
        const agent = await agentFor(user);
        const res = await agent.post('/api/agent/docs', { title: 'MVCC', markdown: 'Snapshots.', subjectId: subject.id, revise: true });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ subject: { id: subject.id, name: 'Databases' }, topicId: expect.any(String), nextRevision: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });

        const byDoc = await api(user).get(`/api/topics/by-doc/${res.body.data.id}`);
        expect(byDoc.body.data.topic).toMatchObject({ _id: res.body.data.topicId, subjectId: subject.id, title: 'MVCC' });
        expect(byDoc.body.data.chain.map((r: { intervalDays: number }) => r.intervalDays)).toEqual([1, 3, 7, 21]);
        const edit = await prisma.agentEdit.findUniqueOrThrow({ where: { id: res.body.data.editId } });
        expect(edit.summary).toBe('Created "MVCC" in Databases and scheduled it for revision');

        // Filed without revise: a topic, no revisions.
        const filed = await agent.post('/api/agent/docs', { title: 'Indexes', markdown: '', subjectId: subject.id });
        expect(filed.body.data).toMatchObject({ topicId: expect.any(String), nextRevision: null });
        expect(await prisma.revision.count({ where: { topicId: filed.body.data.topicId } })).toBe(0);
    });

    it('400 for a missing title, revise without a subject; 404 for a subject that is not yours', async () => {
        const user = await createTestUser();
        const other = await createTestUser();
        const othersSubject = await createSubjectRow(other.id);
        const agent = await agentFor(user);
        expect((await agent.post('/api/agent/docs', { title: '  ', markdown: 'x' })).status).toBe(400);
        const revise = await agent.post('/api/agent/docs', { title: 'x', markdown: 'x', revise: true });
        expect(revise.status).toBe(400);
        expect(revise.body.message).toBe('revise needs a subjectId (the subject to revise it under) or a topicId');
        const foreign = await agent.post('/api/agent/docs', { title: 'x', markdown: 'x', subjectId: othersSubject.id });
        expect(foreign.status).toBe(404);
        expect(await prisma.doc.count({ where: { userId: user.id } })).toBe(0);
    });

    it('Undo archives the doc and drops its topic', async () => {
        const user = await createTestUser();
        const subject = await createSubjectRow(user.id);
        const created = (await (await agentFor(user)).post('/api/agent/docs', { title: 'Oops', markdown: 'x', subjectId: subject.id, revise: true })).body.data;
        const undo = await api(user).post(`/api/agent/edits/${created.editId}/undo`);
        expect(undo.status).toBe(200);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: created.id } })).isArchived).toBe(true);
        expect(await prisma.topic.count({ where: { id: created.topicId } })).toBe(0);
    });
});

describe('GET /api/agent/docs and /:id', () => {
    it("reads a doc as Markdown with its subject; another user's doc is a 404; a viewer can read but not edit", async () => {
        const [owner, viewer, stranger] = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
        const subject = await createSubjectRow(owner.id, 'DSA');
        const doc = await docFromMarkdown(owner.id, 'Heaps', '## Idea\n\nA **heap** keeps the min on top.');
        const topic = await prisma.topic.create({ data: { userId: owner.id, subjectId: subject.id, docId: doc.id, title: 'Heaps' } });
        await prisma.docCollaborator.create({ data: { docId: doc.id, userId: viewer.id, role: 'viewer' } });

        const res = await (await agentFor(owner)).get(`/api/agent/docs/${doc.id}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            id: doc.id,
            title: 'Heaps',
            // DOC_PAGES_PLAN: a top-level doc with no pages inside.
            path: [],
            pages: [],
            markdown: '## Idea\n\nA **heap** keeps the min on top.',
            subject: { id: subject.id, name: 'DSA' },
            topicId: topic.id,
            updatedAt: expect.any(String),
            canEdit: true,
            // STUDY_FLOW_PLAN: no revision card, no notes on its lesson yet.
            card: false,
            notes: 0,
        });

        const viewerAgent = await agentFor(viewer);
        expect((await viewerAgent.get(`/api/agent/docs/${doc.id}`)).body.data).toMatchObject({ canEdit: false, subject: null, topicId: null });
        const blocked = await viewerAgent.post(`/api/agent/docs/${doc.id}/append`, { markdown: 'nope' });
        expect(blocked.status).toBe(403);
        expect(blocked.body.message).toBe('Viewers cannot edit this document');
        expect((await (await agentFor(stranger)).get(`/api/agent/docs/${doc.id}`)).status).toBe(404);
    });

    it('searches titles and text (all words, any case, full-text): own + shared docs, not archived; small results with snippets', async () => {
        const [user, friend, stranger] = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
        const subject = await createSubjectRow(user.id, 'Databases');
        const locks = await docFromMarkdown(user.id, 'Postgres locks', 'Row locks block **writers**, not readers.');
        await prisma.topic.create({ data: { userId: user.id, subjectId: subject.id, docId: locks.id, title: 'Postgres locks' } });
        const mvcc = await docFromMarkdown(user.id, 'MVCC notes', 'Each row has xmin and xmax. Readers never block on row locks.');
        const shared = await docFromMarkdown(friend.id, 'Friend doc on locks', 'Shared with me.');
        await prisma.docCollaborator.create({ data: { docId: shared.id, userId: user.id, role: 'editor' } });
        await docFromMarkdown(user.id, 'Archived locks', 'old').then((d) => prisma.doc.update({ where: { id: d.id }, data: { isArchived: true } }));
        await docFromMarkdown(stranger.id, 'Stranger locks', 'private');

        const agent = await agentFor(user);
        const res = await agent.get('/api/agent/docs?query=LOCKS');
        expect(res.status).toBe(200);
        const ids = res.body.data.map((d: { id: string }) => d.id);
        // Best match first: in the title and the text, then in the title alone, then in the text.
        expect(ids).toEqual([locks.id, shared.id, mvcc.id]);
        expect(res.body.data[0]).toEqual({ id: locks.id, title: 'Postgres locks', subject: 'Databases', updatedAt: expect.any(String), snippet: 'Row locks block writers, not readers' });
        expect(res.body.data[2].snippet).toContain('block on row locks');

        expect((await agent.get('/api/agent/docs?query=row%20readers')).body.data.map((d: { id: string }) => d.id).sort()).toEqual([locks.id, mvcc.id].sort());
        expect((await agent.get('/api/agent/docs?query=nothing-like-this')).body.data).toEqual([]);
        expect((await agent.get('/api/agent/docs?limit=1')).body.data).toHaveLength(1);
        expect((await agent.get('/api/agent/docs?limit=0')).status).toBe(400);
    });
});

describe('append and replace-section', () => {
    it('appends blocks at the end (before the trailing empty paragraph), stored with a snapshot and a log line', async () => {
        const user = await createTestUser();
        const doc = await prisma.doc.create({
            data: { userId: user.id, title: 'Notes', yjsState: docJsonToYjsState({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }, { type: 'paragraph' }] }) },
        });
        const before = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        const agent = await agentFor(user);

        const res = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: 'second\n\nthird' });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ id: doc.id, appended: 2, editId: expect.any(String) });

        const row = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        const blocks = (yjsStateToDocJson(row.yjsState!).content as Array<{ type: string }>).map((b) => b.type);
        expect(blocks).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph']);
        expect(await storedMarkdown(doc.id)).toBe('first\n\nsecond\n\nthird');
        expect(row.previewState).toContain('third');
        expect(row.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

        const edit = await prisma.agentEdit.findUniqueOrThrow({ where: { id: res.body.data.editId }, include: { snapshot: true } });
        expect(edit).toMatchObject({ kind: 'doc_append', docId: doc.id, summary: 'Appended 2 paragraphs to "Notes"' });
        expect(edit.snapshot!.yjsState).toEqual(before.yjsState);
        expect(edit.snapshot!.agentUpdate).toEqual(expect.any(Uint8Array));
        // The doc was unloaded from the collaboration server afterwards (nobody else had it open).
        expect(hocuspocusServer.hocuspocus.documents.has(`doc_${doc.id}`)).toBe(false);
    });

    it('replaces a section body (heading kept), matched case-insensitively, up to the next heading of the same level', async () => {
        const user = await createTestUser();
        const doc = await docFromMarkdown(user.id, 'Locks', '# Locks\n\n## Intro\n\nold intro\n\n### Detail\n\nold detail\n\n## Next\n\nkeep me');
        const agent = await agentFor(user);
        const res = await agent.post(`/api/agent/docs/${doc.id}/replace-section`, { heading: '  ## intro ', markdown: 'New intro.\n\n- point' });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ id: doc.id, heading: 'Intro', removed: 3, inserted: 2, editId: expect.any(String) });
        expect(await storedMarkdown(doc.id)).toBe('# Locks\n\n## Intro\n\nNew intro.\n\n- point\n\n## Next\n\nkeep me');
        expect((await prisma.agentEdit.findUniqueOrThrow({ where: { id: res.body.data.editId } })).summary).toBe('Rewrote section "Intro" in "Locks"');
    });

    it('replaces the heading too when the Markdown starts with a heading of that level', async () => {
        const user = await createTestUser();
        const doc = await docFromMarkdown(user.id, 'D', '## Old name\n\nbody\n\n## Other\n\nx');
        const res = await (await agentFor(user)).post(`/api/agent/docs/${doc.id}/replace-section`, { heading: 'Old name', markdown: '## New name\n\nnew body' });
        expect(res.body.data).toMatchObject({ removed: 2, inserted: 2 });
        expect(await storedMarkdown(doc.id)).toBe('## New name\n\nnew body\n\n## Other\n\nx');
    });

    it('404 listing the headings when the heading is not there (the doc is not touched); 400 for empty markdown', async () => {
        const user = await createTestUser();
        const doc = await docFromMarkdown(user.id, 'D', '## Alpha\n\na\n\n### Beta\n\nb');
        const before = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        const agent = await agentFor(user);
        const res = await agent.post(`/api/agent/docs/${doc.id}/replace-section`, { heading: 'Gamma', markdown: 'x' });
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('Heading "Gamma" not found in this doc. Its headings: "Alpha", "Beta".');
        expect(await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).toEqual(before);
        expect((await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: '   ' })).status).toBe(400);
        expect((await agent.post(`/api/agent/docs/${doc.id}/replace-section`, { heading: '', markdown: 'x' })).status).toBe(400);
        expect((await agent.post('/api/agent/docs/nope/append', { markdown: 'x' })).status).toBe(404);
    });

    it('Undo restores the doc (append and replace-section), once; agents cannot undo', async () => {
        const user = await createTestUser();
        const md = '## A\n\nkeep a\n\n## B\n\nold b';
        const doc = await docFromMarkdown(user.id, 'Undo me', md);
        const agent = await agentFor(user);
        const replaced = (await agent.post(`/api/agent/docs/${doc.id}/replace-section`, { heading: 'A', markdown: 'new a' })).body.data;
        const appended = (await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: 'tail' })).body.data;
        expect(await storedMarkdown(doc.id)).toBe('## A\n\nnew a\n\n## B\n\nold b\n\ntail');

        // The older edit can be undone on its own: the later append stays.
        expect((await agent.post(`/api/agent/edits/${replaced.editId}/undo`)).status).toBe(403);
        expect((await api(user).post(`/api/agent/edits/${replaced.editId}/undo`)).status).toBe(200);
        expect(await storedMarkdown(doc.id)).toBe('## A\n\nkeep a\n\n## B\n\nold b\n\ntail');
        expect((await api(user).post(`/api/agent/edits/${appended.editId}/undo`)).status).toBe(200);
        expect(await storedMarkdown(doc.id)).toBe(md);
        expect((await api(user).post(`/api/agent/edits/${appended.editId}/undo`)).status).toBe(409);

        const listed = (await api(user).get('/api/agent/edits')).body.data;
        expect(listed.map((e: { kind: string; canUndo: boolean }) => [e.kind, e.canUndo])).toEqual([
            ['doc_append', false],
            ['doc_replace_section', false],
        ]);
    });

    it('uploaded images: kept by src when the agent rewrites around them, and not cleaned up while Undo can bring them back', async () => {
        const user = await createTestUser();
        const src = 'https://res.cloudinary.test/recollect/img1.webp';
        const imageNode = { type: 'resizableImage', attrs: { src, alt: 'diagram', imageId: 'img1', cloudPublicId: 'recollect/img1', cloudProvider: 'cloudinary', width: '60%', height: 'auto' } };
        const content = (...nodes: object[]) => docJsonToYjsState({ type: 'doc', content: nodes });
        const heading = (text: string) => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] });
        const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
        const cloudImages = [{ imageId: 'img1', cloudUrl: src, cloudPublicId: 'recollect/img1' }];
        const doc = await prisma.doc.create({
            data: { userId: user.id, title: 'Pics', yjsState: content(heading('Fig'), para('old caption'), imageNode, heading('End'), para('x')), cloudImages },
        });
        const agent = await agentFor(user);
        const deleted = vi.mocked((await import('../../src/utils/cloudinary')).batchDeleteFromCloud);
        deleted.mockClear();

        /** The stored doc's image node attrs (undefined when it has none). */
        const storedImage = async () => {
            const row = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
            const blocks = yjsStateToDocJson(row.yjsState!).content as Array<{ type: string; attrs?: Record<string, unknown> }>;
            return blocks.find((b) => b.type === 'resizableImage')?.attrs;
        };

        // 1. The agent keeps the image line: the new node keeps its upload tracking (and the file).
        const kept = await agent.post(`/api/agent/docs/${doc.id}/replace-section`, { heading: 'Fig', markdown: `new caption\n\n![diagram](${src})` });
        expect(kept.status).toBe(200);
        expect(await storedImage()).toMatchObject({ src, imageId: 'img1', cloudPublicId: 'recollect/img1', width: '60%' });
        expect(deleted).not.toHaveBeenCalled();

        // 2. The agent drops the image: the file stays while that edit can be undone, and Undo brings it back.
        const dropped = await agent.post(`/api/agent/docs/${doc.id}/replace-section`, { heading: 'Fig', markdown: 'no picture now' });
        expect(dropped.status).toBe(200);
        expect(await storedImage()).toBeUndefined();
        expect(deleted).not.toHaveBeenCalled();
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).cloudImages).toEqual(cloudImages);
        expect((await api(user).post(`/api/agent/edits/${dropped.body.data.editId}/undo`)).status).toBe(200);
        expect(await storedImage()).toMatchObject({ src, imageId: 'img1' });
        expect(deleted).not.toHaveBeenCalled();
    });

    it('Idempotency-Key: a retried append is applied once and answers the same', async () => {
        const user = await createTestUser();
        const doc = await docFromMarkdown(user.id, 'Once', 'start');
        const agent = await agentFor(user);
        const key = { 'Idempotency-Key': 'append-once-1' };
        const first = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: 'added' }, key);
        const second = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: 'added' }, key);
        expect(second.body).toEqual(first.body);
        expect(second.headers['idempotent-replayed']).toBe('true');
        expect(await storedMarkdown(doc.id)).toBe('start\n\nadded');
        expect(await prisma.agentEdit.count({ where: { docId: doc.id } })).toBe(1);
        expect((await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: 'different' }, key)).status).toBe(422);
    });
});

// ─── Canvas blocks (a ```canvas fence; the board lives in the doc's canvas maps) ──────────────────

const CANVAS_FENCE = [
    '```canvas',
    '{"layout": "LR", "nodes": [',
    '  {"id": "client", "text": "Browser", "shape": "pill"},',
    '  {"id": "api", "text": "API gateway"},',
    '  {"id": "db", "text": "Postgres", "shape": "database", "color": "blue"}',
    '], "edges": [',
    '  {"from": "client", "to": "api", "label": "HTTPS"},',
    '  {"from": "api", "to": "db", "label": "SQL", "line": "dashed"}',
    ']}',
    '```',
].join('\n');

/** The stored Y.Doc of a doc. */
async function storedYDoc(docId: string): Promise<Y.Doc> {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, row.yjsState!);
    return ydoc;
}

/** The canvas ids printed in some Markdown (the text form's first line). */
const fenceIds = (md: string) => [...md.matchAll(/%% id: (cv_[A-Za-z0-9_-]{12})/g)].map((m) => m[1]!);

describe('canvas blocks', () => {
    it('create_doc with a canvas: made on the new editor (blocks only); the board goes into the canvas maps; read_doc prints the fence with its id; search finds its words', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const res = await agent.post('/api/agent/docs', { title: 'Checkout design', markdown: `## Overview\n\n${CANVAS_FENCE}\n\nThe gateway fans out.` });
        expect(res.status).toBe(201);

        const ydoc = await storedYDoc(res.body.data.id);
        expect(ydoc.share.has('default')).toBe(false);
        expect(ydoc.getMap('metadata').get('title')).toBe('Checkout design');
        const blocks = readBlocks(ydoc);
        expect(blocks.map((b) => b.type)).toEqual(['heading', 'canvas', 'paragraph']);
        expect(blocks[1]!.props['data']).toBeUndefined();
        const canvasId = blocks[1]!.props['canvasId'] as string;
        expect(readBoard(ydoc, canvasId).nodes.map((n) => n.text)).toEqual(['Browser', 'API gateway', 'Postgres']);
        ydoc.destroy();
        // A JSON fence is reported too.
        expect(res.body.data.canvases).toEqual([{ canvasId, boxes: 3, arrows: 2, zones: 0, width: expect.any(Number), height: expect.any(Number), zoom: expect.any(Number), warnings: [] }]);

        // read_doc prints the text form, with the canvas id first.
        const markdown = (await agent.get(`/api/agent/docs/${res.body.data.id}`)).body.data.markdown as string;
        expect(fenceIds(markdown)).toEqual([canvasId]);
        expect(markdown).toContain('\n  db[(Postgres)]:::blue\n');
        expect(markdown).toContain('\n  api -.->|SQL| db\n');
        expect(markdown.endsWith('```\n\nThe gateway fans out.')).toBe(true);

        const found = (await agent.get('/api/agent/docs?query=postgres%20gateway')).body.data;
        expect(found.map((d: { id: string }) => d.id)).toEqual([res.body.data.id]);
        expect(found[0].snippet).toContain('Postgres');
    });

    it('append a canvas fence → read_doc shows it → Undo removes the block and its board', async () => {
        const user = await createTestUser();
        const doc = await docFromMarkdown(user.id, 'Sketch', '## Notes\n\nfirst');
        const agent = await agentFor(user);
        const res = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: `## Architecture\n\n${CANVAS_FENCE}` });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ appended: 2 });

        const read = (await agent.get(`/api/agent/docs/${doc.id}`)).body.data.markdown as string;
        expect(read.startsWith('## Notes\n\nfirst\n\n## Architecture\n\n```canvas\n%% id: cv_')).toBe(true);
        const [canvasId] = fenceIds(read);
        expect(res.body.data.canvases.map((c: { canvasId: string }) => c.canvasId)).toEqual([canvasId]);
        expect(read).toContain('\n  client([Browser])\n');
        let ydoc = await storedYDoc(doc.id);
        expect(readBoard(ydoc, canvasId!).edges.map((e) => e.label)).toEqual(['HTTPS', 'SQL']);
        ydoc.destroy();

        expect((await api(user).post(`/api/agent/edits/${res.body.data.editId}/undo`)).status).toBe(200);
        expect((await agent.get(`/api/agent/docs/${doc.id}`)).body.data.markdown).toBe('## Notes\n\nfirst');
        ydoc = await storedYDoc(doc.id);
        expect(readBoard(ydoc, canvasId!)).toEqual({ nodes: [], edges: [] });
        ydoc.destroy();
    });

    it('replace-section with an edited fence (same %% id) updates that canvas in place; Undo brings the old board back whole', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const created = (await agent.post('/api/agent/docs', { title: 'Design', markdown: `## Diagram\n\n${CANVAS_FENCE}\n\n## Next\n\nkeep` })).body.data;
        const original = (await agent.get(`/api/agent/docs/${created.id}`)).body.data.markdown as string;
        const [oldId] = fenceIds(original);

        // The agent edits the fence it read: renames a box and adds a cache, with an arrow to it.
        const edited = original
            .slice(original.indexOf('```canvas'), original.indexOf('```\n\n## Next') + 3)
            .replace('db[(Postgres)]', 'db[(Postgres 17)]')
            .replace('\n```', '\n  api -->|read| cache[(Redis)]:::red\n```');
        const res = await agent.post(`/api/agent/docs/${created.id}/replace-section`, { heading: 'Diagram', markdown: edited });
        expect(res.status).toBe(200);
        const after = (await agent.get(`/api/agent/docs/${created.id}`)).body.data.markdown as string;
        const [newId] = fenceIds(after);
        // AGENT_DIAGRAMS_PLAN step 2: the fence's id names the board, so it is changed in place.
        expect(newId).toBe(oldId);
        expect(res.body.data.canvases).toEqual([expect.objectContaining({ canvasId: oldId, boxes: 4, arrows: 3 })]);
        expect(after).toContain('\n  db[(Postgres 17)]:::blue\n');
        expect(after).toContain('\n  cache[(Redis)]:::red\n');
        expect(after).toContain('\n  api -->|read| cache\n');
        expect(after.endsWith('## Next\n\nkeep')).toBe(true);

        expect((await api(user).post(`/api/agent/edits/${res.body.data.editId}/undo`)).status).toBe(200);
        expect((await agent.get(`/api/agent/docs/${created.id}`)).body.data.markdown).toBe(original);
    });

    it('a canvas fence that is no board is a 400 that says what to fix, and the doc is not touched', async () => {
        const user = await createTestUser();
        const doc = await docFromMarkdown(user.id, 'D', 'text');
        const before = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        const agent = await agentFor(user);
        const badJson = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: '```canvas\n{nodes: []}\n```' });
        expect(badJson.status).toBe(400);
        expect(badJson.body.message).toMatch(/^The canvas block is not valid JSON: /);
        const badEdge = await agent.post('/api/agent/docs', { title: 'x', markdown: '```canvas\n{"nodes": [{"id": "a"}], "edges": [{"from": "a", "to": "b"}]}\n```' });
        expect(badEdge.status).toBe(400);
        expect(badEdge.body.message).toBe('Edge 1 points at "b", which is not a node. Node ids: "a".');
        expect(await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).toEqual(before);
        expect(await prisma.doc.count({ where: { userId: user.id } })).toBe(1);
    });
});

// ─── The text form (AGENT_DIAGRAMS_PLAN §4.1): laid out by ELK, reported on ────────────────────

const DIAGRAM = [
    '```canvas',
    'flowchart LR',
    '  user([User]) -->|HTTPS| lb[Load balancer]',
    '  subgraph api [API tier]',
    '    a1[API server 1]',
    '    a2[API server 2]',
    '  end',
    '  lb --> a1 & a2',
    '  a1 & a2 -->|SQL| db[(Postgres)]@{ kind: database }:::blue',
    '  note for db: Primary + replicas',
    '```',
].join('\n');

describe('canvas blocks in the text form', () => {
    it('create_doc lays the diagram out (zones, routed arrows) and answers with a report per canvas', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const res = await agent.post('/api/agent/docs', { title: 'Request path', markdown: `## Path\n\n${DIAGRAM}\n\n## Second\n\n${DIAGRAM.replace('flowchart LR', 'flowchart TB')}` });
        expect(res.status).toBe(201);
        const { canvases } = res.body.data;
        expect(canvases).toHaveLength(2);
        expect(canvases[0]).toEqual({ canvasId: expect.stringMatching(/^cv_/), boxes: 6, arrows: 6, zones: 1, width: expect.any(Number), height: expect.any(Number), zoom: expect.any(Number), warnings: expect.any(Array) });
        expect(canvases[1].canvasId).not.toBe(canvases[0].canvasId);

        const ydoc = await storedYDoc(res.body.data.id);
        const board = readBoard(ydoc, canvases[0].canvasId);
        ydoc.destroy();
        expect(board.nodes.find((n) => n.id === 'a1')).toMatchObject({ parent: 'api' });
        expect(board.nodes.find((n) => n.id === 'db')).toMatchObject({ shape: 'cylinder', kind: 'database', color: 'blue' });
        expect(board.edges.every((e) => e.path === 'elbow' && (e.route?.points.length ?? 0) >= 2)).toBe(true);
        expect(canvases[0].width).toBeGreaterThan(canvases[1].width);

        const markdown = (await agent.get(`/api/agent/docs/${res.body.data.id}`)).body.data.markdown as string;
        expect(fenceIds(markdown)).toEqual(canvases.map((c: { canvasId: string }) => c.canvasId));
        expect(markdown).toContain('  subgraph api [API tier]\n    a1[API server 1]\n    a2[API server 2]\n  end\n');
        expect(markdown).toContain('  note note1 for db: Primary + replicas');
    });

    it('append and replace-section report their canvases; a diagram that can not be read is a 400 naming its line, and the doc is not touched', async () => {
        const user = await createTestUser();
        const doc = await docFromMarkdown(user.id, 'Sketch', '## Notes\n\nfirst');
        const agent = await agentFor(user);
        const appended = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: `## Diagram\n\n${DIAGRAM}` });
        expect(appended.status).toBe(200);
        expect(appended.body.data).toMatchObject({ appended: 2, canvases: [expect.objectContaining({ boxes: 6, arrows: 6, zones: 1 })] });

        const replaced = await agent.post(`/api/agent/docs/${doc.id}/replace-section`, { heading: 'Diagram', markdown: '```canvas\na --> b\n```' });
        expect(replaced.status).toBe(200);
        expect(replaced.body.data.canvases).toEqual([expect.objectContaining({ boxes: 2, arrows: 1, zones: 0, warnings: [] })]);
        expect(replaced.body.data.canvases[0].canvasId).not.toBe(appended.body.data.canvases[0].canvasId);

        const before = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        const bad = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: 'Text\n\n```canvas\nflowchart LR\n  a --> b\n  b -> c\n```' });
        expect(bad.status).toBe(400);
        expect(bad.body.message).toMatch(/^line 3: "->" is not an arrow\. Arrows: -->/);
        const badKind = await agent.post('/api/agent/docs', { title: 'x', markdown: '```canvas\nq@{ kind: blockchain }\n```' });
        expect(badKind.status).toBe(400);
        expect(badKind.body.message).toMatch(/^line 1: "q": "blockchain" is not a kind\. Kinds: client, user, /);
        expect(await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).toEqual(before);
        expect(await prisma.doc.count({ where: { userId: user.id } })).toBe(1);
    });
});

// ─── Live: a real Hocuspocus server and an editor connected over WebSocket ───────────────────────

describe('agent writes reach an open editor live', () => {
    let url = '';
    const providers: HocuspocusProvider[] = [];

    beforeAll(async () => {
        initializeCollaboration();
        const server = hocuspocusServer as any;
        server.configuration.port = 0; // a free port: never the dev server's 1234
        server.configuration.quiet = true;
        server.configuration.stopOnSignals = false;
        server.hocuspocus.configuration.debounce = 50;
        server.hocuspocus.configuration.maxDebounce = 200;
        await hocuspocusServer.listen();
        url = `ws://127.0.0.1:${hocuspocusServer.address.port}`;
    });

    afterEach(() => {
        for (const provider of providers.splice(0)) provider.destroy();
    });

    afterAll(async () => {
        await hocuspocusServer.destroy();
    });

    async function connect(docId: string, userId: string) {
        const document = new Y.Doc();
        const provider = new HocuspocusProvider({ url, name: `doc_${docId}`, document, token: signAuthToken(userId) });
        providers.push(provider);
        await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 10_000, interval: 20 });
        return { provider, document, fragment: document.getXmlFragment('default') };
    }

    const markdownOf = (fragment: Y.XmlFragment) => docJsonToMarkdown(yjsStateToDocJson(Buffer.from(Y.encodeStateAsUpdate(fragment.doc!)).toString('base64')));

    it("an agent append shows up in the editor without losing the editor's concurrent typing; Undo too", async () => {
        const user = await createTestUser();
        const doc = await docFromMarkdown(user.id, 'Live', '## Notes\n\nfirst line');
        const editor = await connect(doc.id, user.id);
        expect(markdownOf(editor.fragment)).toBe('## Notes\n\nfirst line');

        // The person types (a new paragraph and more text in the first one) while the agent appends:
        // the editor's change is not acknowledged by the server yet when the request is sent.
        editor.document.transact(() => {
            editor.fragment.insert(2, docJsonToYElements({ type: 'doc', content: markdownToBlocks('typed by me') }));
            const run = (editor.fragment.get(1) as Y.XmlElement).get(0) as Y.XmlText;
            run.insert(run.length, ' (edited)');
        });
        const agent = await agentFor(user);
        const appended = agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: '> [!NOTE]\n> from the agent' });

        const res = await appended;
        expect(res.status).toBe(200);
        const expected = '## Notes\n\nfirst line (edited)\n\ntyped by me\n\n> [!NOTE]\n> from the agent';
        await vi.waitFor(() => expect(markdownOf(editor.fragment)).toBe(expected), { timeout: 10_000, interval: 20 });
        await vi.waitFor(async () => expect(await storedMarkdown(doc.id)).toBe(expected), { timeout: 10_000, interval: 50 });

        // More typing after the agent's edit, then Undo from Home: only the agent's block goes.
        editor.document.transact(() => {
            editor.fragment.insert(editor.fragment.length, docJsonToYElements({ type: 'doc', content: markdownToBlocks('after the agent') }));
        });
        await vi.waitFor(async () => expect(await storedMarkdown(doc.id)).toContain('after the agent'), { timeout: 10_000, interval: 50 });
        expect((await api(user).post(`/api/agent/edits/${res.body.data.editId}/undo`)).status).toBe(200);

        const afterUndo = '## Notes\n\nfirst line (edited)\n\ntyped by me\n\nafter the agent';
        await vi.waitFor(() => expect(markdownOf(editor.fragment)).toBe(afterUndo), { timeout: 10_000, interval: 20 });
        await vi.waitFor(async () => expect(await storedMarkdown(doc.id)).toBe(afterUndo), { timeout: 10_000, interval: 50 });
        // Reading through the agent API while the editor is open uses the live doc.
        expect((await agent.get(`/api/agent/docs/${doc.id}`)).body.data.markdown).toBe(afterUndo);
    });

    it('an agent canvas reaches an open editor (block and board), read_doc reads the live board, Undo takes both back', async () => {
        const user = await createTestUser();
        const doc = await docFromMarkdown(user.id, 'Live canvas', '## Notes\n\nfirst line');
        const editor = await connect(doc.id, user.id);
        const agent = await agentFor(user);
        const res = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: CANVAS_FENCE });
        expect(res.status).toBe(200);

        const canvasIdIn = (fragment: Y.XmlFragment) => {
            const element = fragment.toArray().find((el) => el instanceof Y.XmlElement && el.nodeName === 'canvas') as Y.XmlElement | undefined;
            return element?.getAttribute('canvasId') as string | undefined;
        };
        await vi.waitFor(() => expect(canvasIdIn(editor.fragment)).toBeDefined(), { timeout: 10_000, interval: 20 });
        const canvasId = canvasIdIn(editor.fragment)!;
        await vi.waitFor(() => expect(readBoard(editor.document, canvasId).nodes).toHaveLength(3), { timeout: 10_000, interval: 20 });

        // The person moves a box and adds one in the browser; read_doc (live) shows it (the text
        // form has no positions: the move shows in the board itself).
        editor.document.transact(() => {
            const nodes = editor.document.getMap<Record<string, unknown>>(`canvas:${canvasId}:nodes`);
            nodes.set('api', { ...nodes.get('api')!, x: 300, y: 300 });
            nodes.set('mine', { id: 'mine', shape: 'sticky', text: 'my note', x: 0, y: 400, w: 200, h: 140, color: 'yellow', z: 5 });
        });
        await vi.waitFor(
            async () => {
                const md = (await agent.get(`/api/agent/docs/${doc.id}`)).body.data.markdown as string;
                expect(md).toContain('\n  mine[my note]@{ shape: sticky }:::yellow\n');
                expect(md).toContain('\n  api[API gateway]\n');
            },
            { timeout: 10_000, interval: 50 }
        );
        expect(readBoard(editor.document, canvasId).nodes.find((n) => n.id === 'api')).toMatchObject({ x: 300, y: 300 });

        // Undo: the agent's block and the boxes it wrote go. What the person wrote since (the moved
        // box is a new record, and their note) stays in the maps, now shown by no block.
        expect((await api(user).post(`/api/agent/edits/${res.body.data.editId}/undo`)).status).toBe(200);
        await vi.waitFor(() => expect(canvasIdIn(editor.fragment)).toBeUndefined(), { timeout: 10_000, interval: 20 });
        await vi.waitFor(() => expect(readBoard(editor.document, canvasId).nodes.map((n) => n.id)).toEqual(['api', 'mine']), { timeout: 10_000, interval: 20 });
        expect((await agent.get(`/api/agent/docs/${doc.id}`)).body.data.markdown).toBe('## Notes\n\nfirst line');
    });

    it('replace-section while an editor types elsewhere in the doc: both survive', async () => {
        const user = await createTestUser();
        const doc = await docFromMarkdown(user.id, 'Live 2', '## A\n\nalpha\n\n## B\n\nbeta');
        const editor = await connect(doc.id, user.id);
        editor.document.transact(() => {
            const run = (editor.fragment.get(3) as Y.XmlElement).get(0) as Y.XmlText;
            run.insert(0, 'my ');
        });
        const res = await (await agentFor(user)).post(`/api/agent/docs/${doc.id}/replace-section`, { heading: 'A', markdown: 'rewritten alpha' });
        expect(res.status).toBe(200);
        const expected = '## A\n\nrewritten alpha\n\n## B\n\nmy beta';
        await vi.waitFor(() => expect(markdownOf(editor.fragment)).toBe(expected), { timeout: 10_000, interval: 20 });
        await vi.waitFor(async () => expect(await storedMarkdown(doc.id)).toBe(expected), { timeout: 10_000, interval: 50 });
    });
});
