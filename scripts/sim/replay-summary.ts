// The replays and probes of a run, side by side (SIMULATION_PLAN §6.3, §8): each night's words per variant and run,
// with what the experiments count, and the probes' answers per day. Writes replays.md into the run's folder.
//   node node_modules/ts-node/dist/bin.js --transpile-only scripts/sim/replay-summary.ts --out <run dir>
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[process.argv.indexOf('--out') + 1]!);
const lines: string[] = ['# Replays and probes', ''];
const numberish = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty)\b/i;
const bro = /\bbro\b|\bdude\b|\blol\b|\bngl\b|\bmate\b|💪|😅|🔥/i;

const rdir = path.join(out, 'replays');
if (fs.existsSync(rdir)) {
    const files = fs.readdirSync(rdir).filter((f) => f.endsWith('.json')).sort();
    const groups = new Map<string, any[]>();
    for (const f of files) {
        const r = JSON.parse(fs.readFileSync(path.join(rdir, f), 'utf8'));
        const key = `${r.night} ${r.variant}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    lines.push('## Nights again (each a fresh copy of the day before)', '');
    for (const [key, runs] of groups) {
        lines.push(`### ${key} (${runs.length} runs)`);
        for (const r of runs) {
            const step = r.steps[0] ?? {};
            const ls: string[] = (step.lines ?? []).map((l: any) => `${l.from ?? l.slot}-${l.until ?? ''} ${l.text}`);
            const nums = (step.lines ?? []).filter((l: any) => numberish.test(String(l.text).split(/[.,:]/)[0] ?? '')).length;
            const broWords = [...(step.lines ?? []).map((l: any) => l.text), step.note ?? '', step.insight ?? ''].filter((t: string) => bro.test(t)).length;
            lines.push(`- run ${r.run}${r.error ? ` ERROR ${r.error}` : ''}: ${ls.length} lines (${nums} lead with a number), ${r.asks.length} questions, voice markers ${broWords}, tone ${r.tone}, thumbs ${r.thumbs}`);
            for (const l of ls) lines.push(`  - ${l}`);
            if (step.insight) lines.push(`  - thought: ${step.insight}`);
            if (step.note) lines.push(`  - note: ${step.note}`);
            for (const a of r.asks) lines.push(`  - question: ${a.text}`);
        }
        lines.push('');
    }
}
const pdir = path.join(out, 'probes');
if (fs.existsSync(pdir)) {
    lines.push('## Probes (the same four questions at the end of days 1, 3, 5, 7)', '');
    for (const f of fs.readdirSync(pdir).filter((x) => x.endsWith('.json')).sort()) {
        const p = JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'));
        lines.push(`### ${p.day}`);
        if (p.brief?.onMind?.length) lines.push(`- brief, on his mind: ${p.brief.onMind.map((t: any) => t.title).join('; ')}`);
        for (const a of p.answers) lines.push(`- **${a.q}** (${a.tools.join(', ') || 'no tools'})`, `  > ${String(a.a).replace(/\n+/g, ' ').slice(0, 900)}`);
        lines.push('');
    }
}
fs.writeFileSync(path.join(out, 'replays.md'), lines.join('\n') + '\n');
console.log(`wrote ${path.join(out, 'replays.md')} (${lines.length} lines)`);
