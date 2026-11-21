// A day in the owner's life on the phone (after stages 16-19): the lock and home pictures at four moments of an ordinary
// weekday, drawn by the server's own code (wallpaperSvg) from an invented day, with the home-screen widget's card drawn to
// its spec (mockups/phone-app/widget.html) and the phone's own clock and dock as light placeholders. No database:
//   npx ts-node --transpile-only scripts/day-in-life-sheet.ts <out.png> [style] [theme] [both|lock|home] [scale]
// (one row of four, lock or home, reads better on a short screen; scale 2 draws it sharp for zooming in)
import fs from 'node:fs';
import { WALLPAPER_FONTS, wallpaperSvg, type Ambient } from '../src/services/ambient/ambient.service';
import { svgToPng } from '../src/services/docs/diagram/png';

const out = process.argv[2];
if (!out) throw new Error('usage: npx ts-node --transpile-only scripts/day-in-life-sheet.ts <out.png> [style] [theme] [both|lock|home] [scale]');
const style = process.argv[3] ?? 'glow';
const theme = (process.argv[4] ?? 'dark') as 'light' | 'dark';
const rows = (process.argv[5] ?? 'both') as 'both' | 'lock' | 'home';
const S = Math.min(3, Math.max(1, Number(process.argv[6] ?? 1) || 1));
type Item = { kind: string; title: string; meta: string; done: boolean };
const items = (done: string[]): Item[] =>
    [
        { kind: 'review', title: 'Monotonic stack', meta: '', done: false },
        { kind: 'review', title: 'Tries', meta: '', done: false },
        { kind: 'review', title: 'DP: 0/1 knapsack', meta: '', done: false },
        { kind: 'focus', title: 'Two sliding-window mediums', meta: '', done: false },
        { kind: 'task', title: 'Send the invoice', meta: '', done: false },
        { kind: 'task', title: 'Renew the bike insurance', meta: 'late', done: false },
    ].map((i) => ({ ...i, done: done.includes(i.title) }));
const counts = (it: Item[]) => {
    const c = (k: string) => ({ done: it.filter((i) => i.kind === k && i.done).length, total: it.filter((i) => i.kind === k).length });
    return { reviews: c('review'), focus: c('focus'), tasks: c('task'), minutesLeft: 0 };
};
const day = (state: Ambient['state'], done: string[]): Ambient =>
    ({ state, date: 'Monday 23 November', headline: '', lines: [], mode: 'normal', updatedAt: '2026-11-23T02:00:00.000Z', items: items(done), counts: counts(items(done)), goal: null }) as unknown as Ambient;

const PICK = { id: 'pu_1', at: '', text: '3Sum', detail: 'has the two-pointer idea; duplicates still break it' };
const BOOKS = { id: 'tk_l', at: 'Wed', text: 'Return the library books' };
const INTERVIEW = { id: 'th_i', at: 'Thu 3 pm', text: 'Interview at Acme' };
const GIFT = { id: 'tk_g', at: 'Sun', text: 'Get a gift for my sister' };
const THOUGHT = 'Your evenings have been your best study hours this week: after dinner suits the hard ones.';
// Today's rows (the lock's schedule): a time, "Today" for a task with no time (at ''), "Late" for yesterday's (at 'late').
const BILL = { id: 'rm_e', at: '1 pm', text: 'Pay the electricity bill' };
const BANK = { id: 'rm_b', at: '7 pm', text: 'Call the bank' };
const ROUND = { id: 'th_c', at: '9 pm', text: 'Codeforces round' };
const INVOICE = { id: 'tk_i', at: '', text: 'Send the invoice' };
const INSURANCE = { id: 'tk_b', at: 'late', text: 'Renew the bike insurance' };

