// One-time tidy (SYNC_SPINE_SPEC 1.1): course numbers typed into titles ("01 · How the web works")
// become the subject's path order, and the topics lose the number (the path numbers them now).
//
//   npx ts-node --transpile-only scripts/order-numbered-topics.ts                     dry run: prints the changes
//   npx ts-node --transpile-only scripts/order-numbered-topics.ts --apply             writes the order and the topic titles
//   npx ts-node --transpile-only scripts/order-numbered-topics.ts --apply --rename    also takes the number off the docs' titles
//   --subject "System Design"   only that subject      --email you@example.com   only that user
//
// A dry run is the default (--dry says so explicitly). Doc titles change only with --rename: run it
// while those docs are not open in a browser tab (an open editor would store its old title again).
// Subjects with fewer than 2 numbered topics are left alone. Unnumbered topics follow the numbered
// ones in their current order.
import * as Y from 'yjs';
import { stateBytes } from '../src/services/docs/docState';
import { prisma } from '../src/db/prisma';
import { pathOrder } from '../src/services/learningDb/path.service';
import { numberedPathOrder } from '../src/services/learningDb/numberedTopics';
import { generatePreviewAndMetadata } from '../src/utils/previewUtils';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const apply = process.argv.includes('--apply');
const rename = process.argv.includes('--rename');
const onlySubject = arg('--subject')?.trim().toLowerCase();
const onlyEmail = arg('--email')?.trim().toLowerCase();

/** The stored doc with this title in its metadata map (what an editor shows) and its row. */
async function renameDoc(docId: string, title: string): Promise<void> {
    const doc = await prisma.doc.findUnique({ where: { id: docId }, select: { yjsState: true } });
    if (!doc) return;
    let yjsState = doc.yjsState;
    if (yjsState) {
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, yjsState);
        ydoc.getMap('metadata').set('title', title);
        yjsState = stateBytes(Y.encodeStateAsUpdate(ydoc));
        ydoc.destroy();
    }
    await prisma.doc.update({
        where: { id: docId },
        data: { title, ...(yjsState ? { yjsState, previewState: generatePreviewAndMetadata(yjsState).previewState } : {}) },
        select: { id: true },
    });
}

async function main(): Promise<void> {
    if (rename && !apply) console.log('--rename does nothing without --apply.\n');
    const users = await prisma.user.findMany({ where: onlyEmail ? { email: onlyEmail } : {}, select: { id: true, email: true } });
    let changedSubjects = 0;
    for (const user of users) {
        const subjects = await prisma.subject.findMany({ where: { userId: user.id }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
        for (const subject of subjects) {
            if (onlySubject && subject.name.trim().toLowerCase() !== onlySubject) continue;
            const rows = await prisma.topic.findMany({
                where: { userId: user.id, subjectId: subject.id, isArchived: false },
                select: { id: true, title: true, status: true, sortOrder: true, createdAt: true, docId: true, nextStep: true, startedAt: true, doneAt: true, doc: { select: { title: true } } },
            });
            const current = pathOrder(rows).map((r) => ({ ...r, shown: r.doc?.title || r.title }));
            const ordered = numberedPathOrder(current.map((r) => ({ ...r, title: r.shown })));
            const numbered = ordered.filter((x) => x.parsed).length;
            if (numbered < 2) continue;
            changedSubjects += 1;

            console.log(`${user.email} · ${subject.name}: ${numbered} numbered of ${current.length} topics`);
            ordered.forEach(({ topic, parsed }, i) => {
                const was = current.findIndex((r) => r.id === topic.id) + 1;
                const place = was === i + 1 ? `place ${i + 1}` : `place ${was} → ${i + 1}`;
                const title = parsed ? `${parsed.rest}  (was "${topic.title}")` : `${topic.title}  (unnumbered)`;
                const doc = parsed && topic.docId ? (rename ? ', doc renamed' : ', doc keeps its title') : '';
                console.log(`  ${String(i + 1).padStart(2)}. ${title} · ${place}${doc}`);
            });

            if (!apply) continue;
            await prisma.$transaction(async (tx) => {
                for (const [i, { topic, parsed }] of ordered.entries()) {
                    await tx.topic.update({ where: { id: topic.id }, data: { sortOrder: i + 1, ...(parsed ? { title: parsed.rest } : {}) }, select: { id: true } });
                }
            });
            if (rename) {
                for (const { topic, parsed } of ordered) {
                    if (parsed && topic.docId) await renameDoc(topic.docId, parsed.rest);
                }
            }
            console.log(`  written${rename ? ' (doc titles too)' : ''}.`);
        }
    }
    if (changedSubjects === 0) console.log('No subject has 2 or more numbered topics: nothing to do.');
    else if (!apply) console.log('\nDry run: nothing written. --apply writes the order and the topic titles; --apply --rename also renames the docs.');
    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
});
