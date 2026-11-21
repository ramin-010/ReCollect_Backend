// Stage 20 (ECOSYSTEM_V2_PLAN): what landed, for the talk after the trial. Counts of what followed the buddy's words
// (the quiet record, BuddyOutcome) by kind and by part of the day, for one account. Reads only.
//   node node_modules/ts-node/dist/bin.js --transpile-only scripts/what-landed.ts <email> [days]
import 'dotenv/config';
import { prisma } from '../src/db/prisma';

async function main() {
    const [email, daysArg] = process.argv.slice(2);
    if (!email) throw new Error('usage: what-landed.ts <email> [days]');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: email.toLowerCase() }, select: { id: true, timezone: true } });
    const days = Number(daysArg ?? 14);
    const rows = await prisma.buddyOutcome.findMany({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - days * 86_400_000) } }, orderBy: { day: 'asc' } });
    const part = (d: Date | null) => {
        if (!d) return 'day';
        const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: user.timezone, hour: '2-digit', hour12: false }).format(d)) % 24;
        return h < 12 && h >= 4 ? 'morning' : h < 17 && h >= 12 ? 'afternoon' : h < 22 && h >= 17 ? 'evening' : 'night';
    };
    const table = new Map<string, Map<string, number>>();
    for (const r of rows) {
        const key = `${r.shown} · ${part(r.fromAt)}`;
        const m = table.get(key) ?? new Map<string, number>();
        m.set(r.outcome, (m.get(r.outcome) ?? 0) + 1);
        table.set(key, m);
    }
    console.log(`${rows.length} things shown in ${days} days`);
    for (const [key, m] of [...table.entries()].sort()) console.log(`${key.padEnd(22)} ${[...m.entries()].map(([o, n]) => `${o} ${n}`).join(' · ')}`);
    const acted = rows.filter((r) => r.outcome === 'acted' || r.outcome === 'answered');
    if (acted.length) console.log(`\nfollowed through (${acted.length}):\n${acted.map((r) => `- ${r.day.toISOString().slice(0, 10)} ${r.shown}: ${r.text}${r.minutes != null ? ` (after ${r.minutes} min)` : ''}`).join('\n')}`);
}

main()
    .catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
