// The manager's test set (MANAGER_AND_DOCS_PLAN §3.4): runs evals/manager.json through the real
// engine on the QA account, grades each answer by code (the tools it called, the level it reached,
// patterns on its words), then undoes every change the case made and dismisses any card it left.
// Run after every prompt or tool change. The real model costs money (about 4 cents a case, about
// $1 a full run), so it needs --yes; --fake runs the scripted stand-in instead (no spend, checks
// the runner itself). The API must be running (npm run up): the catalogue calls it back.
//
//   npx ts-node --transpile-only scripts/eval-manager.ts --fake            (no AI spend)
//   npx ts-node --transpile-only scripts/eval-manager.ts --yes [--only id,id] [--user qa@recollect.local]
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/db/prisma';
import { ASK_AI_AGENT } from '../src/services/actions/actions.service';
import { undoAgentEdit } from '../src/services/agent/agentEdits.service';
import { trashDoc } from '../src/services/docs/trash.service';
import { runAssistant, type AssistantTurn } from '../src/services/assistant/engine';
import { dismissSuggestion } from '../src/services/learningDb/suggestions.service';
import { loadLearningContext } from '../src/services/learningDb/common';
import { addDays } from '../src/services/learning';
import * as Y from 'yjs';
import { createDocForAgent } from '../src/services/agent/agentDocs.service';
import { blockText } from '../src/services/agent/agentBlocks.service';
import { isFooter } from '../src/services/agent/docNotes';
import { readBlocks } from '../src/services/docs/blocks/serverEditor';

interface Case {
    id: string;
    /**
     * State the case needs first (trash_one: a throwaway doc in the trash; removed after. work_log: the
     * work log on, with yesterday's lines in the "erp" project; removed after. threads: the buddy and its
     * loop on, with three invented threads (a habit, a "don't ask" one, a plan with a time); removed after).
     */
    setup?: 'trash_one' | 'work_log' | 'threads' | 'study_doc';
    /**
     * Stage 14, with setup study_doc (a doc "Two pointers, studied" with the sections "Why it works" and "Complexity";
     * removed after): the section a note from Ask AI must land in, checked in the doc; null: no note anywhere.
     */
    noteUnder?: string | null;
    request: string;
    mustUse?: string[][];
    mustNotUse?: string[];
    maxLevel?: 1 | 2 | 3;
    maxChanges?: number;
    textMust?: string[];
    textMustNot?: string[];
    /** The answer's length at most, in words (personal talk is a few sentences). */
    maxWords?: number;
}

const QA_EMAIL = 'qa@recollect.local';
const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
};

/** What failed in one answer, in words (empty = passed). */
export function grade(c: Case, turn: Pick<AssistantTurn, 'tools' | 'text' | 'stopped'>): string[] {
    const used = turn.tools.map((t) => t.name);
    const problems: string[] = [];
    if (turn.stopped !== 'done') problems.push(`stopped: ${turn.stopped}`);
    for (const group of c.mustUse ?? []) if (!group.some((n) => used.includes(n))) problems.push(`did not use ${group.join(' or ')}`);
    for (const n of c.mustNotUse ?? []) if (used.includes(n)) problems.push(`used ${n}`);
    const worked = turn.tools.filter((t) => t.ok);
    const top = Math.max(0, ...worked.map((t) => (t.suggestionId ? 3 : t.level)));
    if (c.maxLevel !== undefined && top > c.maxLevel) problems.push(`reached level ${top} (at most ${c.maxLevel})`);
    const changes = worked.filter((t) => t.level === 2 && !t.suggestionId).length;
    if (c.maxChanges !== undefined && changes > c.maxChanges) problems.push(`${changes} changes (at most ${c.maxChanges})`);
    for (const p of c.textMust ?? []) if (!new RegExp(p, 'i').test(turn.text)) problems.push(`answer lacks /${p}/`);
    for (const p of c.textMustNot ?? []) if (new RegExp(p, 'i').test(turn.text)) problems.push(`answer says /${p}/`);
    const words = turn.text.split(/\s+/).filter(Boolean).length;
    if (c.maxWords !== undefined && words > c.maxWords) problems.push(`${words} words (at most ${c.maxWords})`);
    return problems;
}

/** Stage 14's doc (sections as a study note has them). */
const STUDY_DOC = [
    '## Two pointers',
    '',
    'Works on a sorted array: one pointer at each end, moving toward each other.',
    '',
    '### Why it works',
    '',
    'Start one pointer at each end. If the sum is too small, move the left pointer right; if it is too big, move the right pointer left.',
    '',
    '### Complexity',
    '',
    'O(n) time and O(1) extra space.',
].join('\n');

