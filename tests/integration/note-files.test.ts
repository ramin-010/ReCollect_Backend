// TOOL_ACCESS_PLAN §11 (11-27): files on a note. Any file but a video, at most 10 MB, 20 a note; agents attach a file
// from disk (multipart), its text, or its bytes as base64; take one off; read a text file's text or another's link.
// Each agent write has an Undo. The app's PATCH of a note takes the whole new list, and a file dropped from it leaves
// storage. Cloudinary is faked (the upload, and the deletes by type).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));
vi.mock('../../src/services/learningDb/uploads.service', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../src/services/learningDb/uploads.service')>();
    return {
        ...real,
        uploadToCloud: vi.fn(async (file: { buffer: Buffer; originalname: string; mimetype: string }) => {
            const image = /^image\//.test(file.mimetype);
            return { url: `https://cdn.test/${file.originalname}`, publicId: `recollect-learning/${image ? file.originalname.replace(/\.\w+$/, '') : file.originalname}`, fileName: file.originalname, fileType: file.mimetype, size: file.buffer.length, resourceType: image ? 'image' : 'raw' };
        }),
        deleteStoredFiles: vi.fn(),
    };
});

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { deleteStoredFiles, uploadToCloud } from '../../src/services/learningDb/uploads.service';
import { authCookie } from '../helpers/auth';
import { api, createLearner, createSubjectRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
beforeEach(() => {
    vi.mocked(deleteStoredFiles).mockClear();
    vi.mocked(uploadToCloud).mockClear();
});

async function noteOnSubject() {
    const user = await createLearner();
    const subject = await createSubjectRow(user.id, 'System Design');
    const note = await prisma.capture.create({ data: { userId: user.id, subjectId: subject.id, title: 'Cheat sheet', content: 'notes' } });
    const agent = asAgent((await createTestToken(user)).token, 'Claude Code');
    return { user, note, agent };
}

describe('files on a note, for agents (TOOL_ACCESS_PLAN §11)', () => {
    it('a png and an xlsx from disk, an md as text, a zip as base64; the note lists them with their numbers', async () => {
        const { note, agent } = await noteOnSubject();
        const token = (await createTestToken({ id: note.userId })).token;
        const png = await request(app).post(`/api/agent/notes/${note.id}/files`).set('Authorization', `Bearer ${token}`).attach('file', Buffer.from('png-bytes'), { filename: 'diagram.png', contentType: 'image/png' });
        expect(png.status).toBe(201);
        expect(png.body.data.file).toEqual({ n: 1, name: 'diagram.png', type: 'image/png', size: 9 });
        const xlsx = await request(app).post(`/api/agent/notes/${note.id}/files`).set('Authorization', `Bearer ${token}`).attach('file', Buffer.from('PK-sheet'), { filename: 'budget.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        expect(xlsx.status).toBe(201);
        const md = await agent.post(`/api/agent/notes/${note.id}/files`, { name: 'plan.md', text: '# Plan\n\n- one' });
        expect(md.status).toBe(201);
        expect(md.body.data.file).toMatchObject({ n: 3, name: 'plan.md', type: 'text/markdown' });
        const zip = await agent.post(`/api/agent/notes/${note.id}/files`, { name: 'code.zip', base64: Buffer.from('PK-zip').toString('base64') });
        expect(zip.status).toBe(201);
        expect(zip.body.data.files.map((f: { name: string }) => f.name)).toEqual(['diagram.png', 'budget.xlsx', 'plan.md', 'code.zip']);
        const listed = await agent.get(`/api/agent/notes?ids=${note.id}`);
        expect(listed.body.data.notes[0].files).toEqual([
            { n: 1, name: 'diagram.png', type: 'image/png', size: 9 },
            { n: 2, name: 'budget.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 8 },
            { n: 3, name: 'plan.md', type: 'text/markdown', size: 13 },
            { n: 4, name: 'code.zip', type: 'application/zip', size: 6 },
        ]);
    });

    it('refuses a video (by type, or by its name whatever type it claims), over 10 MB, and the 21st file', async () => {
        const { note, agent } = await noteOnSubject();
        const token = (await createTestToken({ id: note.userId })).token;
        const mp4 = await request(app).post(`/api/agent/notes/${note.id}/files`).set('Authorization', `Bearer ${token}`).attach('file', Buffer.from('v'), { filename: 'talk.mp4', contentType: 'video/mp4' });
        expect([mp4.status, mp4.body.message]).toEqual([400, "Videos can't be attached. Save the link instead."]);
        const mov = await agent.post(`/api/agent/notes/${note.id}/files`, { name: 'clip.mov', text: 'not really text' });
        expect([mov.status, mov.body.code]).toEqual([400, 'VIDEO_NOT_ALLOWED']);
        const big = await request(app).post(`/api/agent/notes/${note.id}/files`).set('Authorization', `Bearer ${token}`).attach('file', Buffer.alloc(11 * 1024 * 1024), { filename: 'big.bin', contentType: 'application/octet-stream' });
        expect([big.status, big.body.message]).toEqual([413, 'Files can be at most 10 MB']);
        const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://cdn.test/f${i}.txt`, publicId: `recollect-learning/f${i}.txt`, fileName: `f${i}.txt`, fileType: 'text/plain' }));
        await prisma.capture.update({ where: { id: note.id }, data: { attachments: many } });
        const twentyFirst = await agent.post(`/api/agent/notes/${note.id}/files`, { name: 'one-more.md', text: 'x' });
        expect([twentyFirst.status, twentyFirst.body.code]).toEqual([409, 'FILE_LIMIT']);
        expect(vi.mocked(uploadToCloud)).not.toHaveBeenCalled();
    });

    it('reads a text file’s text and another file’s link; removes one (kept in storage while Undo can bring it back)', async () => {
        const { user, note, agent } = await noteOnSubject();
        await agent.post(`/api/agent/notes/${note.id}/files`, { name: 'plan.md', text: '# Plan' });
        await agent.post(`/api/agent/notes/${note.id}/files`, { name: 'budget.xlsx', base64: Buffer.from('PK').toString('base64') });
        const realFetch = globalThis.fetch;
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => (String(url) === 'https://cdn.test/plan.md' ? new Response('# Plan\n\nStep one.') : realFetch(url, init))));
        try {
            const text = await agent.get(`/api/agent/notes/${note.id}/files/1`);
            expect(text.body.data).toMatchObject({ n: 1, name: 'plan.md', text: '# Plan\n\nStep one.', cut: false });
            const byName = await agent.get(`/api/agent/notes/${note.id}/files/budget.xlsx`);
            expect(byName.body.data).toMatchObject({ n: 2, name: 'budget.xlsx', text: null, url: 'https://cdn.test/budget.xlsx' });
        } finally {
            vi.unstubAllGlobals();
        }
        const removed = await agent.post(`/api/agent/notes/${note.id}/files/remove`, { name: 'PLAN.md' });
        expect(removed.body.data).toMatchObject({ removed: 'plan.md', files: [{ n: 1, name: 'budget.xlsx' }] });
        expect(vi.mocked(deleteStoredFiles)).not.toHaveBeenCalled();
        expect((await api(user).post(`/api/agent/edits/${removed.body.data.editId}/undo`, {})).status).toBe(200);
        const back = await prisma.capture.findUniqueOrThrow({ where: { id: note.id } });
        expect((back.attachments as Array<{ fileName: string }>).map((f) => f.fileName)).toEqual(['plan.md', 'budget.xlsx']);
    });

    it("Undo of an agent's attach takes the file off the note and out of storage; a read-only token can't attach", async () => {
        const { user, note, agent } = await noteOnSubject();
        const added = await agent.post(`/api/agent/notes/${note.id}/files`, { name: 'plan.md', text: '# Plan' });
        expect((await api(user).post(`/api/agent/edits/${added.body.data.editId}/undo`, {})).status).toBe(200);
        expect((await prisma.capture.findUniqueOrThrow({ where: { id: note.id } })).attachments).toEqual([]);
        expect(vi.mocked(deleteStoredFiles)).toHaveBeenCalledWith([expect.objectContaining({ publicId: 'recollect-learning/plan.md', resourceType: 'raw' })]);
        const reader = asAgent((await createTestToken(user, ['read'])).token);
        expect((await reader.post(`/api/agent/notes/${note.id}/files`, { name: 'x.md', text: 'x' })).status).toBe(403);
    });
});

describe("the app's own note edit (TOOL_ACCESS_PLAN §11.3)", () => {
    it('PATCH takes the whole new list of files; a file dropped from it leaves storage after the save', async () => {
        const user = await createLearner();
        const files = [
            { url: 'https://cdn.test/a.png', publicId: 'recollect-learning/a', fileName: 'a.png', fileType: 'image/png', size: 10, resourceType: 'image' },
            { url: 'https://cdn.test/b.pdf', publicId: 'recollect-learning/b.pdf', fileName: 'b.pdf', fileType: 'application/pdf', size: 20, resourceType: 'raw' },
        ];
        const note = await prisma.capture.create({ data: { userId: user.id, title: 'With files', content: 'x', attachments: files } });
        const res = await request(app).patch(`/api/captures/${note.id}`).set('Cookie', authCookie(user)).send({ attachments: [files[0]] });
        expect(res.status).toBe(200);
        expect((await prisma.capture.findUniqueOrThrow({ where: { id: note.id } })).attachments).toEqual([files[0]]);
        expect(vi.mocked(deleteStoredFiles)).toHaveBeenCalledWith([files[1]]);
    });
});
