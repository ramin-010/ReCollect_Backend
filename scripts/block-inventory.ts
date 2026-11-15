// Read-only: which kinds of nodes the stored docs use (DOCS_EDITOR_V2_PLAN §11 block audit, and the
// phase 4 migration's checklist). Prints counts only, never text: docs hold private notes.
//
//   npx ts-node --transpile-only scripts/block-inventory.ts
//
// Per node type: how many nodes, in how many docs; plus the attribute names seen on each type and,
// for code blocks, the languages; and how many docs already have the new editor's "blocks" fragment.
import * as Y from 'yjs';
import { prisma } from '../src/db/prisma';

type Tally = { nodes: number; docs: Set<string>; attrs: Set<string> };

async function main(): Promise<void> {
    const docs = await prisma.doc.findMany({ where: { yjsState: { not: null } }, select: { id: true, yjsState: true, trashedAt: true } });
    const byType = new Map<string, Tally>();
    const languages = new Map<string, number>();
    let unreadable = 0;
    let withBlocks = 0;
    let marks = new Map<string, number>();
    for (const doc of docs) {
        const ydoc = new Y.Doc();
        try {
            Y.applyUpdate(ydoc, doc.yjsState!);
        } catch {
            unreadable += 1;
            ydoc.destroy();
            continue;
        }
        if (ydoc.share.has('blocks') && ydoc.getXmlFragment('blocks').length > 0) withBlocks += 1;
        const stack: unknown[] = ydoc.getXmlFragment('default').toArray();
        while (stack.length) {
            const el = stack.pop();
            if (el instanceof Y.XmlElement) {
                const t = byType.get(el.nodeName) ?? { nodes: 0, docs: new Set<string>(), attrs: new Set<string>() };
                t.nodes += 1;
                t.docs.add(doc.id);
                for (const [k, v] of Object.entries(el.getAttributes())) if (v !== null && v !== undefined && v !== '') t.attrs.add(k);
                if (el.nodeName === 'codeBlock') {
                    const lang = String(el.getAttribute('language') ?? 'plain');
                    languages.set(lang, (languages.get(lang) ?? 0) + 1);
                }
                byType.set(el.nodeName, t);
                stack.push(...el.toArray());
            } else if (el instanceof Y.XmlText) {
                for (const d of el.toDelta() as { attributes?: Record<string, unknown> }[]) {
                    for (const m of Object.keys(d.attributes ?? {})) marks.set(m, (marks.get(m) ?? 0) + 1);
                }
            }
        }
        ydoc.destroy();
    }
    console.log(`docs with a stored state: ${docs.length} (${docs.filter((d) => d.trashedAt).length} in the trash), unreadable: ${unreadable}, already with a "blocks" fragment: ${withBlocks}`);
    console.log('node type | nodes | docs | attributes seen');
    for (const [type, t] of [...byType.entries()].sort((a, b) => b[1].nodes - a[1].nodes)) {
        console.log(`${type} | ${t.nodes} | ${t.docs.size} | ${[...t.attrs].sort().join(', ')}`);
    }
    console.log('code block languages:', JSON.stringify(Object.fromEntries(languages)));
    console.log('marks (text runs):', JSON.stringify(Object.fromEntries(marks)));
    marks = new Map();
}

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
