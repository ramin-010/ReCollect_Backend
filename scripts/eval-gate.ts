// The loop's gate on a labelled set (ECOSYSTEM_V2_PLAN stage 4): invented messages in pieces of 10, with
// the person's threads and an open question in view, through the real request and the real model; graded
// by code against what each message should be (kept: update, personal, item; dropped: none). Reports the
// misses and the two targets (it keeps 9 of 10 updates and answers; it drops 9 of 10 instructions).
//
//   node node_modules/ts-node/dist/bin.js --transpile-only scripts/eval-gate.ts [out.json]   (about 1 cent)
import fs from 'node:fs';
import path from 'node:path';
import { getAiClient } from '../src/services/claude/client';
import { costOfCall } from '../src/services/claude/pricing';
import { parseJson, responseText } from '../src/services/recall/output';
import { gateRequest, keptIndexes } from '../src/services/buddy/digest';

type Case = { text: string; expect: 'keep' | 'drop'; kind: string };

async function main() {
    const set = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evals', 'gate.json'), 'utf8')) as { onTheirMind: string[]; openQuestions: string[]; messages: Case[] };
    const client = getAiClient();
    const at = new Date().toISOString();
    const results: Array<Case & { kept: boolean }> = [];
    let cost = 0;
    for (let i = 0; i < set.messages.length; i += 10) {
        const piece = set.messages.slice(i, i + 10);
        const request = gateRequest(
            piece.map((m) => ({ at, text: m.text })),
            { loop: { titles: set.onTheirMind, asks: set.openQuestions } }
        );
        const message = await client.createMessage(request as never);
        cost += costOfCall(message.usage as never, message.model).costUsd;
        const kept = new Set(keptIndexes(parseJson(responseText(message)), piece.length));
        piece.forEach((m, j) => results.push({ ...m, kept: kept.has(j) }));
    }
    const rate = (f: (c: Case & { kept: boolean }) => boolean, want: boolean) => {
        const xs = results.filter(f);
        return { right: xs.filter((x) => x.kept === want).length, of: xs.length };
    };
    const updates = rate((c) => c.kind === 'update' || c.kind === 'answer', true);
    const personal = rate((c) => c.kind === 'personal' || c.kind === 'item', true);
    const instructions = rate((c) => c.kind === 'instruction', false);
    const rest = rate((c) => c.expect === 'drop' && c.kind !== 'instruction', false);
    const misses = results.filter((r) => r.kept !== (r.expect === 'keep')).map((r) => `${r.expect === 'keep' ? 'dropped' : 'kept'} (${r.kind}): ${r.text}`);
    const out = {
        ranAt: new Date().toISOString(),
        costUsd: Number(cost.toFixed(5)),
        updatesAndAnswersKept: updates,
        personalAndItemsKept: personal,
        instructionsDropped: instructions,
        approvalsLogsSmallTalkDropped: rest,
        targets: { updates: updates.right / updates.of >= 0.9, instructions: instructions.right / instructions.of >= 0.9 },
        misses,
    };
    console.log(JSON.stringify(out, null, 2));
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ ...out, results }, null, 2));
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