interface Card {
    label: string;
    title: string;
    detail: string;
    when: string | null;
}
interface Moment {
    clock: string;
    title: string;
    story: string;
    lock: Ambient;
    home: Ambient;
    card: Card;
}
const line = (text: string) => ({ dayId: 'd', slot: 'x', text });
// The owner's words (11-21): the lock in three groups (the ring with its counts, Buddy's line, what is scheduled next);
// Buddy's judgement during work hours; a Later back at the time shown, once across both screens; "Done for today" at night.
// The lines are ones the real models wrote in the journeys (J17b: the Later back as Buddy's line, 3 runs of 3).
const moments: Moment[] = [
    {
        clock: '7:40',
        title: '7:40 · waking up',
        story: 'The day under its ring, Buddy\'s line, then what is scheduled. On the widget: Later on the library books.',
        lock: { ...day('morning', []), line: line('Two short reviews before work? About ten minutes.'), today: [BILL, BANK, INVOICE] } as Ambient,
        // The widget holds the books, so the home picture leaves them out.
        home: { ...day('morning', []), pickUp: PICK, comingUp: [INTERVIEW, GIFT], insight: THOUGHT } as Ambient,
        card: { label: 'Coming up · Wed', title: 'Return the library books', detail: '', when: 'Tonight · 7:30 pm' },
    },
    {
        clock: '13:10',
        title: '13:10 · at work',
        story: 'Buddy speaks at work when it helps. "Today" has no time, "Late" was due yesterday. The books stay off until 7:30.',
        lock: { ...day('working', ['Monotonic stack', 'DP: 0/1 knapsack']), line: line('Tries is the one review left. Eight minutes on the ride home clears it.'), today: [BANK, INVOICE, INSURANCE] } as Ambient,
        home: { ...day('working', ['Monotonic stack', 'DP: 0/1 knapsack']), comingUp: [INTERVIEW, GIFT], insight: THOUGHT } as Ambient,
        card: { label: 'Pick up', title: '3Sum', detail: 'has the two-pointer idea; duplicates still break it', when: 'Tonight · 7:30 pm' },
    },
    {
        clock: '19:45',
        title: '19:45 · evening',
        story: 'The books come back at 7:30 as Buddy\'s line, once: not also a row, not in Coming up, not on the widget.',
        lock: { ...day('evening', ['Monotonic stack', 'Tries', 'DP: 0/1 knapsack', 'Send the invoice']), line: line("Library books: tonight's the time you picked. Still doable?"), today: [ROUND, INSURANCE] } as Ambient,
        home: { ...day('evening', ['Monotonic stack', 'Tries', 'DP: 0/1 knapsack', 'Send the invoice']), comingUp: [INTERVIEW, GIFT], insight: THOUGHT } as Ambient,
        card: { label: 'Pick up', title: '3Sum', detail: 'has the two-pointer idea; duplicates still break it', when: 'Tomorrow · 7:30 pm' },
    },
    {
        clock: '23:20',
        title: '23:20 · day done',
        story: 'Everything ticked: "Done for today" in the ring, no words at night. Home shows what is ahead.',
        lock: { ...day('done', ['Monotonic stack', 'Tries', 'DP: 0/1 knapsack', 'Two sliding-window mediums', 'Send the invoice', 'Renew the bike insurance']), line: null } as Ambient,
        home: { ...day('done', ['Monotonic stack', 'Tries', 'DP: 0/1 knapsack', 'Two sliding-window mediums', 'Send the invoice', 'Renew the bike insurance']), comingUp: [INTERVIEW, GIFT], insight: THOUGHT } as Ambient,
        card: { label: 'Coming up · Wed', title: 'Return the library books', detail: '', when: 'Tomorrow · 9 am' },
    },
];

const W = 1080;
const H = 2340;
const SHOWN_H = 780;
const z = SHOWN_H / H;
const SW = Math.round(W * z); // 360: one shown px is one dp
const GAP = 44;
const HEAD = 118;
const CAPTION = 40;
const R = 34;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const png = (a: Ambient, screen: 'lock' | 'home') =>
    svgToPng(wallpaperSvg(a, W, H, theme, screen, { style, ...(screen === 'home' ? { zoom: 1.1 } : { iconSlot: true }) }), W, H, z * S, Math.max(W, H), WALLPAPER_FONTS).png.toString('base64');

