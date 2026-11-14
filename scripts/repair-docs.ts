// One-off sweep: repair every stored doc the way the collaboration server repairs a doc it loads
// (src/services/docs/docRepair.ts: side-by-side columns flattened, stray list items re-wrapped),
// so docs nobody opens are clean too. Reports by default; pass --write to store the repairs.
//
//   npx ts-node --transpile-only scripts/repair-docs.ts [--write]
//
// Run it with the API server up to date (it repairs docs on load too); a doc open in an editor is
// repaired by the server, and this sweep's copy of it is equally repaired.
import * as Y from 'yjs';
import { prisma } from '../src/db/prisma';
import { docProblem, repairDoc } from '../src/services/docs/docRepair';
import { generatePreviewAndMetadata } from '../src/utils/previewUtils';

async function main(): Promise<void> {
    const write = process.argv.includes('--write');
    const docs = await prisma.doc.findMany({ where: { yjsState: { not: null } }, select: { id: true, title: true, yjsState: true } });
    let repaired = 0;
    for (const doc of docs) {
        const ydoc = new Y.Doc();
        try {
            Y.applyUpdate(ydoc, Buffer.from(doc.yjsState!, 'base64'));
        } catch (err) {
            console.warn(`unreadable state, skipped: ${doc.id} (${doc.title})`);
            ydoc.destroy();
            continue;
        }
        const repairs = repairDoc(ydoc);
        const problem = docProblem(ydoc);
        if (repairs > 0) {
            repaired += 1;
            console.log(`${write ? 'repaired' : 'would repair'}: ${doc.id} "${doc.title}" (${repairs} fix${repairs === 1 ? '' : 'es'})`);
            if (write) {
                const yjsState = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
                const { previewState } = generatePreviewAndMetadata(yjsState);
                await prisma.doc.update({ where: { id: doc.id }, data: { yjsState, previewState } });
            }
        }
        if (problem) console.warn(`still invalid after repair: ${doc.id} "${doc.title}": ${problem}`);
        ydoc.destroy();
    }
    console.log(`${docs.length} docs checked; ${repaired} ${write ? 'repaired' : 'need a repair (run with --write)'}`);
}

main()
    .catch((err) => {
        console.error('repair-docs failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
