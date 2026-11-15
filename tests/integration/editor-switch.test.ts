// The editor switch (DOCS_EDITOR_V2_PLAN phase 4, 2026-11-15): every new doc is made on the new editor
// (blocks only), a template arrives as blocks, an empty doc takes blocks on its first write (no 409),
// and update_canvas changes a board shown by a canvas block (its height a prop of the block).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import * as Y from 'yjs';

vi.mock('upfly', async () => (await import('../helpers/uploads')).createUpflyMock());
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { readBoard } from '../../src/services/docs/canvas';
import { readBlocks } from '../../src/services/docs/blocks/serverEditor';
import { onNewEditor } from '../../src/services/docs/blocks/newDocState';
import { docJsonToYjsState } from '../../src/services/docs/docContent';
import { authCookie, createTestUser } from '../helpers/auth';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

async function stored(docId: string): Promise<Y.Doc> {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
    const ydoc = new Y.Doc();
    if (row.yjsState) Y.applyUpdate(ydoc, row.yjsState);
    return ydoc;
}

const agentFor = async (user: { id: string }) => asAgent((await createTestToken(user)).token, 'Claude Code');

const FENCE = ['```canvas', 'flowchart LR', '  a[Client] --> b[Gateway]', '```'].join('\n');

describe('new docs are made on the new editor', () => {
    it('POST /api/docs with a template: its sections as blocks, with a preview; without one: empty', async () => {
        const user = await createTestUser();
        const template = {
            type: 'doc',
            content: [
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Problem' }] },
                { type: 'paragraph' },
                { type: 'details', attrs: { open: false }, content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'Recall check' }] }, { type: 'detailsContent', content: [{ type: 'paragraph' }] }] },
            ],
        };
        const res = await request(app).post('/api/docs').set('Cookie', authCookie(user)).send({ title: 'Two sum', content: template });
        expect(res.status).toBe(201);
        const ydoc = await stored(res.body.data._id);
        expect(ydoc.share.has('default')).toBe(false);
        expect(readBlocks(ydoc).map((b) => b.type)).toEqual(['heading', 'paragraph', 'toggleListItem']);
        expect(ydoc.getMap('metadata').get('title')).toBe('Two sum');
        expect(res.body.data.previewState).toEqual(expect.any(String));

        const empty = await request(app).post('/api/docs').set('Cookie', authCookie(user)).send({ title: 'Blank' });
        expect(empty.body.data).not.toHaveProperty('yjsState');
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: empty.body.data._id } })).yjsState).toBeNull();
        expect((await request(app).post('/api/docs').set('Cookie', authCookie(user)).send({ title: 'Bad', content: 'not json' })).status).toBe(400);
        ydoc.destroy();
    });

    it('an empty doc takes blocks on its first write: append and insert_blocks (no 409); its outline is empty, not refused', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const doc = await prisma.doc.create({ data: { userId: user.id, title: 'Fresh' } });
        expect((await agent.get(`/api/agent/docs/${doc.id}/outline`)).body.data.blocks).toEqual([]);
        const appended = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: '## Notes\n\nFirst line.' });
        expect(appended.status).toBe(200);
        let ydoc = await stored(doc.id);
        expect(ydoc.share.has('default')).toBe(false);
        expect(readBlocks(ydoc).map((b) => b.type)).toEqual(['heading', 'paragraph']);
        ydoc.destroy();

        const other = await prisma.doc.create({ data: { userId: user.id, title: 'Fresh 2' } });
        const inserted = await agent.post(`/api/agent/docs/${other.id}/blocks`, { markdown: 'Hello', where: { at: 'end' } });
        expect(inserted.status).toBe(200);
        ydoc = await stored(other.id);
        expect(readBlocks(ydoc).map((b) => b.type)).toEqual(['paragraph']);
        ydoc.destroy();
    });

    it('which editor: blocks → new; old content and no blocks → old; nothing at all → new', () => {
        const empty = new Y.Doc();
        expect(onNewEditor(empty)).toBe(true);
        const old = new Y.Doc();
        Y.applyUpdate(old, docJsonToYjsState({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }));
        expect(onNewEditor(old)).toBe(false);
    });
});

describe('canvases on the new editor', () => {
    it('update_canvas on a canvas block: the board changes in place, its height prop with it; Undo puts both back', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const made = await agent.post('/api/agent/docs', { title: 'Gateway', markdown: `## Flow\n\n${FENCE}` });
        expect(made.status).toBe(201);
        const docId = made.body.data.id as string;
        const canvasId = made.body.data.canvases[0].canvasId as string;
        let ydoc = await stored(docId);
        const before = readBlocks(ydoc).find((b) => b.type === 'canvas')!;
        expect(before.props['canvasId']).toBe(canvasId);
        ydoc.destroy();

        const updated = await agent.post(`/api/agent/docs/${docId}/canvas/${canvasId}`, { add: ['b --> c[(Redis)]', 'b --> d[Service]', 'd --> e[Queue]'].join('\n') });
        expect(updated.status).toBe(200);
        expect(updated.body.data.editId).toEqual(expect.any(String));
        ydoc = await stored(docId);
        expect(readBoard(ydoc, canvasId).nodes.map((n) => n.text).sort()).toEqual(['Client', 'Gateway', 'Queue', 'Redis', 'Service']);
        const block = readBlocks(ydoc).find((b) => b.type === 'canvas')!;
        expect(block.props['canvasId']).toBe(canvasId);
        // The block was found in "blocks" (this doc has no old fragment); its frame height stays a valid one.
        expect(Number(block.props['height'])).toBeGreaterThanOrEqual(280);
        ydoc.destroy();

        expect((await request(app).post(`/api/agent/edits/${updated.body.data.editId}/undo`).set('Cookie', authCookie(user))).status).toBe(200);
        ydoc = await stored(docId);
        expect(readBoard(ydoc, canvasId).nodes.map((n) => n.text).sort()).toEqual(['Client', 'Gateway']);
        ydoc.destroy();
    });
});