/** The widget's card, 4 x 2 (328 x 150 dp), Paper in the sheet's theme (android/res/values/colors.xml, wp_light_* / wp_dark_*). */
const PAPER = theme === 'light'
    ? { ground: '#F5F0E6', ring: '#E3DACA', ink1: '#23201B', ink2: '#564F44', ink3: '#6B6255', line: '#CEC2AB' }
    : { ground: '#24211C', ring: '#312C25', ink1: '#F0EADF', ink2: '#BDB4A4', ink3: '#9C9282', line: '#4A4338' };
function widget(x: number, y: number, c: Card): string {
    const w = 328;
    const h = 150;
    const p = 16;
    const k = PAPER;
    const parts: string[] = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="${k.ground}" stroke="${k.ring}"/>`];
    let yy = y + 30;
    parts.push(`<text x="${x + p}" y="${yy}" font-family="Inter" font-size="13" fill="${k.ink3}">${esc(c.label)}</text>`);
    yy += 25;
    parts.push(`<text x="${x + p}" y="${yy}" font-family="Inter" font-size="17" font-weight="500" fill="${k.ink1}">${esc(c.title)}</text>`);
    if (c.detail) {
        yy += 22;
        parts.push(`<text x="${x + p}" y="${yy}" font-family="Inter" font-size="14" fill="${k.ink2}">${esc(c.detail.length > 38 ? `${c.detail.slice(0, 37)}…` : c.detail)}</text>`);
    }
    if (c.when) {
        const py = y + h - p - 36;
        parts.push(
            `<rect x="${x + p}" y="${py}" width="82" height="36" rx="18" fill="none" stroke="${k.line}" stroke-width="1.5"/>`,
            `<circle cx="${x + p + 19}" cy="${py + 18}" r="6.5" fill="none" stroke="${k.ink1}" stroke-width="1.3"/>`,
            `<path d="M${x + p + 19} ${py + 14} v4 l2.6 1.4" fill="none" stroke="${k.ink1}" stroke-width="1.3" stroke-linecap="round"/>`,
            `<text x="${x + p + 33}" y="${py + 23}" font-family="Inter" font-size="14" font-weight="500" fill="${k.ink1}">Later</text>`,
            `<text x="${x + p + 94}" y="${py + 23}" font-family="Inter" font-size="13" fill="${k.ink2}">${esc(c.when)}</text>`,
        );
    }
    return parts.join('');
}

// The phone draws its own clock in a colour that suits the picture: dark on a light one.
const PHONE_INK = theme === 'light' ? '#1C1B1A' : '#FFFFFF';
const parts: string[] = [];
moments.forEach((m, i) => {
    const x = GAP + i * (SW + GAP);
    parts.push(`<text x="${x}" y="${GAP + 26}" font-family="Inter" font-size="20" font-weight="700" fill="#2C2C2B">${esc(m.title)}</text>`);
    // The story, wrapped by hand into short lines.
    const words = m.story.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
        if ((cur + ' ' + w).trim().length > 46) {
            lines.push(cur.trim());
            cur = w;
        } else cur += ` ${w}`;
    }
    if (cur.trim()) lines.push(cur.trim());
    lines.slice(0, 3).forEach((l, k) => parts.push(`<text x="${x}" y="${GAP + 52 + k * 20}" font-family="Inter" font-size="14" fill="#5F5E59">${esc(l)}</text>`));

    // The lock screen: the picture, the phone's own clock and date, the fingerprint's place.
    const ly = GAP + HEAD;
    if (rows !== 'home') parts.push(
        `<clipPath id="l${i}"><rect x="${x}" y="${ly}" width="${SW}" height="${SHOWN_H}" rx="${R}"/></clipPath>`,
        `<g clip-path="url(#l${i})"><image x="${x}" y="${ly}" width="${SW}" height="${SHOWN_H}" href="data:image/png;base64,${png(m.lock, 'lock')}"/>`,
        `<text x="${x + SW / 2}" y="${ly + 108}" text-anchor="middle" font-family="Inter" font-size="62" font-weight="300" fill="${PHONE_INK}" fill-opacity="0.92">${m.clock}</text>`,
        `<text x="${x + SW / 2}" y="${ly + 136}" text-anchor="middle" font-family="Inter" font-size="14" fill="${PHONE_INK}" fill-opacity="0.75">Mon, 23 Nov</text>`,
        `<circle cx="${x + SW / 2}" cy="${ly + SHOWN_H * 0.885}" r="18" fill="none" stroke="${PHONE_INK}" stroke-opacity="0.22" stroke-width="1.5"/></g>`,
        `<rect x="${x}" y="${ly}" width="${SW}" height="${SHOWN_H}" rx="${R}" fill="none" stroke="#1C1B1A" stroke-width="3"/>`,
        `<text x="${x + SW / 2}" y="${ly + SHOWN_H + 28}" text-anchor="middle" font-family="Inter" font-size="15" font-weight="600" fill="#2C2C2B">Lock screen</text>`,
    );
    // The home screen: the picture as the phone shows it (zoomed 1.1), the widget at the top, the dock.
    const hy = rows === 'home' ? ly : ly + SHOWN_H + CAPTION + GAP;
    const zw = SW * 1.1;
    const zh = SHOWN_H * 1.1;
    if (rows !== 'lock') parts.push(
        `<clipPath id="h${i}"><rect x="${x}" y="${hy}" width="${SW}" height="${SHOWN_H}" rx="${R}"/></clipPath>`,
        `<g clip-path="url(#h${i})"><image x="${x - (zw - SW) / 2}" y="${hy - (zh - SHOWN_H) / 2}" width="${zw}" height="${zh}" href="data:image/png;base64,${png(m.home, 'home')}"/>`,
        `<text x="${x + 22}" y="${hy + 24}" font-family="Inter" font-size="13" font-weight="600" fill="${PHONE_INK}" fill-opacity="0.85">${m.clock}</text>`,
        widget(x + 16, hy + 46, m.card),
        ...[0, 1, 2, 3].map((k) => `<rect x="${x + 38 + k * 76}" y="${hy + SHOWN_H - 92}" width="52" height="52" rx="16" fill="#FFFFFF" fill-opacity="0.16"/>`),
        `</g>`,
        `<rect x="${x}" y="${hy}" width="${SW}" height="${SHOWN_H}" rx="${R}" fill="none" stroke="#1C1B1A" stroke-width="3"/>`,
        `<text x="${x + SW / 2}" y="${hy + SHOWN_H + 28}" text-anchor="middle" font-family="Inter" font-size="15" font-weight="600" fill="#2C2C2B">Home screen (with the widget)</text>`,
    );
});
const width = GAP + moments.length * (SW + GAP);
const height = GAP + HEAD + (rows === 'both' ? 2 : 1) * (SHOWN_H + CAPTION) + (rows === 'both' ? GAP : 0) + 70;
parts.push(
    `<text x="${GAP}" y="${height - 46}" font-family="Inter" font-size="14" fill="#5F5E59">An invented Monday, drawn by the server's own code (${style}, ${theme}). The clock, date, fingerprint ring and the four app squares are placeholders for what the phone draws itself;</text>`,
    `<text x="${GAP}" y="${height - 26}" font-family="Inter" font-size="14" fill="#5F5E59">the widget is drawn to its spec (the phone uses its own font). It assumes the top of the home screen is free for the widget.</text>`,
);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#F4F3F2"/>${parts.join('')}</svg>`;
fs.writeFileSync(out, svgToPng(svg, width, height, S, Math.max(width, height) * S, WALLPAPER_FONTS).png);
console.log(`${out} (${width * S}×${height * S})`);
