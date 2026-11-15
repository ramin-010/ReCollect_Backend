// The Revise import's write path (src/services/import/applyReviseImport.ts): a plan made from Revise
// rows lands in one account (subjects, notes and links with revisions, tasks, quick notes), files
// without their Cloudinary ids; a second plan over the same rows brings nothing.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { applyReviseImport } from '../../src/services/import/applyReviseImport';
import { IMPORT_SOURCE, planReviseImport, type ReviseData } from '../../src/services/import/reviseImport';
import { createTestUser } from '../helpers/auth';
import { createSubjectRow } from '../helpers/learning';

const at = (iso: string) => new Date(iso);
const base = { goalType: 'NONE' as const, title: null, isPinned: false, subjectId: null, topicId: null, categoryId: null, content: null, url: null, cloudPublicId: null, fileType: null, isDone: false, completedAt: null, dueDate: null, time: null, createdAt: at('2026-09-01T10:00:00Z'), updatedAt: at('2026-09-03T10:00:00Z') };

const data: ReviseData = {
    subjects: [
        { id: 'rs-dsa', name: 'dsa', description: null, icon: null, color: null, createdAt: at('2026-08-01T00:00:00Z') },
        { id: 'rs-net', name: 'Networking', description: null, icon: null, color: '#10b981', createdAt: at('2026-08-01T00:00:00Z') },
    ],
    categories: new Map([['c1', 'Idea']]),
    captures: [
        { ...base, id: 'n1', type: 'NOTE', title: 'Heap tricks', content: 'k smallest: a max-heap of size k', subjectId: 'rs-dsa', categoryId: 'c1', isPinned: true },
        { ...base, id: 'l1', type: 'LINK', title: 'TCP handshake', url: 'https://res.cloudinary.com/x/raw/upload/tcp.pdf', cloudPublicId: 'revise/tcp', subjectId: 'rs-net' },
        { ...base, id: 't1', type: 'TASK', title: 'Book mock interview', dueDate: at('2026-11-20T00:00:00Z'), time: '09:00', goalType: 'WEEKLY' },
    ],
    attachments: [{ captureId: 'n1', url: 'https://res.cloudinary.com/x/image/upload/h.png', fileType: 'image/png', fileName: 'h.png' }],
    revisions: [
        { id: 'r1', captureId: 'n1', cycleNumber: 1, intervalDays: 1, scheduledFor: at('2026-09-02T00:00:00Z'), completedAt: at('2026-09-02T06:00:00Z'), status: 'done', createdAt: at('2026-09-01T10:00:00Z') },
        { id: 'r2', captureId: 'n1', cycleNumber: 2, intervalDays: 3, scheduledFor: at('2026-09-04T18:30:00Z'), completedAt: null, status: 'pending', createdAt: at('2026-09-01T10:00:00Z') },
    ],
    quickNotes: [{ id: 'q1', content: 'git rebase -i HEAD~3', isPinned: true, category: 'PRIMARY', attachments: [], createdAt: at('2026-09-01T00:00:00Z'), updatedAt: at('2026-09-01T00:00:00Z') }],
    reminders: { total: 0, ahead: 0 },
    left: { topics: 3 },
};

describe('applyReviseImport', () => {
    it('writes the plan into one account and remembers every row; a second run brings nothing', async () => {
        const [user, other] = await Promise.all([createTestUser(), createTestUser()]);
        const dsa = await createSubjectRow(user.id, 'DSA');
        const targetOf = async () => ({
            timezone: 'Asia/Kolkata',
            subjectsByName: new Map((await prisma.subject.findMany({ where: { userId: user.id } })).map((s) => [s.name.toLowerCase(), s.id])),
            imported: new Set((await prisma.importedRow.findMany({ where: { userId: user.id, source: IMPORT_SOURCE } })).map((r) => `${r.sourceTable}:${r.sourceId}`)),
        });

        const counts = await applyReviseImport(planReviseImport(data, await targetOf()), user.id);
        expect(counts).toEqual({ subjects: 1, captures: 2, revisions: 2, todos: 1, quickNotes: 1 });

        const subjects = await prisma.subject.findMany({ where: { userId: user.id }, orderBy: { name: 'asc' } });
        expect(subjects.map((s) => s.name)).toEqual(['DSA', 'Networking']);
        const captures = await prisma.capture.findMany({ where: { userId: user.id }, orderBy: { type: 'asc' } });
        expect(captures.map((c) => [c.type, c.title, c.subjectId, c.cloudPublicId, c.category, c.isPinned])).toEqual([
            ['NOTE', 'Heap tricks', dsa.id, null, 'Idea', true],
            ['LINK', 'TCP handshake', subjects[1]!.id, null, null, false],
        ]);
        expect(captures[0]!.attachments).toEqual([{ url: 'https://res.cloudinary.com/x/image/upload/h.png', publicId: '', fileName: 'h.png', fileType: 'image/png' }]);
        expect(captures[0]!.updatedAt.toISOString()).toBe('2026-09-03T10:00:00.000Z');
        const revisions = await prisma.revision.findMany({ where: { captureId: captures[0]!.id }, orderBy: { cycleNumber: 'asc' } });
        expect(revisions.map((r) => [r.cycleNumber, r.status, r.scheduledFor.toISOString().slice(0, 10), r.userId])).toEqual([
            [1, 'done', '2026-09-02', user.id],
            [2, 'pending', '2026-09-05', user.id],
        ]);
        const [task] = await prisma.todo.findMany({ where: { userId: user.id } });
        expect(task).toMatchObject({ title: 'Book mock interview', status: 'pending', goalType: 'WEEKLY', workspaceId: null, dueDate: at('2026-11-20T03:30:00Z') });
        expect(await prisma.quickNote.count({ where: { userId: user.id, content: 'git rebase -i HEAD~3', isPinned: true } })).toBe(1);
        expect(await prisma.importedRow.count({ where: { userId: user.id } })).toBe(7);

        // The same Revise rows again: nothing new, nothing doubled.
        const again = planReviseImport(data, await targetOf());
        expect(again.captures.length + again.todos.length + again.quickNotes.length + again.subjectsToMake.length).toBe(0);
        expect(again.already).toEqual({ captures: 2, todos: 1, quickNotes: 1 });
        expect(await applyReviseImport(again, user.id)).toEqual({ subjects: 0, captures: 0, revisions: 0, todos: 0, quickNotes: 0 });
        expect(await prisma.capture.count({ where: { userId: user.id } })).toBe(2);
        // Nobody else got anything.
        expect(await prisma.capture.count({ where: { userId: other.id } })).toBe(0);
    });
});