/** Where Ask AI's notes landed in the seeded doc: problems when not inside `under` (null: none anywhere). */
async function notePlaced(docId: string, under: string | null): Promise<string[]> {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId }, select: { yjsState: true } });
    const ydoc = new Y.Doc();
    if (row.yjsState) Y.applyUpdate(ydoc, row.yjsState);
    const top = readBlocks(ydoc);
    ydoc.destroy();
    const texts = top.map(blockText);
    const notes = texts.map((t, i) => ({ t, i })).filter((x) => isFooter(x.t));
    if (under === null) return notes.length ? [`added ${notes.length} note(s) to the doc`] : [];
    const at = top.findIndex((b) => b.type === 'heading' && blockText(b).trim().toLowerCase() === under.toLowerCase());
    let end = at + 1;
    while (at >= 0 && end < top.length && top[end]!.type !== 'heading') end += 1;
    if (!notes.length) return ['no note added'];
    return notes.every((n) => n.i > at && n.i < end) ? [] : [`a note landed outside "${under}"`];
}

/** Every change the case made, undone (newest first); every card it left, dismissed. */
async function cleanUp(userId: string, since: Date): Promise<string[]> {
    const notes: string[] = [];
    const edits = await prisma.agentEdit.findMany({ where: { userId, agentName: ASK_AI_AGENT, createdAt: { gte: since }, undoneAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, summary: true } });
    for (const e of edits) {
        try {
            await undoAgentEdit(userId, e.id);
        } catch (err) {
            notes.push(`could not undo "${e.summary}": ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const cards = await prisma.suggestion.findMany({ where: { userId, proposedBy: 'ask_ai', status: 'pending', createdAt: { gte: since } }, select: { id: true } });
    for (const s of cards) await dismissSuggestion(userId, s.id).catch(() => undefined);
    // Stage 7: a line it pinned to the lock screen comes off (a pin is its own record, not an agent edit).
    await prisma.lockPin.updateMany({ where: { userId, setBy: 'ask_ai', createdAt: { gte: since }, clearedAt: null }, data: { clearedAt: new Date() } });
    return notes;
}

async function main(): Promise<void> {
    const fake = process.argv.includes('--fake');
    if (!fake && !process.argv.includes('--yes')) {
        console.log('This calls the real model (about 4 cents a case, about $1 a full run). Add --yes to run it, or --fake for the stand-in.');
        return;
    }
    const email = (arg('--user') ?? QA_EMAIL).toLowerCase();
    if (email !== QA_EMAIL) throw new Error(`The test set runs on the QA account (${QA_EMAIL}) only: it makes and undoes changes.`);
    if (fake) process.env['ASSISTANT_FAKE'] = email;
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    const baseUrl = process.env['RECOLLECT_API'] ?? 'http://localhost:8002';
    const all = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evals', 'manager.json'), 'utf8')) as { cases: Case[] }).cases;
    const only = arg('--only')?.split(',');
    const cases = only ? all.filter((c) => only.includes(c.id)) : all;

    const results = [];
    let spent = 0;
    for (const c of cases) {
        let made: string | null = null;
        if (c.setup === 'trash_one') {
            made = (await prisma.doc.create({ data: { userId: user.id, title: `Eval scratch ${Date.now().toString().slice(-5)}` }, select: { id: true } })).id;
            await trashDoc(user.id, made);
        }
        let workWasOn: boolean | null = null;
        if (c.setup === 'work_log') {
            const { today } = await loadLearningContext(user.id, new Date());
            const day = new Date(`${addDays(today, -1)}T00:00:00Z`);
            workWasOn = (await prisma.buddyState.findUnique({ where: { userId: user.id }, select: { workLog: true } }))?.workLog ?? false;
            await prisma.buddyState.upsert({ where: { userId: user.id }, create: { userId: user.id, workLog: true }, update: { workLog: true } });
            await prisma.workLine.deleteMany({ where: { userId: user.id, sessionKey: 'eval_work' } });
            await prisma.workLine.createMany({
                data: [
                    { userId: user.id, day, project: 'erp', sessionKey: 'eval_work', kind: 'did', text: 'Fixed the GST rounding in the invoice report (per line, then summed)', office: true, position: 0 },
                    { userId: user.id, day, project: 'erp', sessionKey: 'eval_work', kind: 'decided', text: 'Kept the old CSV export until the client signs off', office: true, position: 1 },
                    { userId: user.id, day, project: 'erp', sessionKey: 'eval_work', kind: 'stuck', text: 'Negative stock on returns in the stock ledger, not fixed yet', office: true, position: 2 },
                ],
            });
        }
        // Stage 5's personal cases: the buddy and its loop on, three invented threads (removed after).
        let loopWas: { enabled: boolean; loop: boolean } | null = null;
        const seeded: string[] = [];
        if (c.setup === 'threads') {
            const s = await prisma.buddyState.findUnique({ where: { userId: user.id }, select: { enabled: true, loop: true } });
            loopWas = { enabled: s?.enabled ?? false, loop: s?.loop ?? false };
            await prisma.buddyState.upsert({ where: { userId: user.id }, create: { userId: user.id, enabled: true, loop: true }, update: { enabled: true, loop: true } });
            const now = new Date();
            const day = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
            const make = async (title: string, keywords: string[], over: Record<string, unknown>, events: string[]) => {
                const t = await prisma.buddyThread.create({ data: { userId: user.id, title, keywords, stage: 'active', lastSaidAt: now, firstDay: day, ...over }, select: { id: true } });
                seeded.push(t.id);
                for (const [i, text] of events.entries())
                    await prisma.buddyThreadEvent.create({ data: { userId: user.id, threadId: t.id, kind: 'progress', text, saidAt: new Date(now.getTime() - (events.length - i) * 86_400_000), forDay: day, via: 'eval', originKey: `eval:${t.id}:${i}` } });
            };
            await make('Guitar most evenings', ['guitar', 'practice', 'music'], { rhythm: 'daily' }, ['Played for 20 minutes', 'Learned a new chord shape']);
            await make('Eat fewer sweets', ['diet', 'sweets', 'sugar', 'food'], { noAsk: true, steer: "don't ask me about my diet" }, ['Skipped dessert twice']);
            await make('Learn to swim', ['swim', 'swimming', 'pool'], { stage: 'noticed', lookAgainOn: new Date(`${now.getUTCFullYear() + 1}-03-01T00:00:00Z`) }, []);
        }
        // Stage 14: a doc they are studying (on the new editor), removed after.
        if (c.setup === 'study_doc') {
            made = (await createDocForAgent({ userId: user.id, agentName: 'eval', tokenId: null }, { title: 'Two pointers, studied', markdown: STUDY_DOC })).id;
        }
        const since = new Date();
        let turn: AssistantTurn;
        try {
            turn = await runAssistant({ userId: user.id, baseUrl, history: [], text: c.request });
        } catch (err) {
            console.log(`ERROR ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
            results.push({ id: c.id, passed: false, problems: ['the engine threw'], tools: [], costUsd: 0 });
            if (made) await prisma.doc.deleteMany({ where: { id: made, userId: user.id } });
            continue;
        }
        const problems = grade(c, turn);
        if (c.setup === 'study_doc' && made && c.noteUnder !== undefined) problems.push(...(await notePlaced(made, c.noteUnder)));
        const notes = await cleanUp(user.id, since);
        if (made) await prisma.doc.deleteMany({ where: { id: made, userId: user.id } });
        if (c.setup === 'work_log') {
            await prisma.workLine.deleteMany({ where: { userId: user.id, sessionKey: 'eval_work' } });
            if (!workWasOn) await prisma.buddyState.update({ where: { userId: user.id }, data: { workLog: false } });
        }
        if (seeded.length) await prisma.buddyThread.deleteMany({ where: { userId: user.id, id: { in: seeded } } });
        if (loopWas) await prisma.buddyState.update({ where: { userId: user.id }, data: loopWas });
        spent += turn.costUsd;
        const tools = turn.tools.map((t) => `${t.name}${t.ok ? '' : '(failed)'}`);
        console.log(`${problems.length ? 'FAIL' : 'pass'} ${c.id.padEnd(20)} ${(turn.costUsd * 100).toFixed(1).padStart(5)}¢  ${tools.join(', ') || '(no tools)'}${problems.length ? `\n     ${problems.join('; ')}` : ''}${notes.length ? `\n     ${notes.join('; ')}` : ''}`);
        results.push({ id: c.id, request: c.request, passed: problems.length === 0, problems, tools, answer: turn.text, rounds: turn.rounds, costUsd: turn.costUsd, cleanUp: notes });
    }
    const passed = results.filter((r) => r.passed).length;
    console.log(`\n${passed}/${results.length} passed · ${fake ? 'fake model (no spend)' : `spent $${spent.toFixed(2)}`}`);
    const dir = path.join(__dirname, '..', 'evals', 'results');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `manager-${fake ? 'fake-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), fake, passed, total: results.length, spentUsd: spent, results }, null, 2));
    console.log(`results: ${path.relative(process.cwd(), file)}`);
}

if (require.main === module) {
    main()
        .catch((err) => {
            console.error(err);
            process.exitCode = 1;
        })
        .finally(() => prisma.$disconnect());
}
