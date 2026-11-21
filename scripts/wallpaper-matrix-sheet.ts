// Stage 11 (his item 10a): a contact sheet of the lock and home pictures on the size matrix (720×1600 to 1440×3200,
// 16:9 to 21:9), each drawn at its real size and shown at one height, with its safe zone dashed over it: the same
// zones tests/unit/utils/wallpaperSafeZones.test.ts holds every word to. No database, no server:
//   npx ts-node --transpile-only scripts/wallpaper-matrix-sheet.ts <out dir> [style] [theme]
// Writes wallpaper-matrix-lock.png and wallpaper-matrix-home.png.
import fs from 'node:fs';
import path from 'node:path';
import { WALLPAPER_FONTS, wallpaperSvg, type Ambient } from '../src/services/ambient/ambient.service';
import { svgToPng } from '../src/services/docs/diagram/png';
import { SAFE_ZONES, SIZE_MATRIX } from '../src/services/ambient/safeZones';

const out = process.argv[2];
if (!out) throw new Error('usage: npx ts-node --transpile-only scripts/wallpaper-matrix-sheet.ts <out dir> [style] [theme]');
const style = process.argv[3] ?? 'sky';
const theme = (process.argv[4] ?? 'dark') as 'light' | 'dark';
fs.mkdirSync(out, { recursive: true });

const day: Ambient = {
    state: 'working',
    date: 'Wednesday 18 November',
    headline: 'Read DDIA chapter 5',
    lines: ['Next: Consistent hashing', '3 reviews · about 14 min'],
    mode: 'normal',
    updatedAt: '2026-11-18T09:00:00.000Z',
    week: [...'1101101'].map((c, i) => ({ day: `2026-11-${12 + i}`, active: c === '1' })),
    items: [
        { kind: 'review', title: 'Monotonic stack', meta: '', done: true },
        { kind: 'review', title: 'DP: 0/1 knapsack', meta: '8 min', done: false },
        { kind: 'focus', title: 'Two sliding-window mediums', meta: '', done: false },
        { kind: 'task', title: 'Write up the contest', meta: '5 pm', done: false },
    ] as unknown as NonNullable<Ambient['items']>,
    counts: { reviews: { done: 1, total: 2 }, focus: { done: 0, total: 1 }, tasks: { done: 0, total: 1 }, minutesLeft: 13 } as unknown as NonNullable<Ambient['counts']>,
    goal: { title: 'A backend role', daysLeft: 178, done: 1, total: 6 } as unknown as NonNullable<Ambient['goal']>,
    line: { dayId: 'd', slot: 'morning', text: 'One mock system design today would make Friday’s interview easier.' },
    reminders: [
        { at: '6:30 pm', text: 'Call the dentist back' },
        { at: '9 pm', text: 'Write up the contest' },
    ] as unknown as NonNullable<Ambient['reminders']>,
    insight: 'Two weeks of evening reviews in a row: the mornings are free for the course now.',
};

const SHOWN_H = 640;
const GAP = 36;
const LABEL = 64;

for (const screen of ['lock', 'home'] as const) {
    const z = SAFE_ZONES[screen];
    let x = GAP;
    const parts: string[] = [];
    for (const [w, h] of SIZE_MATRIX) {
        const zoom = SHOWN_H / h;
        const shownW = Math.round(w * zoom);
        const png = svgToPng(wallpaperSvg(day, w, h, theme, screen, { style }), w, h, zoom, Math.max(w, h), WALLPAPER_FONTS).png;
        const ratio = (h / w) * 9;
        parts.push(
            `<image x="${x}" y="${GAP}" width="${shownW}" height="${SHOWN_H}" href="data:image/png;base64,${png.toString('base64')}"/>`,
            `<rect x="${x + z.left * shownW}" y="${GAP + z.top * SHOWN_H}" width="${(z.right - z.left) * shownW}" height="${(z.bottom - z.top) * SHOWN_H}" fill="none" stroke="#F2B544" stroke-width="2" stroke-dasharray="8 6"/>`,
            `<text x="${x + shownW / 2}" y="${GAP + SHOWN_H + 32}" text-anchor="middle" font-family="Inter" font-size="20" font-weight="600" fill="#2C2C2B">${w} × ${h}</text>`,
            `<text x="${x + shownW / 2}" y="${GAP + SHOWN_H + 56}" text-anchor="middle" font-family="Inter" font-size="16" fill="#6F6E69">${ratio.toFixed(1)}:9</text>`,
        );
        x += shownW + GAP;
    }
    const width = x;
    const height = GAP + SHOWN_H + LABEL + GAP;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#F4F3F2"/>${parts.join('')}</svg>`;
    const file = path.join(out, `wallpaper-matrix-${screen}.png`);
    fs.writeFileSync(file, svgToPng(svg, width, height, 1, Math.max(width, height), WALLPAPER_FONTS).png);
    console.log(`${file} (${width}×${height})`);
}
