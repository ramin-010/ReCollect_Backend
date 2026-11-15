// Writes a Revise import plan (./reviseImport.ts) into one Recollect account, in one transaction:
// subjects first, then notes and links with their revisions, tasks, quick notes. Every row made is
// remembered in ImportedRow, so the next run's plan leaves it out. Used by scripts/import-revise.ts.
import { prisma, type TxClient } from '../../db/prisma';
import { IMPORT_SOURCE, type ImportPlan } from './reviseImport';

export interface AppliedCounts {
    subjects: number;
    captures: number;
    revisions: number;
    todos: number;
    quickNotes: number;
}

export async function applyReviseImport(plan: ImportPlan, userId: string): Promise<AppliedCounts> {
    const counts: AppliedCounts = { subjects: 0, captures: 0, revisions: 0, todos: 0, quickNotes: 0 };
    const remember = (tx: TxClient, sourceTable: string, sourceId: string, targetTable: string, targetId: string) =>
        tx.importedRow.create({ data: { userId, source: IMPORT_SOURCE, sourceTable, sourceId, targetTable, targetId }, select: { id: true } });
    await prisma.$transaction(
        async (tx) => {
            const made = new Map<string, string>();
            for (const s of plan.subjectsToMake) {
                const row = await tx.subject.create({ data: { userId, ...s.data }, select: { id: true } });
                made.set(s.sourceId, row.id);
                await remember(tx, 'Subject', s.sourceId, 'Subject', row.id);
                counts.subjects += 1;
            }
            for (const c of plan.captures) {
                const subjectId = c.subject ? ('existing' in c.subject ? c.subject.existing : made.get(c.subject.make) ?? null) : null;
                const row = await tx.capture.create({ data: { userId, subjectId, cloudPublicId: null, ...c.data }, select: { id: true } });
                await remember(tx, 'Capture', c.sourceId, 'Capture', row.id);
                counts.captures += 1;
                for (const r of c.revisions) {
                    const rev = await tx.revision.create({ data: { userId, captureId: row.id, ...r.data }, select: { id: true } });
                    await remember(tx, 'Revision', r.sourceId, 'Revision', rev.id);
                    counts.revisions += 1;
                }
            }
            for (const t of plan.todos) {
                const row = await tx.todo.create({ data: { userId, ...t.data }, select: { id: true } });
                await remember(tx, 'Capture', t.sourceId, 'Todo', row.id);
                counts.todos += 1;
            }
            for (const n of plan.quickNotes) {
                const row = await tx.quickNote.create({ data: { userId, ...n.data }, select: { id: true } });
                await remember(tx, 'QuickNote', n.sourceId, 'QuickNote', row.id);
                counts.quickNotes += 1;
            }
        },
        { timeout: 300_000, maxWait: 10_000 }
    );
    return counts;
}
