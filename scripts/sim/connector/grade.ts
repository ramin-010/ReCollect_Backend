// MCP_MEMORY_PLAN stage 5: grades the connector simulation from what reached the server, per host, against the labels
// of chats.json: missed updates, unnecessary saves, wrong links, inferences not marked, whether get_brief came first,
// and the find-again rate with other words. Inputs: the remote door's trace (MCP_TRACE_FILE, one tool call a line)
// and the chat windows the operator marks while running the chats:
//   npx ts-node --transpile-only scripts/sim/connector/grade.ts mark <chatId> <start|end> <host> [confirmations] [instructionsShown]
//   npx ts-node --transpile-only scripts/sim/connector/grade.ts report <trace.jsonl>
// The report prints k of n per host with the misses quoted; it never prints a token (the trace holds none).
import fs from 'node:fs';
import path from 'node:path';

interface Label {
    text: string;
    expect: 'none' | 'remember' | 'update' | 'recall' | 'remember-or-none';
    on?: string;
    update?: string;
    kind?: string;
    inferredIfSaved?: boolean;
    target?: string;
    measure?: string;
}
interface Call {
    at: string;
    app: string;
    tool: string;
    args: Record<string, unknown>;
}
interface Window {
    chat: string;
    host: string;
    from?: string;
    to?: string;
    confirmations?: number;
    instructionsShown?: boolean;
}

const DIR = __dirname;
const WINDOWS = path.join(DIR, 'windows.local.json');
const chats = JSON.parse(fs.readFileSync(path.join(DIR, 'chats.json'), 'utf8')) as { chats: Array<{ id: string; messages: Label[] }> };
const planted = fs.existsSync(path.join(DIR, 'planted.local.json')) ? (JSON.parse(fs.readFileSync(path.join(DIR, 'planted.local.json'), 'utf8')) as { userId: string; ids: Record<string, string> }) : null;

const words = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 3));
const close = (a: string, b: string) => {
    const x = words(a);
    const y = words(b);
    const shared = [...x].filter((w) => y.has(w)).length;
    return shared >= 2 || (shared >= 1 && shared / Math.min(x.size || 1, y.size || 1) >= 0.5);
};
const SAVES = new Set(['remember', 'update_memory']);

function mark(chat: string, edge: string, host: string, confirmations?: string, shown?: string): void {
    const list: Window[] = fs.existsSync(WINDOWS) ? JSON.parse(fs.readFileSync(WINDOWS, 'utf8')) : [];
    let w = list.find((x) => x.chat === chat && x.host === host);
    if (!w) list.push((w = { chat, host }));
    if (edge === 'start') w.from = new Date().toISOString();
    else w.to = new Date().toISOString();
    if (confirmations !== undefined) w.confirmations = Number(confirmations);
    if (shown !== undefined) w.instructionsShown = shown === 'yes';
    fs.writeFileSync(WINDOWS, JSON.stringify(list, null, 2));
    console.log(`${chat} ${edge} (${host})`);
}

