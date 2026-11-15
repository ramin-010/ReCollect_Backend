// Night-job pruning (MANAGER_AND_DOCS_PLAN D5, ALWAYS_ON_SPEC 6.4): agent edit logs and the doc
// snapshots their Undo uses would otherwise grow forever. Run hourly beside the trash purge.
// - AgentEdit rows older than EDIT_DAYS go (an Undo that old is not offered anyway).
// - DocSnapshot rows older than SNAPSHOT_DAYS go, except each doc's newest KEEP_PER_DOC, and
//   except any still referenced by a kept edit (its Undo needs it).
import { prisma } from '../../db/prisma';

export const EDIT_DAYS = 90;
export const SNAPSHOT_DAYS = 30;
export const KEEP_PER_DOC = 5;

const DAY = 86_400_000;

export interface PruneResult {
    edits: number;
    snapshots: number;
}

export async function pruneAgentHistory(now: Date = new Date()): Promise<PruneResult> {
    const edits = await prisma.agentEdit.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - EDIT_DAYS * DAY) } } });

    const cutoff = new Date(now.getTime() - SNAPSHOT_DAYS * DAY);
    // Old snapshots that no kept edit points at, ranked newest first within their doc.
    const old = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT s."id" FROM (
            SELECT "id", "createdAt", ROW_NUMBER() OVER (PARTITION BY "docId" ORDER BY "createdAt" DESC) AS rank
            FROM "DocSnapshot"
        ) s
        WHERE s.rank > ${KEEP_PER_DOC}
          AND s."createdAt" < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM "AgentEdit" e WHERE e."snapshotId" = s."id")
    `;
    let snapshots = 0;
    for (let i = 0; i < old.length; i += 500) {
        const r = await prisma.docSnapshot.deleteMany({ where: { id: { in: old.slice(i, i + 500).map((o) => o.id) } } });
        snapshots += r.count;
    }
    return { edits: edits.count, snapshots };
}
