// After the switch: every stored doc reads as blocks on the server (BlockNote's schema), prints back to
// Markdown and builds its public page state. Counts only, never a doc's text (docs hold private notes).
// Read only. Exit code 1 when a doc fails (phase 5's T26: "every doc reads").
//
// The database is DATABASE_URL as this process was started with it, never backend/.env (review A7;
// scripts/lib/target.ts); the dev database only with --allow-dev:
//   the server:  DOTENV_CONFIG_PATH=<the API's env file> node -r dotenv/config dist-scripts/scripts/check-blocks.js
//   the PC:      DATABASE_URL=<target> node dist-scripts/scripts/check-blocks.js   (or npx ts-node --transpile-only scripts/check-blocks.ts)
import { describeTarget, resolveTarget } from './lib/target'; // first: it reads DATABASE_URL before any app module can load a .env file
import * as Y from 'yjs';

async function main(): Promise<void> {
    const target = resolveTarget({ purpose: 'maintenance', allowDev: process.argv.includes('--allow-dev') });
    console.log(`[check-blocks] ${describeTarget(target)} (read only)`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prisma } = require('../src/db/prisma') as typeof import('../src/db/prisma');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readBlocks, hasBlocks } = require('../src/services/docs/blocks/serverEditor') as typeof import('../src/services/docs/blocks/serverEditor');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { onNewEditor } = require('../src/services/docs/blocks/newDocState') as typeof import('../src/services/docs/blocks/newDocState');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { printBlocks } = require('../src/services/docs/blocks/markdown') as typeof import('../src/services/docs/blocks/markdown');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { publicDocState } = require('../src/services/docs/blocks/publicState') as typeof import('../src/services/docs/blocks/publicState');

    const docs = await prisma.doc.findMany({ select: { id: true, yjsState: true } });
    const count = { docs: docs.length, empty: 0, onBlocks: 0, oldOnly: 0, read: 0, printed: 0, publicState: 0 };
    const failures: string[] = [];
    for (const doc of docs) {
        if (!doc.yjsState) {
            count.empty += 1;
            continue;
        }
        const ydoc = new Y.Doc();
        try {
            Y.applyUpdate(ydoc, doc.yjsState);
            if (hasBlocks(ydoc)) count.onBlocks += 1;
            if (!onNewEditor(ydoc)) count.oldOnly += 1;
            const blocks = readBlocks(ydoc);
            count.read += 1;
            printBlocks(blocks, { ydoc });
            count.printed += 1;
            publicDocState(ydoc);
            count.publicState += 1;
        } catch (err) {
            failures.push(`${doc.id}: ${err instanceof Error ? err.name : 'error'}`);
        } finally {
            ydoc.destroy();
        }
    }
    console.log('[check-blocks]', JSON.stringify(count));
    if (failures.length) console.log('[check-blocks] failures (ids and error kinds only):', failures.join(', '));
    await prisma.$disconnect();
    if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
    console.error('[check-blocks] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