async function report(traceFile: string): Promise<void> {
    const calls: Call[] = fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const windows: Window[] = JSON.parse(fs.readFileSync(WINDOWS, 'utf8'));
    const hosts = [...new Set(windows.map((w) => w.host))];
    const { listMemories } = await import('../../../src/services/buddy/memory.service');
    const { prisma } = await import('../../../src/db/prisma');
    // The id and every later version of it (a correction's new memory names the old one in supersedesId).
    const chainOf = async (id: string): Promise<Set<string>> => {
        const ids = new Set([id]);
        for (let at = [id]; at.length; ) {
            const next = await prisma.memory.findMany({ where: { supersedesId: { in: at } }, select: { id: true } });
            at = next.map((n) => n.id).filter((n) => !ids.has(n));
            at.forEach((n) => ids.add(n));
        }
        return ids;
    };
    for (const host of hosts) {
        const tally = { expected: 0, missed: 0, saves: 0, unnecessary: 0, links: 0, wrongLinks: 0, inferences: 0, unmarked: 0, chats: 0, briefFirst: 0, finds: 0, found: 0, foundFirst: 0, confirmations: 0 };
        const misses: string[] = [];
        for (const chat of chats.chats) {
            const w = windows.find((x) => x.chat === chat.id && x.host === host);
            if (!w?.from) continue;
            tally.chats++;
            tally.confirmations += w.confirmations ?? 0;
            const inChat = calls.filter((c) => c.at >= w.from! && (!w.to || c.at <= w.to));
            if (inChat[0]?.tool === 'get_brief') tally.briefFirst++;
            const saves = inChat.filter((c) => SAVES.has(c.tool));
            const used = new Set<Call>();
            for (const m of chat.messages) {
                if (m.expect === 'recall' && planted) {
                    // The target is planted, or something an earlier chat should have saved (e.g. "backend"): when
                    // nothing about it was ever saved, the find-again can't be judged (that miss is counted where
                    // the save was missed).
                    const isTarget = (h: { _id: string; text: string }) => h._id === planted.ids[m.target!] || words(h.text).has(m.target!);
                    const all = await listMemories(planted.userId, { status: 'all', limit: 200 });
                    if (!all.some(isTarget)) {
                        misses.push(`find-again n/a: "${m.text}" → nothing about "${m.target}" was ever saved`);
                        continue;
                    }
                    tally.finds++;
                    // Every recall_memory call of the chat is tried in order, as the assistant made them: found
                    // when one of them returns the target; "first query" when the first one already did (the
                    // server's search alone, without the assistant trying other words).
                    const queries = inChat.filter((c) => c.tool === 'recall_memory');
                    let at = -1;
                    for (let i = 0; i < queries.length && at < 0; i++) {
                        const args = queries[i]!.args;
                        const hits = await listMemories(planted.userId, { q: typeof args['query'] === 'string' ? args['query'] : undefined, kind: (args['kind'] as never) ?? undefined, limit: 50 });
                        if (hits.some(isTarget)) at = i;
                    }
                    const tried = queries.map((c) => JSON.stringify(c.args['query'] ?? `kind:${String(c.args['kind'])}`)).join(', ');
                    if (at >= 0) {
                        tally.found++;
                        if (at === 0) tally.foundFirst++;
                        else misses.push(`find-again on a later try: "${m.text}" → ${tried}`);
                    } else misses.push(`find-again: "${m.text}" → ${queries.length ? tried + ' found nothing right' : 'no recall_memory call'}`);
                    continue;
                }
                const hit = saves.find((c) => !used.has(c) && close(String(c.args['text'] ?? ''), m.text));
                if (hit) used.add(hit);
                if (m.expect === 'remember' || m.expect === 'update') {
                    tally.expected++;
                    if (!hit) {
                        tally.missed++;
                        misses.push(`missed: "${m.text}"`);
                        continue;
                    }
                    if (m.expect === 'update') {
                        tally.links++;
                        const want = planted?.ids[m.on!];
                        // A planted memory a correction replaced (an earlier round) lives on in its newest version:
                        // an update on any version of its chain is linked right.
                        const chain = want ? await chainOf(want) : new Set<string>();
                        if (hit.tool !== 'update_memory' || (want && !chain.has(String(hit.args['on'])))) {
                            tally.wrongLinks++;
                            misses.push(`wrong link: "${m.text}" → ${hit.tool} on ${String(hit.args['on'] ?? '(none)')}`);
                        }
                    }
                }
                if (m.inferredIfSaved && hit) {
                    tally.inferences++;
                    if (hit.args['inferred'] !== true) {
                        tally.unmarked++;
                        misses.push(`inference not marked: "${String(hit.args['text'])}"`);
                    }
                }
                if (m.expect === 'none' && hit) {
                    tally.unnecessary++;
                    misses.push(`unnecessary save: "${String(hit.args['text'])}" (from "${m.text}")`);
                }
            }
            for (const s of saves) if (!used.has(s)) {
                tally.unnecessary++;
                misses.push(`unnecessary save (no message): "${String(s.args['text'])}"`);
            }
            tally.saves += saves.length;
        }
        console.log(`\n${host}: ${tally.chats} chats`);
        console.log(`  passed on ${tally.expected - tally.missed} of ${tally.expected} (missed ${tally.missed})`);
        console.log(`  unnecessary saves ${tally.unnecessary} of ${tally.saves} saves`);
        console.log(`  linked right ${tally.links - tally.wrongLinks} of ${tally.links}`);
        console.log(`  inferences marked ${tally.inferences - tally.unmarked} of ${tally.inferences}`);
        console.log(`  get_brief first ${tally.briefFirst} of ${tally.chats}`);
        console.log(`  found by other words ${tally.found} of ${tally.finds} (on the first query ${tally.foundFirst})`);
        console.log(`  confirmation prompts ${tally.confirmations} in ${tally.chats} chats`);
        console.log(`  instructions shown: ${windows.find((w) => w.host === host && w.chat === 'c1-instructions')?.instructionsShown ?? 'not marked'}`);
        for (const m of misses) console.log(`  - ${m}`);
    }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'mark') mark(rest[0]!, rest[1]!, rest[2]!, rest[3], rest[4]);
else if (cmd === 'report') void report(rest[0]!).then(() => process.exit(0));
else console.log('grade.ts mark <chatId> <start|end> <host> [confirmations] [instructionsShown yes|no] | report <trace.jsonl>');
