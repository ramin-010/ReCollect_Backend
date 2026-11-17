// Draws every wallpaper style (wallpaperStyles.ts) in every colour, lock and home, light and dark, on
// one invented day, for design checks and his pick (no database, no server):
//   npx ts-node --transpile-only scripts/wallpaper-styles-gallery.ts <out dir> [width] [height] [style]
// Writes <style>-<colour>-<theme>-<lock|home>.png.
import fs from 'node:fs';
import path from 'node:path';
import { WALLPAPER_FONTS } from '../src/services/ambient/ambient.service';
import { drawLock, drawWallpaper, type WallpaperInput } from '../src/services/ambient/wallpaperArt';
import { WALLPAPER_STYLES } from '../src/services/ambient/wallpaperStyles';
import { svgToPng } from '../src/services/docs/diagram/png';

const out = process.argv[2];
if (!out) throw new Error('usage: npx ts-node --transpile-only scripts/wallpaper-styles-gallery.ts <out dir> [width] [height] [style]');
const width = Number(process.argv[3] ?? 1080);
const height = Number(process.argv[4] ?? 2340);
const only = process.argv[5];
fs.mkdirSync(out, { recursive: true });

const items: NonNullable<WallpaperInput['items']> = [
    { kind: 'review', title: 'Monotonic stack', meta: '', done: true },
    { kind: 'review', title: 'DP: 0/1 knapsack', meta: '8 min', done: false },
    { kind: 'review', title: 'Graph BFS', meta: '5 min', done: false },
    { kind: 'focus', title: 'Two sliding-window mediums', meta: '', done: true },
    { kind: 'task', title: 'Write up the contest', meta: '5 pm', done: false },
];
const week = [...'1101101'].map((c, i) => ({ day: new Date(Date.UTC(2026, 10, 10 + i)).toISOString().slice(0, 10), active: c === '1' }));
const base: WallpaperInput = {
    state: 'working',
    date: 'Monday 16 November',
    headline: 'Read DDIA chapter 5',
    lines: [],
    week,
    items,
    counts: { reviews: { done: 1, total: 3 }, focus: { done: 1, total: 1 }, tasks: { done: 0, total: 1 }, minutesLeft: 13 },
    goal: { title: 'A backend role', daysLeft: 181, done: 1, total: 6 },
    line: 'Two reviews before lunch and the day is yours. Easy win.',
};

const png = (svg: string) => svgToPng(svg, width, height, 1, Math.max(width, height), WALLPAPER_FONTS).png;
const started = Date.now();
let n = 0;
for (const style of WALLPAPER_STYLES) {
    if (only && style.id !== only) continue;
    for (const color of style.colors) {
        for (const theme of ['dark', 'light'] as const) {
            const input = { ...base, style: style.id, color: color.id };
            fs.writeFileSync(path.join(out, `${style.id}-${color.id}-${theme}-lock.png`), png(drawLock(input, width, height, theme)));
            fs.writeFileSync(path.join(out, `${style.id}-${color.id}-${theme}-home.png`), png(drawWallpaper(input, width, height, theme)));
            n += 2;
        }
    }
}
console.log(`${n} pictures in ${out} (${width}x${height}), ${Date.now() - started} ms`);
