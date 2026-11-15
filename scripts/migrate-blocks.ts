// Phase 4 of DOCS_EDITOR_V2_PLAN: every doc's content written for the new editor (its "blocks"
// fragment), from the old editor's content in the same Y.Doc (which stays as it was, for going back).
// A dry run by default: nothing is stored. Prints counts only, never a doc's text (docs hold private
// notes and keys): per doc its id, what happens, blocks by type, what was dropped or merged, and the
// word check (every word of the old doc must be in the new blocks).
//
//   npx ts-node --transpile-only scripts/migrate-blocks.ts [--database <postgres url>] [--write] [--doc <id>]
//
// Run --write only on a copy first (restore a dump into another database and pass --database), and on
// the real database only with Ramin's sign-off (the switch).
import * as Y from 'yjs';
import { stateBytes } from '../src/services/docs/docState';
import type { DocMigration } from '../src/services/docs/blocks/migrate';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<void> {
    const database = value('--database');
    if (database) process.env.DATABASE_URL = database;
    const write = flag('--write');
    const only = value('--doc');
    // Loaded after DATABASE_URL is set (the client reads it once).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prisma } = require('../src/db/prisma') as typeof import('../src/db/prisma');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { migrateYDoc, planMigration } = require('../src/services/docs/blocks/migrate') as typeof import('../src/services/docs/blocks/migrate');
    const target = new URL(process.env.DATABASE_URL ?? 'postgres://unknown/unknown').pathname.slice(1);
    console.log(`[migrate-blocks] database ${target} · ${write ? 'WRITING' : 'dry run (nothing stored)'}${only ? ` · doc ${only}` : ''}`);

    const docs = await prisma.doc.findMany({ where: { yjsState: { not: null }, ...(only ? { id: only } : {}) }, select: { id: true, yjsState: true, updatedAt: true }, orderBy: { createdAt: 'asc' } });
    const totals: Record<string, number> = {};
    const dropped: Record<string, number> = {};
    const merged: Record<string, number> = {};
    const count = { converted: 0, already: 0, empty: 0, unreadable: 0, missingWords: 0 };
    for (const doc of docs) {
        const ydoc = new Y.Doc();
        try {
            Y.applyUpdate(ydoc, doc.yjsState!);
        } catch {
            count.unreadable += 1;
            console.log(`${doc.id} unreadable state: skipped`);
            ydoc.destroy();
            continue;
        }
        let result: DocMigration;
        if (write) {
            result = migrateYDoc(ydoc);
            if (result.status === 'converted') {
                const yjsState = stateBytes(Y.encodeStateAsUpdate(ydoc));
                // The stored state only; updatedAt is written back as it was (the doc's text didn't change).
                await prisma.doc.update({ where: { id: doc.id }, data: { yjsState, updatedAt: doc.updatedAt } });
            }
        } else {
            result = migrateYDocDry(ydoc, planMigration);
        }
        ydoc.destroy();
        count[result.status] += 1;
        if (result.missing.length) count.missingWords += 1;
        for (const [t, n] of Object.entries(result.types)) totals[t] = (totals[t] ?? 0) + n;
        for (const [t, n] of Object.entries(result.report.dropped)) dropped[t] = (dropped[t] ?? 0) + n;
        for (const [t, n] of Object.entries(result.report.merged)) merged[t] = (merged[t] ?? 0) + n;
        const notes = [
            Object.keys(result.report.dropped).length ? `dropped ${JSON.stringify(result.report.dropped)}` : '',
            Object.keys(result.report.merged).length ? `merged ${JSON.stringify(result.report.merged)}` : '',
            result.missing.length ? `MISSING ${result.missing.length} word(s)` : '',
        ].filter(Boolean);
        console.log(`${doc.id} ${result.status} blocks=${result.blocks} words=${result.wordsBefore}→${result.wordsAfter}${notes.length ? ` ${notes.join(' ')}` : ''}`);
    }
    console.log(`\n[migrate-blocks] ${docs.length} docs: ${count.converted} converted, ${count.already} already on blocks, ${count.empty} empty, ${count.unreadable} unreadable, ${count.missingWords} with missing words`);
    console.log(`blocks by type: ${JSON.stringify(totals)}`);
    console.log(`dropped: ${JSON.stringify(dropped)} · merged: ${JSON.stringify(merged)}`);
    await prisma.$disconnect();
}

/** The dry run: the plan's numbers, and the write tried on a copy of the Y.Doc (proves it encodes). */
function migrateYDocDry(ydoc: Y.Doc, plan: (d: Y.Doc) => { result: DocMigration }): DocMigration {
    const copy = new Y.Doc();
    try {
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { migrateYDoc } = require('../src/services/docs/blocks/migrate') as typeof import('../src/services/docs/blocks/migrate');
        void plan;
        return migrateYDoc(copy);
    } finally {
        copy.destroy();
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
