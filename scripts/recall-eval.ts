// The Recall test set (LOOP_COMPLETE_SPEC 1.7): a fixed list of about 20 real notes, questions written
// by the current prompt, mechanical checks, and a sheet the owner can read. No prompt tuning before this
// exists; run it after every prompt change. **Spends real AI money (about $1 a run): ask the owner first.**
//
//   npx ts-node --transpile-only scripts/recall-eval.ts --pick 20 [--email dev@recollect.local]
//        choose the notes once (topics with a note of enough text, spread over subjects) and write
//        backend/evals/recall-notes.json: the fixed list
//   npx ts-node --transpile-only scripts/recall-eval.ts            a dry run: what would be asked, the cost estimate
//   npx ts-node --transpile-only scripts/recall-eval.ts --run      the real run: writes backend/evals/recall-<date>.md
//
// Checks per note: 3 to 5 questions, every field filled and within its limits, a weakSpotId that is
// empty or one of the listed open weak spots, no two questions the same, each source quote found in
// the note. Nothing is stored in the app and nothing is billed to the app's meter (it is a test).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { aiModel, callClaude, isAiConfigured } from '../src/services/claude/client';
import { costOfTokens } from '../src/services/claude/pricing';
import { materialOf, recallRevisionInclude, itemTitle, earlierQuestions } from '../src/services/recall/material';
import { questionsRequest, withRefusalFallbacks, hasEnoughContent, docBlock } from '../src/services/recall/prompts';
import { MAX_QUESTIONS, parseQuestionsOutput, responseText, type RecallQuestion } from '../src/services/recall/output';
import { openWeakSpotsOf } from '../src/services/learningDb/sessions.service';

const args = process.argv.slice(2);
const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const EMAIL = flag('--email') ?? 'dev@recollect.local';
const LIST = path.resolve(__dirname, '..', 'evals', 'recall-notes.json');
/** A run's rough cost per note, for the dry run (the real cost is read from each answer). */
const EST_USD_PER_NOTE = 0.05;

interface Picked {
    revisionId: string;
    title: string;
    subject: string;
}

function check(questions: RecallQuestion[], weakIds: Set<string>, noteText: string): string[] {
    const problems: string[] = [];
    if (questions.length < 3 || questions.length > MAX_QUESTIONS) problems.push(`${questions.length} questions (3 to ${MAX_QUESTIONS} expected)`);
    const seen = new Set<string>();
    for (const q of questions) {
        const key = q.prompt.toLowerCase().replace(/\W+/g, ' ').trim();
        if (seen.has(key)) problems.push(`a repeated question: "${q.prompt.slice(0, 60)}"`);
        seen.add(key);
        if (!q.prompt.trim() || !q.answerKey.trim()) problems.push(`question ${q.id}: an empty prompt or answer key`);
        if (q.weakSpotId && !weakIds.has(q.weakSpotId)) problems.push(`question ${q.id}: weakSpotId ${q.weakSpotId} is not an open weak spot`);
        const quote = q.sourceQuote.replace(/\s+/g, ' ').trim().slice(0, 60).toLowerCase();
        if (quote && !noteText.replace(/\s+/g, ' ').toLowerCase().includes(quote)) problems.push(`question ${q.id}: its source quote is not in the note`);
    }
    return problems;
}

