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

interface Case {
    id: string;
    /** State the case needs first (trash_one: a throwaway doc in the trash; removed after). */
    setup?: 'trash_one';
    request: string;
    mustUse?: string[][];
    mustNotUse?: string[];
    maxLevel?: 1 | 2 | 3;
    maxChanges?: number;
    textMust?: string[];
    textMustNot?: string[];
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
    return problems;
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
        const since = new Date();
        let turn: AssistantTurn;
        try {
            turn = await runAssistant({ userId: user.id, baseUrl, history: [], text: c.request });
        } catch (err) {
            console.log(`ERROR ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
            results.push({ id: c.id, passed: false, problems: ['the engine threw'], tools: [], costUsd: 0 });
            continue;
        }
        const problems = grade(c, turn);
        const notes = await cleanUp(user.id, since);
        if (made) await prisma.doc.deleteMany({ where: { id: made, userId: user.id } });
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
