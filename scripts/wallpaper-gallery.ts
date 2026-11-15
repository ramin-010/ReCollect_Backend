// Draws the phone's wallpaper in every state and theme with sample lines, for design checks:
//   npx tsx scripts/wallpaper-gallery.ts <out dir> [width] [height]
// Writes <state>-<theme>.png (no database, no server: the drawing alone).
import fs from 'node:fs';
import path from 'node:path';
import { wallpaperPng, type Ambient } from '../src/services/ambient/ambient.service';

const out = process.argv[2];
if (!out) throw new Error('usage: npx tsx scripts/wallpaper-gallery.ts <out dir> [width] [height]');
const width = Number(process.argv[3] ?? 1080);
const height = Number(process.argv[4] ?? 2340);
fs.mkdirSync(out, { recursive: true });

const week = (pattern: string) => {
    const end = new Date(Date.UTC(2026, 10, 15));
    return [...pattern].map((c, i) => ({ day: new Date(end.getTime() - (6 - i) * 86400000).toISOString().slice(0, 10), active: c === '1' }));
};
const base = { date: 'Sunday 15 November', mode: 'normal' as const, updatedAt: new Date().toISOString() };
const samples: Ambient[] = [
    { ...base, state: 'morning', headline: '3 reviews · about 24 min', lines: ['Next: Message queues', 'Finish the LRU note'], week: week('1101101') },
    { ...base, state: 'working', headline: 'Finish the LRU cache note before the standup', lines: ['2 reviews · about 16 min'], week: week('1101101') },
    { ...base, state: 'evening', headline: '2 reviews done today', lines: ['1 left · about 8 min'], week: week('1101101') },
    { ...base, state: 'done', headline: '', lines: [], week: week('1101111') },
    { ...base, state: 'rest', mode: 'busy', headline: 'A light day: 1 review · about 5 min', lines: ['Next: Heaps'], week: week('1001001') },
];

const started = Date.now();
for (const theme of ['dark', 'light'] as const) {
    for (const a of samples) {
        const file = path.join(out, `${a.state}-${theme}.png`);
        fs.writeFileSync(file, wallpaperPng(a, width, height, theme));
    }
}
console.log(`${samples.length * 2} pictures in ${out} (${width}x${height}), ${Date.now() - started} ms`);