async function pick(n: number): Promise<void> {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL }, select: { id: true } });
    // The first revision of each topic that has a note: enough text, spread over subjects.
    const revs = await prisma.revision.findMany({
        where: { userId: user.id, topicId: { not: null }, cycleNumber: 1, topic: { docId: { not: null }, isArchived: false } },
        include: { ...recallRevisionInclude, topic: { select: { ...recallRevisionInclude.topic.select, subject: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
    });
    const bySubject = new Map<string, Picked[]>();
    for (const rev of revs) {
        const material = await materialOf(user.id, rev);
        if (!hasEnoughContent(material)) continue;
        const subject = rev.topic?.subject?.name ?? 'Other';
        bySubject.set(subject, [...(bySubject.get(subject) ?? []), { revisionId: rev.id, title: itemTitle(rev), subject }]);
    }
    const out: Picked[] = [];
    while (out.length < n && [...bySubject.values()].some((l) => l.length)) for (const l of bySubject.values()) if (l.length && out.length < n) out.push(l.shift()!);
    fs.mkdirSync(path.dirname(LIST), { recursive: true });
    fs.writeFileSync(LIST, `${JSON.stringify({ email: EMAIL, picked: new Date().toISOString(), notes: out }, null, 2)}\n`);
    console.log(`Picked ${out.length} note(s) into ${LIST}: ${out.map((p) => p.title).join(' · ')}`);
}

async function run(real: boolean): Promise<void> {
    if (!fs.existsSync(LIST)) throw new Error(`No fixed list yet: run with --pick 20 first (${LIST}).`);
    const list = JSON.parse(fs.readFileSync(LIST, 'utf8')) as { email: string; notes: Picked[] };
    const user = await prisma.user.findUniqueOrThrow({ where: { email: list.email }, select: { id: true } });
    if (!real) {
        console.log(`Dry run: ${list.notes.length} note(s) would each get one questions call on ${aiModel()} (about $${(list.notes.length * EST_USD_PER_NOTE).toFixed(2)} in all). Add --run to spend it.`);
        for (const n of list.notes) console.log(`  ${n.subject}: ${n.title}`);
        return;
    }
    if (!isAiConfigured()) throw new Error('CLAUDE_API_KEY is not set in backend/.env');
    const lines = [`# Recall test set: ${new Date().toISOString().slice(0, 10)}`, '', `Model ${aiModel()}, ${list.notes.length} notes, the current questions prompt.`, ''];
    let cost = 0;
    let failed = 0;
    for (const n of list.notes) {
        const rev = await prisma.revision.findFirst({ where: { id: n.revisionId, userId: user.id }, include: recallRevisionInclude });
        const material = rev ? await materialOf(user.id, rev) : null;
        if (!rev || !hasEnoughContent(material)) {
            lines.push(`## ${n.title}`, '', '**Skipped:** the note is gone or too short now.', '');
            continue;
        }
        const weak = rev.topicId ? (await openWeakSpotsOf(user.id, [rev.topicId])).get(rev.topicId) ?? [] : [];
        const request = questionsRequest({ model: aiModel(), material, cycleNumber: rev.cycleNumber, earlier: await earlierQuestions(rev), weakSpots: weak });
        const message = await callClaude(user.id, withRefusalFallbacks(request), 'recall eval');
        cost += costOfTokens(message.usage ?? {}, message.model).costUsd;
        let questions: RecallQuestion[] = [];
        let problems: string[];
        try {
            questions = parseQuestionsOutput(responseText(message));
            problems = check(questions, new Set(weak.map((w) => w._id)), docBlock(material));
        } catch (err) {
            problems = [`unreadable answer: ${err instanceof Error ? err.message : String(err)}`];
        }
        if (problems.length) failed += 1;
        lines.push(`## ${n.title} (${n.subject})`, '', problems.length ? `**Checks failed:** ${problems.join('; ')}` : 'Checks passed.', '');
        for (const q of questions) lines.push(`- **${q.kind}:** ${q.prompt}${q.weakSpotId ? ' *(a weak spot)*' : ''}`, `  - Answer key: ${q.answerKey}`);
        lines.push('');
    }
    lines.splice(3, 0, `${list.notes.length - failed} of ${list.notes.length} notes passed every check; cost $${cost.toFixed(2)}.`, '');
    const file = path.resolve(__dirname, '..', 'evals', `recall-${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    console.log(`Wrote ${file}: ${list.notes.length - failed}/${list.notes.length} passed, $${cost.toFixed(2)}.`);
}

(args.includes('--pick') ? pick(Number(flag('--pick') ?? 20)) : run(args.includes('--run')))
    .catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => disconnectPrisma());
