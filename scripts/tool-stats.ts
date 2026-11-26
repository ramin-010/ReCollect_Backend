// TOOL_ACCESS_PLAN §6.5: the product's view of wrong picks, from McpToolStat (no user, no arguments, no text):
//   calls per tool; the share with bad inputs per tool; names that don't exist; find_tools with no match; how often
//   a tool found was then run (calls through use_tool / use_read_tool against find_tools calls).
//
//   npx ts-node --transpile-only scripts/tool-stats.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--app ChatGPT]
import { prisma } from '../src/db/prisma';

const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
};

async function main(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const from = arg('--from') ?? new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const to = arg('--to') ?? today;
    const app = arg('--app');
    const rows = await prisma.mcpToolStat.findMany({ where: { day: { gte: from, lte: to }, ...(app ? { app } : {}) } });
    const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((n, r) => n + r.count, 0);
    const tools = [...new Set(rows.map((r) => r.tool))];
    const per = tools
        .map((t) => {
            const all = sum((r) => r.tool === t);
            const bad = sum((r) => r.tool === t && r.outcome === 'bad_args');
            const ms = rows.filter((r) => r.tool === t).reduce((n, r) => n + r.msTotal, 0);
            return { t, all, bad, avg: all ? Math.round(ms / all) : 0, viaRunner: sum((r) => r.tool === t && r.via !== 'direct') };
        })
        .sort((a, b) => b.all - a.all);
    console.log(`Tool calls ${from} → ${to}${app ? ` (${app})` : ''}: ${sum(() => true)} in all`);
    console.log('\nPer tool: calls · bad inputs · through a runner · avg ms');
    for (const p of per) console.log(`  ${p.t.padEnd(24)} ${String(p.all).padStart(6)} · ${p.bad ? `${((100 * p.bad) / p.all).toFixed(1)}%` : '-'} · ${p.viaRunner} · ${p.avg}`);
    const unknown = rows.filter((r) => r.outcome === 'unknown_tool' || r.outcome === 'not_reachable');
    console.log(`\nNames that don't exist or aren't reachable: ${unknown.length ? unknown.map((r) => `${r.tool} ×${r.count}`).join(', ') : 'none'}`);
    const finds = sum((r) => r.tool === 'find_tools');
    console.log(`find_tools: ${finds} calls, ${sum((r) => r.tool === 'find_tools' && r.outcome === 'no_match')} with no match`);
    const ran = sum((r) => r.via === 'use_tool' || r.via === 'use_read_tool');
    console.log(`A found tool run (calls through the runners per find_tools call): ${finds ? (ran / finds).toFixed(2) : '-'}`);
    console.log(`Over the call limit: ${sum((r) => r.outcome === 'limited')}`);
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
        console.error(err);
        await prisma.$disconnect();
        process.exit(1);
    });
