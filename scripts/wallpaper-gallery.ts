// Draws the phone's two pictures (home: the sky of the day and its list; lock: the dial) in every
// state and theme with sample days, for design checks:
//   npx tsx scripts/wallpaper-gallery.ts <out dir> [width] [height]
// Writes <state>-<theme>-<home|lock>.png (no database, no server: the drawing alone).
import fs from 'node:fs';
import path from 'node:path';
import { wallpaperPng, type Ambient, type AmbientItem } from '../src/services/ambient/ambient.service';

const out = process.argv[2];
if (!out) throw new Error('usage: npx tsx scripts/wallpaper-gallery.ts <out dir> [width] [height]');
const width = Number(process.argv[3] ?? 1080);
const height = Number(process.argv[4] ?? 2340);
fs.mkdirSync(out, { recursive: true });

const week = (pattern: string) => {
    const end = new Date(Date.UTC(2026, 10, 15));
    return [...pattern].map((c, i) => ({ day: new Date(end.getTime() - (6 - i) * 86400000).toISOString().slice(0, 10), active: c === '1' }));
};
const review = (title: string, done = false, minutes = 5): AmbientItem => ({ kind: 'review', title, meta: done ? '' : `${minutes} min`, done });
const focus = (title: string, done = false): AmbientItem => ({ kind: 'focus', title, meta: '', done });
const task = (title: string, meta: string, done = false): AmbientItem => ({ kind: 'task', title, meta: done ? '' : meta, done });
const counts = (items: AmbientItem[], minutesLeft: number) => {
    const of = (k: AmbientItem['kind']) => ({ done: items.filter((i) => i.kind === k && i.done).length, total: items.filter((i) => i.kind === k).length });
    return { reviews: of('review'), focus: of('focus'), tasks: of('task'), minutesLeft };
};
const goal = { title: 'Backend SDE offer at ₹15–20 LPA', daysLeft: 182, done: 1, total: 6 };
const base = { date: 'Sunday 15 November', mode: 'normal' as const, updatedAt: new Date().toISOString(), goal };
const day = (items: AmbientItem[], minutesLeft: number) => ({ items, counts: counts(items, minutesLeft) });

const morning = [review('Monotonic stack', false, 8), review('DP: 0/1 knapsack', false, 8), review('Graph BFS: rotting oranges'), focus('Two sliding-window mediums before work'), task('Write up the LeetCode weekly contest', '5 pm')];
const working = [review('Monotonic stack', true), review('DP: 0/1 knapsack', false, 8), focus('Two sliding-window mediums before work', true), focus('Read DDIA chapter 5 (replication)'), task('Mock interview with Arjun', '6:30 pm')];
const evening = [review('Monotonic stack', true), review('DP: 0/1 knapsack', true), review('Graph BFS: rotting oranges'), focus('Two sliding-window mediums before work', true), focus('Read DDIA chapter 5 (replication)', true), task('Write up the LeetCode weekly contest', '1 day late')];
const done = [review('Monotonic stack', true), review('DP: 0/1 knapsack', true), focus('Two sliding-window mediums before work', true), task('Mock interview with Arjun', '', true)];
const rest = [review('Heaps: top-k with a min-heap')];

const samples: Ambient[] = [
    { ...base, state: 'morning', headline: '3 reviews · about 21 min', lines: [], week: week('1101101'), ...day(morning, 21) },
    { ...base, state: 'working', headline: 'Read DDIA chapter 5 (replication)', lines: [], week: week('1101101'), ...day(working, 8) },
    { ...base, state: 'evening', headline: '2 reviews done today', lines: [], week: week('1101101'), ...day(evening, 5) },
    { ...base, state: 'done', headline: '', lines: [], week: week('1101111'), ...day(done, 0) },
    { ...base, state: 'rest', mode: 'busy', headline: 'A light day', lines: [], week: week('1001001'), ...day(rest, 5) },
];

const started = Date.now();
for (const theme of ['dark', 'light'] as const) {
    for (const a of samples) {
        for (const screen of ['home', 'lock'] as const) {
            fs.writeFileSync(path.join(out, `${a.state}-${theme}-${screen}.png`), wallpaperPng(a, width, height, theme, screen));
        }
    }
}
console.log(`${samples.length * 4} pictures in ${out} (${width}x${height}), ${Date.now() - started} ms`);
