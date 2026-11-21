// The owner's layout choice (11-21): rows from day-in-life-sheet.ts (one per option) stacked under big labels, so the
// options sit one above the other. No database:
//   npx ts-node --transpile-only scripts/layout-options-sheet.ts <out.png> "<label>=<row.png>" ...
import fs from 'node:fs';
import { WALLPAPER_FONTS } from '../src/services/ambient/ambient.service';
import { svgToPng } from '../src/services/docs/diagram/png';

const [out, ...rows] = process.argv.slice(2);
if (!out || !rows.length) throw new Error('usage: layout-options-sheet.ts <out.png> "<label>=<row.png>" ...');
const W = 1660;
const ROW = 1052;
const BAND = 64;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const parts: string[] = [];
rows.forEach((r, i) => {
    const at = r.indexOf('=');
    const label = r.slice(0, at);
    const file = r.slice(at + 1);
    const y = i * (ROW + BAND);
    parts.push(
        `<rect x="0" y="${y}" width="${W}" height="${BAND}" fill="#1C1B1A"/>`,
        `<text x="44" y="${y + 42}" font-family="Inter" font-size="28" font-weight="700" fill="#FFFFFF">${esc(label)}</text>`,
        `<image x="0" y="${y + BAND}" width="${W}" height="${ROW}" href="data:image/png;base64,${fs.readFileSync(file).toString('base64')}"/>`,
    );
});
const H = rows.length * (ROW + BAND);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#F4F3F2"/>${parts.join('')}</svg>`;
fs.writeFileSync(out, svgToPng(svg, W, H, 1, Math.max(W, H), WALLPAPER_FONTS).png);
console.log(`${out} (${W}×${H})`);
