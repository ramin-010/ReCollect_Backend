// Stage 16 (ECOSYSTEM_V2_PLAN): the render sheet for the owner's look at "the lock is now, the home is ahead". One sheet
// per theme and style: the lock with Buddy's line and two and three of today's rows, the dial with rows, the home with
// Pick up, Coming up and the thought, and the empty home (nothing ahead: the picture alone). No database, no server:
//   npx ts-node --transpile-only scripts/wallpaper-ahead-sheet.ts <out dir> [style] [theme] [prefix]
import fs from 'node:fs';
import path from 'node:path';
import { WALLPAPER_FONTS, wallpaperSvg, type Ambient } from '../src/services/ambient/ambient.service';
import { svgToPng } from '../src/services/docs/diagram/png';

const out = process.argv[2];
if (!out) throw new Error('usage: npx ts-node --transpile-only scripts/wallpaper-ahead-sheet.ts <out dir> [style] [theme] [prefix]');
const style = process.argv[3] ?? 'sky';
const theme = (process.argv[4] ?? 'dark') as 'light' | 'dark';
const prefix = process.argv[5] ?? `ahead-${style}-${theme}`;
fs.mkdirSync(out, { recursive: true });

const base: Ambient = {
    state: 'working',
    date: 'Friday 20 November',
    headline: '',
    lines: [],
    mode: 'normal',
    updatedAt: '2026-11-20T09:00:00.000Z',
    items: [
        { kind: 'review', title: 'Monotonic stack', meta: '', done: true },
        { kind: 'review', title: 'DP: 0/1 knapsack', meta: '8 min', done: false },
        { kind: 'review', title: 'Tries', meta: '6 min', done: false },
        { kind: 'focus', title: 'Two sliding-window mediums', meta: '', done: false },
        { kind: 'task', title: 'Call the bank', meta: '7 pm', done: false },
    ] as unknown as NonNullable<Ambient['items']>,
    counts: { reviews: { done: 1, total: 3 }, focus: { done: 0, total: 1 }, tasks: { done: 0, total: 1 }, minutesLeft: 14 } as unknown as NonNullable<Ambient['counts']>,
    goal: null,
};
const line = { dayId: 'd', slot: 'evening', text: '3Sum: you had the two-pointer idea, only the duplicates left. 20 minutes tonight?' };
const today = [
    { id: 'rm_1', at: '7 pm', text: 'Call the bank' },
    { id: 'th_1', at: '9 pm', text: 'Contest on Codeforces' },
    { id: 'tk_1', at: '', text: 'Send the invoice' },
];
const pickUp = { id: 'pu_1', at: '', text: '3Sum', detail: 'has the two-pointer idea; duplicates still break it' };
const comingUp = [
    { id: 'tk_2', at: 'Sun', text: 'Get a gift for my sister' },
    { id: 'tk_3', at: 'Mon 9 am', text: 'Book the dentist' },
    { id: 'th_2', at: 'Thu 3 pm', text: 'Interview at Acme' },
];
const insight = 'Your evenings have been your best study hours this week: 9 pm suits 3Sum.';

const W = 1080;
const H = 2340;
const shots: Array<{ label: string; a: Ambient; screen: 'lock' | 'home' }> = [
    { label: 'Lock · line + 2 rows', a: { ...base, line, today: today.slice(0, 2) }, screen: 'lock' },
    { label: 'Lock · line + 3 rows', a: { ...base, line, today }, screen: 'lock' },
    { label: 'Lock · the dial + 3 rows', a: { ...base, today }, screen: 'lock' },
    { label: 'Lock · goal switch on', a: { ...base, line, today: today.slice(0, 2), goal: { title: 'A backend role', daysLeft: 178, done: 1, total: 6 } as unknown as NonNullable<Ambient['goal']> }, screen: 'lock' },
    { label: 'Home · Pick up, Coming up, thought', a: { ...base, pickUp, comingUp, insight }, screen: 'home' },
    { label: 'Home · Coming up only', a: { ...base, comingUp: comingUp.slice(0, 2) }, screen: 'home' },
    { label: 'Home · nothing ahead', a: base, screen: 'home' },
];

const SHOWN_H = 720;
const GAP = 36;
const LABEL = 48;
let x = GAP;
const parts: string[] = [];
for (const s of shots) {
    const zoom = SHOWN_H / H;
    const shownW = Math.round(W * zoom);
    const png = svgToPng(wallpaperSvg(s.a, W, H, theme, s.screen, { style, ...(s.screen === 'home' ? { zoom: 1.1 } : { iconSlot: true }) }), W, H, zoom, Math.max(W, H), WALLPAPER_FONTS).png;
    parts.push(
        `<image x="${x}" y="${GAP}" width="${shownW}" height="${SHOWN_H}" href="data:image/png;base64,${png.toString('base64')}"/>`,
        `<text x="${x + shownW / 2}" y="${GAP + SHOWN_H + 32}" text-anchor="middle" font-family="Inter" font-size="18" font-weight="600" fill="#2C2C2B">${s.label}</text>`,
    );
    x += shownW + GAP;
}
const width = x;
const height = GAP + SHOWN_H + LABEL + GAP;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#F4F3F2"/>${parts.join('')}</svg>`;
const file = path.join(out, `${prefix}.png`);
fs.writeFileSync(file, svgToPng(svg, width, height, 1, Math.max(width, height), WALLPAPER_FONTS).png);
console.log(`${file} (${width}×${height})`);
