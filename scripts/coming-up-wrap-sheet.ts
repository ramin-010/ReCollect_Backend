// The home picture's Coming up with long to-dos (the owner, 11-25: they must wrap, not end in "…"), in the three
// layouts. No database, no server:  npx ts-node --transpile-only scripts/coming-up-wrap-sheet.ts <out file.png>
import fs from 'node:fs';
import { WALLPAPER_FONTS, wallpaperSvg, type Ambient } from '../src/services/ambient/ambient.service';
import { svgToPng } from '../src/services/docs/diagram/png';

const out = process.argv[2];
if (!out) throw new Error('usage: npx ts-node --transpile-only scripts/coming-up-wrap-sheet.ts <out file.png>');
const a = {
    state: 'working', date: 'Wednesday 25 November', headline: '', lines: [], mode: 'normal', updatedAt: '2026-11-25T09:00:00.000Z',
    items: [], counts: { reviews: { done: 0, total: 0 }, focus: { done: 0, total: 0 }, tasks: { done: 0, total: 0 }, minutesLeft: 0 }, goal: null,
    pickUp: { id: 'pu_1', at: '', text: 'Lookups: XLOOKUP & INDEX-MATCH', detail: 'rebuilt one lookup; INDEX-MATCH still left' },
    comingUp: [
        { id: 't1', at: 'Fri', text: 'Choose 1 work report you make every week. Later you will make it automatic.' },
        { id: 't2', at: 'Sun', text: 'Check your notice period (how many days you must work after you resign). It is in your job letter.' },
        { id: 't3', at: 'Sat 5 Dec', text: 'Make free Kaggle and GitHub accounts' },
    ],
    insight: 'Evenings have been your best study time this week.',
} as unknown as Ambient;
const W = 1080, H = 2340, SHOWN_H = 900, GAP = 36;
let x = GAP;
const parts: string[] = [];
for (const layout of ['classic', 'glass', 'stack'] as const) {
    const zoom = SHOWN_H / H;
    const shownW = Math.round(W * zoom);
    const png = svgToPng(wallpaperSvg(a, W, H, 'dark', 'home', { style: 'sky', zoom: 1.1, ...(layout === 'classic' ? {} : { layout }) }), W, H, zoom, Math.max(W, H), WALLPAPER_FONTS).png;
    parts.push(`<image x="${x}" y="${GAP}" width="${shownW}" height="${SHOWN_H}" href="data:image/png;base64,${png.toString('base64')}"/>`,
        `<text x="${x + shownW / 2}" y="${GAP + SHOWN_H + 32}" text-anchor="middle" font-family="Inter" font-size="18" font-weight="600" fill="#2C2C2B">${layout}</text>`);
    x += shownW + GAP;
}
const width = x, height = GAP + SHOWN_H + 48 + GAP;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#F4F3F2"/>${parts.join('')}</svg>`;
fs.writeFileSync(out, svgToPng(svg, width, height, 1, Math.max(width, height), WALLPAPER_FONTS).png);
console.log(out);
