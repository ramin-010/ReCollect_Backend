// The phone's pictures (ANDROID_APP_SPEC; BUDDY_MEMORY_PLAN §3.4 and §11.1). The backdrop is the sky
// of the day (its light follows the day's state: dawn, daylight, dusk, a starry night, a soft mist on a
// light day) or one of the dark styles (wallpaperStyles.ts). Over it, one type system for every picture
// (B8, the owner, 11-16: "how you use the font, spacing, weights… make it better"): three sizes of words
// and the numerals, gaps in units of 1 % of the width, Inter throughout. The home picture is drawn for
// the zoom the phone shows it at. Every day draws a slightly different backdrop (the date seeds it).
// Pure: SVG text in, out.
import { styleLook, type RingLook } from './wallpaperStyles';
import { INTER_ADVANCES, INTER_CHARS, INTER_UPM } from './interMetrics';

export type SkyState = 'morning' | 'working' | 'evening' | 'done' | 'rest';
export type Theme = 'light' | 'dark';

export interface WallpaperInput {
    state: SkyState;
    /** "Sunday 15 November" */
    date: string;
    headline: string;
    lines: string[];
    /** The last seven days, oldest first (today last): studied or not. */
    week?: Array<{ day: string; active: boolean }>;
    /** Today's things (open first): the rings are made of them; the home picture counts them. */
    items?: Array<{ kind: 'review' | 'focus' | 'task'; title: string; meta: string; done: boolean }>;
    counts?: { reviews: { done: number; total: number }; focus: { done: number; total: number }; tasks: { done: number; total: number }; minutesLeft: number };
    goal?: { title: string; daysLeft: number; done: number; total: number } | null;
    /**
     * The buddy's line for now (BUDDY_MEMORY_PLAN §3.4): the lock picture's main words. Only a line
     * the lock check passed; without one the lock picture is the dial of the day.
     */
    line?: string | null;
    /** The lock picture's day mark: the ring of the day over the line (default; the owner, 11-16), or none. */
    dayMark?: 'ring' | 'none';
    /** The picture's style (wallpaperStyles.ts; "sky" or none: the sky of the day) and its colour. */
    style?: string;
    color?: string;
    /**
     * How much larger the phone shows this picture at rest (B8; 1–1.25, default 1). Android 11 shows
     * the home wallpaper at 1.1× (measured on his phone) and zooms out only while the shade is pulled.
     */
    zoom?: number;
    /**
     * The live lock screen (app 0.4.0): a band is left under the words for the phone's own notification
     * icons, which the app draws there. Its place goes out on the picture (`data-icons`: centre y, icon
     * size, ink as #AARRGGBB).
     */
    iconSlot?: boolean;
    /** Today's reminders still to come (the home picture lists them under the day's number; none: nothing). */
    reminders?: Array<{ at: string; text: string }>;
    /** The buddy's thought for the home screen today (under the reminders; none: nothing). Never the lock screen's line. */
    insight?: string | null;
    /** Stage 16: the lock picture's rows (now): today's next scheduled things, three at most ("7 pm" · "Call the bank"). */
    today?: ReadonlyArray<{ at: string; text: string }>;
    /** Stage 16: the home picture's Pick up (ahead): what they left unfinished, and where they stopped. */
    pickUp?: { text: string; detail?: string } | null;
    /** Stage 16: the home picture's Coming up (ahead): the next days' to-dos and events ("Sun" · "Sister's birthday"). */
    comingUp?: ReadonlyArray<{ at: string; text: string }>;
    /**
     * The picture's layout (the owner, 11-22: each screen's is his choice in the app): 'glass' (one frosted panel), 'stack'
     * (a frosted card each); none: the classic one (the words on the backdrop).
     */
    layout?: 'glass' | 'stack';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── The type system (B8, BUDDY_MEMORY_PLAN §11.1) ────────────────────────────────────────────

/** Inter's cap height in em (its figures are as tall): words are placed by their caps, not their boxes. */
const CAP = 0.727;

/**
 * Sizes as shares of the width: three levels of words and the numerals. Nothing is smaller than the
 * quiet size (about 11 sp on a 1080-wide phone). Gaps are units of 1 % of the width: 3, 5 or 8 of them.
 */
export const TYPE = {
    /** Labels, the goal, the week's letters. */
    quiet: 0.031,
    /** The numbers in words. */
    secondary: 0.039,
    /** The day's counts under its ring on the lock picture (11-21: quieter than the schedule, close to the ring). */
    counts: 0.034,
    /** The buddy's line: as large as fits three balanced lines, between these (smaller and wider, the owner, 11-21). */
    lineMax: 0.052,
    lineMin: 0.046,
    /** Only when the line won't fit three lines at lineMin (it is never cut). */
    lineFloor: 0.04,
    /** The numerals: inside the lock picture's ring, inside the dial, on the home picture. */
    ringNumeral: 0.105,
    dialNumeral: 0.15,
    homeNumeral: 0.165,
} as const;

/** Tracking in em: tight on numerals and the line, open on capitals (one-word labels and the date only). */
const TRACK = { numeral: -0.035, line: -0.015, caps: 0.1 } as const;

/** The zoom a picture may be drawn for (1–1.25; anything else is 1). */
export function pictureZoom(z: unknown): number {
    const n = Number(z);
    return Number.isFinite(n) && n > 1 ? Math.min(1.25, Math.round(n * 1000) / 1000) : 1;
}

/**
 * The words and marks, drawn for the phone's zoom: smaller about the centre by as much as the phone
 * enlarges the picture, so they land where and as large as designed. The backdrop is not scaled (it
 * stays whole while the shade moves the zoom).
 */
function forZoom(words: string[], W: number, H: number, zoom: number | undefined): string {
    const z = pictureZoom(zoom);
    if (z === 1) return words.join('');
    const s = 1 / z;
    return `<g transform="matrix(${s.toFixed(5)} 0 0 ${s.toFixed(5)} ${r1((W / 2) * (1 - s))} ${r1((H / 2) * (1 - s))})">${words.join('')}</g>`;
}

function picture(W: number, H: number, defs: string[], art: string[], words: string[], zoom?: number, slot?: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"${slot ? ` data-icons="${slot}"` : ''}><defs>${defs.join('')}</defs>${art.join('')}${forZoom(words, W, H, zoom)}</svg>`;
}

/** An ink ("#RRGGBB" or "rgba(r,g,b,a)") as Android's #AARRGGBB. */
export function argbHex(color: string): string {
    const hex = /^#([0-9a-f]{6})$/i.exec(color);
    if (hex) return `#FF${hex[1]!.toUpperCase()}`;
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/i.exec(color.replace(/\s+/g, ''));
    if (!m) return '#FFFFFFFF';
    const a = Math.round(Math.min(1, Math.max(0, m[4] === undefined ? 1 : Number(m[4]))) * 255);
    return `#${[a, Number(m[1]), Number(m[2]), Number(m[3])].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** The band for the phone's notification icons (the live lock screen): its height in the group, and its place. */
const ICON_SIZE = 0.05;
function iconBand(W: number): number {
    return 5 * (W / 100) + W * ICON_SIZE;
}
function iconSlotAt(bandTop: number, W: number, ink: string): string {
    const size = W * ICON_SIZE;
    return `${r1(bandTop + 5 * (W / 100) + size / 2)},${r1(size)},${argbHex(ink)}`;
}

interface TextOpts {
    anchor?: 'middle' | 'end';
    /** Tracking in em. */
    track?: number;
}

/** One line of Inter, its baseline at y. */
function text(x: number, y: number, s: string, size: number, weight: number, fill: string, o: TextOpts = {}): string {
    const ls = o.track ? ` letter-spacing="${r1(o.track * size)}"` : '';
    return `<text x="${r1(x)}" y="${r1(y)}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''} font-family="Inter" font-size="${r1(size)}" font-weight="${weight}"${ls} fill="${fill}">${esc(s)}</text>`;
}

/** `s` cut to fit `width` at `size`, with "…" when it had to be cut (a picture can't scroll). */
function fit(s: string, size: number, weight: Weight, width: number, letterSpacing = 0): string {
    if (textWidth(s, size, weight, letterSpacing) <= width) return s;
    const chars = [...s];
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (textWidth(`${chars.slice(0, mid).join('').trimEnd()}…`, size, weight, letterSpacing) <= width) lo = mid;
        else hi = mid - 1;
    }
    return `${chars.slice(0, lo).join('').trimEnd()}…`;
}

/** A tick drawn in the box (x, top, w, h), its stroke inside the box. */
function tick(x: number, top: number, w: number, h: number, sw: number, color: string): string {
    const i = sw / 2;
    const X = (f: number) => r1(x + i + f * (w - sw));
    const Y = (f: number) => r1(top + i + f * (h - sw));
    return `<path d="M${X(0)} ${Y(0.56)} L${X(0.36)} ${Y(0.94)} L${X(1)} ${Y(0.06)}" fill="none" stroke="${color}" stroke-width="${r1(sw)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** What is left, by kind, in words: "7 reviews · 2 tasks" (a kind with nothing left drops out); '' when nothing is. */
export function kindWords(c: WallpaperInput['counts']): string {
    if (!c) return '';
    const left = (n: { done: number; total: number }) => Math.max(0, n.total - n.done);
    return [left(c.reviews) ? plural(left(c.reviews), 'review') : '', left(c.focus) ? plural(left(c.focus), 'focus line') : '', left(c.tasks) ? plural(left(c.tasks), 'task') : '']
        .filter(Boolean)
        .join(' · ');
}

/** The day in one row of words: "7 reviews · 2 tasks", "Done for today", or '' on a free day (stage 16: no estimated time, the owner's word). */
function dayRow(input: WallpaperInput): string {
    const items = input.items ?? [];
    if (!items.length) return '';
    const open = items.filter((i) => !i.done).length;
    if (!open) return 'Done for today';
    return kindWords(input.counts) || `${open} left`;
}

/** The goal's row: "181 days to <goal>". */
function goalRow(g: WallpaperInput['goal']): string {
    if (!g) return '';
    return g.daysLeft >= 0 ? `${plural(g.daysLeft, 'day')} to ${g.title}` : `${g.title}: past its date`;
}

interface Glow {
    x: number;
    y: number;
    r: number;
    color: string;
    alpha: number;
}

interface Sky {
    /** Top to bottom. */
    sky: [string, string, string];
    glows: Glow[];
    /** The light source: a sun or a moon (x, y in fractions; r of the width). */
    light?: { x: number; y: number; r: number; color: string; halo: string; moon?: boolean };
    /** Three hills, far to near. */
    hills: [string, string, string];
    stars?: boolean;
    ink: { head: string; body: string; meta: string; tag: string; tagInk: string; tagRing: string; dotOn: string; dotOff: string };
    grain: number;
}

// 11-22: brighter body and meta (his phone dims the wallpaper on both screens; the words read washed out).
const DARK_INK = { head: '#FFFFFF', body: 'rgba(250,249,247,0.90)', meta: 'rgba(250,249,247,0.74)', tag: 'rgba(255,255,255,0.12)', tagInk: '#F7F5F2', tagRing: 'rgba(255,255,255,0.22)', dotOn: '#F7F5F2', dotOff: 'rgba(247,245,242,0.28)' };
const LIGHT_INK = { head: '#211F1D', body: 'rgba(33,31,29,0.80)', meta: 'rgba(33,31,29,0.66)', tag: 'rgba(255,255,255,0.58)', tagInk: '#211F1D', tagRing: 'rgba(33,31,29,0.10)', dotOn: '#211F1D', dotOff: 'rgba(33,31,29,0.20)' };

/** The palettes, by state and theme. Never red; never an alarm colour. */
const SKIES: Record<SkyState, Record<Theme, Sky>> = {
    morning: {
        dark: {
            sky: ['#16172C', '#33223F', '#6A3B4A'],
            glows: [
                { x: 0.78, y: 0.66, r: 0.95, color: '#F3A47C', alpha: 0.5 },
                { x: 0.12, y: 0.42, r: 0.8, color: '#C46A8E', alpha: 0.32 },
                { x: 0.5, y: 0.06, r: 0.9, color: '#6E66CF', alpha: 0.28 },
            ],
            light: { x: 0.74, y: 0.8, r: 0.1, color: '#FFD3A8', halo: '#F7A77E' },
            hills: ['#4A2A42', '#35213A', '#221830'],
            ink: DARK_INK,
            grain: 0.1,
        },
        light: {
            sky: ['#F1E6F4', '#FBE6DC', '#FFF1E4'],
            glows: [
                { x: 0.8, y: 0.62, r: 0.95, color: '#FFB38A', alpha: 0.55 },
                { x: 0.12, y: 0.36, r: 0.8, color: '#F3A6C2', alpha: 0.42 },
                { x: 0.5, y: 0.04, r: 0.9, color: '#BDB5F4', alpha: 0.45 },
            ],
            light: { x: 0.74, y: 0.8, r: 0.1, color: '#FFD4AE', halo: '#FFB487' },
            hills: ['#EBC9C7', '#DDB2BC', '#C99AAE'],
            ink: LIGHT_INK,
            grain: 0.07,
        },
    },
    working: {
        dark: {
            sky: ['#0C2030', '#11384B', '#16465A'],
            glows: [
                { x: 0.82, y: 0.16, r: 0.95, color: '#45B9CC', alpha: 0.32 },
                { x: 0.18, y: 0.5, r: 0.85, color: '#3E6FD8', alpha: 0.3 },
                { x: 0.6, y: 0.82, r: 0.9, color: '#2E9C8F', alpha: 0.26 },
            ],
            light: { x: 0.8, y: 0.14, r: 0.075, color: '#FFE3A1', halo: '#F2C46A' },
            hills: ['#1B4A5C', '#163D4E', '#102F3E'],
            ink: DARK_INK,
            grain: 0.09,
        },
        light: {
            sky: ['#D4EAFB', '#E6F4FB', '#F4FAFC'],
            glows: [
                { x: 0.84, y: 0.14, r: 0.9, color: '#FFF0B8', alpha: 0.6 },
                { x: 0.15, y: 0.52, r: 0.85, color: '#9FDCEB', alpha: 0.45 },
                { x: 0.6, y: 0.84, r: 0.9, color: '#A8E3D2', alpha: 0.4 },
            ],
            light: { x: 0.8, y: 0.14, r: 0.075, color: '#FFFBEA', halo: '#FFE9A6' },
            hills: ['#BFDDE6', '#A5CEDA', '#8BBCCB'],
            ink: LIGHT_INK,
            grain: 0.06,
        },
    },
    evening: {
        dark: {
            sky: ['#121333', '#291C47', '#4B2143'],
            glows: [
                { x: 0.26, y: 0.84, r: 0.95, color: '#EE8A5E', alpha: 0.46 },
                { x: 0.86, y: 0.58, r: 0.8, color: '#AE4A88', alpha: 0.34 },
                { x: 0.56, y: 0.08, r: 0.9, color: '#4A4FC4', alpha: 0.3 },
            ],
            light: { x: 0.26, y: 0.82, r: 0.11, color: '#FFC08F', halo: '#F08A5E' },
            hills: ['#3B1E44', '#2A1739', '#1A112B'],
            ink: DARK_INK,
            grain: 0.1,
        },
        light: {
            sky: ['#E4DEF6', '#F5DFEA', '#FCE4D6'],
            glows: [
                { x: 0.24, y: 0.84, r: 0.95, color: '#F8A88C', alpha: 0.55 },
                { x: 0.86, y: 0.52, r: 0.8, color: '#D7A8E9', alpha: 0.45 },
                { x: 0.5, y: 0.04, r: 0.9, color: '#AAB5F1', alpha: 0.42 },
            ],
            light: { x: 0.26, y: 0.82, r: 0.11, color: '#FFD9BE', halo: '#F9AE8E' },
            hills: ['#E2B8C8', '#CFA0BC', '#B98AAE'],
            ink: LIGHT_INK,
            grain: 0.07,
        },
    },
    done: {
        dark: {
            sky: ['#05070D', '#0A111E', '#0F1B2B'],
            glows: [
                { x: 0.2, y: 0.32, r: 0.95, color: '#2BBFA3', alpha: 0.16 },
                { x: 0.86, y: 0.18, r: 0.8, color: '#6A5AD8', alpha: 0.16 },
                { x: 0.6, y: 0.86, r: 0.9, color: '#1E5A8A', alpha: 0.2 },
            ],
            light: { x: 0.78, y: 0.2, r: 0.05, color: '#F1EEDF', halo: '#8FA6D8', moon: true },
            hills: ['#111E2E', '#0D1724', '#09111B'],
            stars: true,
            ink: DARK_INK,
            grain: 0.08,
        },
        light: {
            sky: ['#E3E8F6', '#ECEFF8', '#F5F6FA'],
            glows: [
                { x: 0.78, y: 0.2, r: 0.75, color: '#C8D5F6', alpha: 0.65 },
                { x: 0.18, y: 0.66, r: 0.9, color: '#CDEBE2', alpha: 0.5 },
                { x: 0.5, y: 0.02, r: 0.9, color: '#D9D2F4', alpha: 0.45 },
            ],
            light: { x: 0.78, y: 0.2, r: 0.05, color: '#FFFFFF', halo: '#C8D5F6', moon: true },
            hills: ['#CBD3E6', '#B7C2DB', '#A3B0CE'],
            ink: LIGHT_INK,
            grain: 0.06,
        },
    },
    rest: {
        dark: {
            sky: ['#121817', '#1A2523', '#22302C'],
            glows: [
                { x: 0.72, y: 0.34, r: 0.9, color: '#7FB59A', alpha: 0.22 },
                { x: 0.18, y: 0.74, r: 0.9, color: '#8D9BB0', alpha: 0.2 },
                { x: 0.5, y: 0.04, r: 0.9, color: '#5F8C80', alpha: 0.18 },
            ],
            hills: ['#26362F', '#1E2C27', '#17221E'],
            ink: DARK_INK,
            grain: 0.09,
        },
        light: {
            sky: ['#EAF1ED', '#F1F5F2', '#F8FAF8'],
            glows: [
                { x: 0.72, y: 0.3, r: 0.9, color: '#BEDCCB', alpha: 0.55 },
                { x: 0.18, y: 0.76, r: 0.9, color: '#D3DAE6', alpha: 0.5 },
                { x: 0.5, y: 0.02, r: 0.9, color: '#D6E8DD', alpha: 0.45 },
            ],
            hills: ['#C9DCD2', '#B4CDBF', '#9FBDAD'],
            ink: LIGHT_INK,
            grain: 0.06,
        },
    },
};

/** A small, stable random generator: the same date draws the same sky. */
function seeded(text: string): () => number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    let s = h >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n: number) => Math.round(n * 10) / 10;

type Weight = 400 | 500 | 600;

/** The width of `text` in Inter at `size` px (real advances; an unknown character counts as 0.58 em). */
export function textWidth(text: string, size: number, weight: Weight, letterSpacing = 0): number {
    const adv = INTER_ADVANCES[weight];
    let units = 0;
    for (const ch of text) {
        const i = INTER_CHARS.indexOf(ch);
        units += i >= 0 ? (adv[i] ?? INTER_UPM * 0.58) : INTER_UPM * 0.58;
    }
    return (units / INTER_UPM) * size + letterSpacing * Math.max(0, [...text].length - 1);
}

function greedy(words: string[], fits: (line: string) => boolean): string[] {
    const out: string[] = [];
    let line = '';
    for (const word of words) {
        if (!line) line = word;
        else if (fits(`${line} ${word}`)) line += ` ${word}`;
        else {
            out.push(line);
            line = word;
        }
    }
    if (line) out.push(line);
    return out;
}

/**
 * Wraps `text` into lines no wider than `width`, balanced (like CSS text-wrap: balance: the same
 * number of lines, as even as they go, so no word is left alone on the last line). Lines past `max`
 * are dropped; the caller sizes text down first.
 */
export function wrapText(text: string, size: number, weight: Weight, width: number, max: number, letterSpacing = 0, balance = true): string[] {
    // A separator ("·", "–", "—") stays at the end of its line, never starts the next one; a number
    // stays with the word after it ("3 reviews", "24 min").
    const words: string[] = [];
    let glueNext = false;
    for (const w of text.split(/\s+/).filter(Boolean)) {
        if (/^[·–—]$/.test(w) && words.length) words[words.length - 1] += ` ${w}`;
        else if (glueNext && words.length) words[words.length - 1] += ` ${w}`;
        else words.push(w);
        glueNext = /^\d+$/.test(w);
    }
    const measure = (line: string) => textWidth(line, size, weight, letterSpacing);
    const lines = greedy(words, (l) => measure(l) <= width);
    if (lines.length > 1 && balance) {
        // The narrowest width that still gives the same number of lines.
        let lo = width * 0.4;
        let hi = width;
        for (let i = 0; i < 14; i++) {
            const mid = (lo + hi) / 2;
            if (greedy(words, (l) => measure(l) <= mid).length <= lines.length) hi = mid;
            else lo = mid;
        }
        return greedy(words, (l) => measure(l) <= hi).slice(0, max);
    }
    return lines.slice(0, max);
}

/** `hex` mixed toward black by `by` (0–1): the hills darken toward their foot. */
function shade(hex: string, by: number): string {
    const n = parseInt(hex.slice(1), 16);
    const f = (v: number) => Math.round(v * (1 - by)).toString(16).padStart(2, '0');
    return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

/** A hill: a smooth ridge across the width, from `base` (fraction of height), filled to the bottom. */
function hill(w: number, h: number, base: number, amp: number, rand: () => number, fill: string): string {
    const y0 = h * base;
    const pts = 5;
    const step = w / (pts - 1);
    const ys = Array.from({ length: pts }, () => y0 + (rand() - 0.5) * 2 * amp * h);
    let d = `M0 ${r1(ys[0] ?? y0)}`;
    for (let i = 1; i < pts; i++) {
        const x0 = (i - 1) * step;
        const x1 = i * step;
        const from = ys[i - 1] ?? y0;
        const to = ys[i] ?? y0;
        d += ` C${r1(x0 + step / 2)} ${r1(from)} ${r1(x1 - step / 2)} ${r1(to)} ${r1(x1)} ${r1(to)}`;
    }
    return `<path d="${d} L${w} ${h} L0 ${h} Z" fill="${fill}"/>`;
}

/**
 * The sky behind both pictures: the state's gradient and colour fields, stars on a done night, film
 * grain. The home picture adds the sun or moon and the hills (a landscape); the lock picture keeps
 * the open sky and lights its dial instead.
 */
function drawSky(state: SkyState, date: string, W: number, H: number, theme: Theme, landscape: boolean, salt = ''): { defs: string[]; art: string[]; rand: () => number } {
    const sky = SKIES[state][theme];
    const rand = seeded(`${date}|${state}${salt}`);
    const jitter = (v: number, by: number) => v + (rand() - 0.5) * 2 * by;
    const defs: string[] = [];
    const art: string[] = [];

    // The sky: a vertical gradient, then soft colour fields (each a radial gradient that fades out).
    defs.push(`<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky.sky[0]}"/><stop offset="0.55" stop-color="${sky.sky[1]}"/><stop offset="1" stop-color="${sky.sky[2]}"/></linearGradient>`);
    art.push(`<rect width="${W}" height="${H}" fill="url(#sky)"/>`);
    sky.glows.forEach((g, i) => {
        const id = `glow${i}`;
        defs.push(`<radialGradient id="${id}"><stop offset="0" stop-color="${g.color}" stop-opacity="${g.alpha}"/><stop offset="0.4" stop-color="${g.color}" stop-opacity="${r1(g.alpha * 0.55 * 100) / 100}"/><stop offset="0.75" stop-color="${g.color}" stop-opacity="${r1(g.alpha * 0.14 * 100) / 100}"/><stop offset="1" stop-color="${g.color}" stop-opacity="0"/></radialGradient>`);
        art.push(`<circle cx="${r1(jitter(g.x, 0.06) * W)}" cy="${r1(jitter(g.y, 0.03) * H)}" r="${r1(g.r * W)}" fill="url(#${id})"/>`);
    });

    // Stars on a done night: small, uneven, more of them high up, none over the horizon.
    if (sky.stars) {
        for (let i = 0; i < 70; i++) {
            const x = rand() * W;
            const y = Math.pow(rand(), 1.6) * H * (landscape ? 0.7 : 0.95);
            const big = rand() > 0.9;
            art.push(`<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1((big ? 2.6 : 1.3 + rand()) * (W / 1080))}" fill="#FFFFFF" opacity="${r1((0.25 + rand() * 0.6) * 100) / 100}"/>`);
        }
    }

    if (landscape) {
        // The sun or the moon, with its halo. The moon is a crescent: its disc with a circle masked out.
        if (sky.light) {
            const L = sky.light;
            const cx = jitter(L.x, 0.02) * W;
            const cy = L.y * H;
            const r = L.r * W;
            defs.push(`<radialGradient id="halo"><stop offset="0" stop-color="${L.halo}" stop-opacity="0.55"/><stop offset="0.35" stop-color="${L.halo}" stop-opacity="0.2"/><stop offset="1" stop-color="${L.halo}" stop-opacity="0"/></radialGradient>`);
            art.push(`<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r * 4.2)}" fill="url(#halo)"/>`);
            if (L.moon) {
                defs.push(`<mask id="crescent"><circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="#FFFFFF"/><circle cx="${r1(cx + r * 0.45)}" cy="${r1(cy - r * 0.2)}" r="${r1(r * 0.86)}" fill="#000000"/></mask>`);
                art.push(`<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="${L.color}" mask="url(#crescent)"/>`);
            } else {
                art.push(`<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="${L.color}"/>`);
            }
        }
        // The horizon: three hills, far to near, each a touch darker at its foot (depth, not outlines).
        const ridges: Array<[number, number]> = [[0.8, 0.02], [0.85, 0.018], [0.91, 0.014]];
        ridges.forEach(([base, amp], i) => {
            const color = sky.hills[i] ?? sky.hills[0];
            defs.push(`<linearGradient id="hill${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${shade(color, theme === 'dark' ? 0.35 : 0.12)}"/></linearGradient>`);
            art.push(hill(W, H, base, amp, rand, `url(#hill${i})`));
        });
    }
    return { defs, art, rand };
}

interface Look {
    defs: string[];
    art: string[];
    /** A style's own marks that belong with the words (Mono's frame, Dots' accent): drawn for the zoom with them. */
    overlay: string[];
    ink: Sky['ink'];
    rand: () => number;
    /** The soft light behind the words, or null. */
    glow: string | null;
    glowAlpha: number;
    ring: RingLook;
    lineWeight: number;
}

/** The picture's backdrop: the sky of the day (the default), or one of the styles (wallpaperStyles.ts). */
function lookOf(input: WallpaperInput, W: number, H: number, theme: Theme, screen: 'lock' | 'home'): Look {
    const style = styleLook(input.style, input.color, { W, H, theme, screen, date: input.date, state: input.state, items: (input.items ?? []).map((i) => ({ kind: i.kind, done: i.done })) });
    if (style) return { ...style, rand: seeded(`${input.date}|${input.state}|${input.style}`) };
    const sky = SKIES[input.state][theme];
    const { defs, art, rand } = drawSky(input.state, input.date, W, H, theme, screen === 'home', screen === 'lock' ? '|lock' : '');
    grain(defs, art, W, H, sky.grain, Math.floor(rand() * 1000));
    return { defs, art, overlay: [], ink: sky.ink, rand, glow: sky.light?.halo ?? sky.glows[0]?.color ?? '#FFFFFF', glowAlpha: theme === 'dark' ? 0.26 : 0.4, ring: { lit: sky.ink.head, dim: sky.ink.dotOff }, lineWeight: 500 };
}

/** Film grain over everything: fine, faint noise (it also hides gradient banding on AMOLED screens), one small tile repeated. */
function grain(defs: string[], art: string[], W: number, H: number, amount: number, seed: number): void {
    const tile = 240;
    defs.push(`<filter id="grain" x="0" y="0" width="${tile}" height="${tile}" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${seed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>`);
    defs.push(`<pattern id="grainTile" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse"><rect width="${tile}" height="${tile}" filter="url(#grain)"/></pattern>`);
    art.push(`<rect width="${W}" height="${H}" fill="url(#grainTile)" opacity="${amount}"/>`);
}

// ── The home picture ──────────────────────────────────────────────────────────────────────────


interface Block {
    /** From the first line's cap top to the last line's baseline. */
    h: number;
    draw: (top: number) => string[];
}

/** A message bubble (lucide's message-circle): the buddy's mark. Its box at (x, top), `size` square. */
function bubble(x: number, top: number, size: number, color: string): string {
    return `<g transform="translate(${r1(x)} ${r1(top)}) scale(${r1((size / 24) * 1000) / 1000})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></g>`;
}

/**
 * The buddy's thought for the home screen (the owner, 11-16: "reminders or a suggestion or an insight from
 * the buddy… helpful, meaningful and mindful"): its mark in the reminders' icon column and the words
 * wrapped after it (three balanced lines at most; the quiet size only if three won't hold them). The
 * block's height counts its gap above: a step after the reminders, the reminders' own gap after the day.
 */
function insightRows(insight: string, W: number, x: number, usable: number, ink: Sky['ink'], afterRows: boolean, first = false): Block {
    const text0 = insight.replace(/\s+/g, ' ').trim();
    if (!text0) return { h: 0, draw: () => [] };
    const u = W / 100;
    const icon = W * TYPE.secondary * 0.92;
    const tx = x + icon + 2.4 * u;
    const room = x + usable - tx;
    let size = W * TYPE.secondary;
    let lines = wrapText(text0, size, 400, room, 4);
    if (lines.length > 3) {
        size = W * TYPE.quiet;
        lines = wrapText(text0, size, 400, room, 4);
    }
    if (lines.length > 3) lines = [...lines.slice(0, 2), fit(lines.slice(2).join(' '), size, 400, room)];
    const lh = size * 1.42;
    const gap = first ? 0 : (afterRows ? 8 : 7) * u;
    return {
        h: gap + size * CAP + (lines.length - 1) * lh,
        draw: (top) => {
            const base = top + gap + size * CAP;
            return [bubble(x, base - size * CAP - (icon - size * CAP) / 2, icon, ink.body), ...lines.map((l, i) => text(tx, base + i * lh, l, size, 400, ink.head))];
        },
    };
}

/** A small label over a block of the home picture ("Pick up", "Coming up"): sentence case, as the widget (the owner, 11-21). */
function labelRow(label: string, W: number, x: number, ink: Sky['ink']): { h: number; draw: (top: number) => string[] } {
    const quiet = W * TYPE.quiet;
    return { h: quiet * CAP, draw: (top) => [text(x, top + quiet * CAP, label, quiet, 600, ink.meta)] };
}

/**
 * Stage 16, the home picture's Pick up: what they left unfinished this week (its title, larger) and where they stopped
 * (two lines at most, quieter). The block's height counts its gap above (none when it is the first).
 */
function pickUpRows(item: NonNullable<WallpaperInput['pickUp']>, W: number, x: number, usable: number, ink: Sky['ink'], first: boolean): Block {
    const u = W / 100;
    const label = labelRow('Pick up', W, x, ink);
    const big = W * 0.05;
    const second = W * TYPE.secondary;
    const title = wrapText(item.text, big, 600, usable, 2, big * TRACK.line);
    const detail = item.detail?.trim() ? wrapText(item.detail.trim(), second, 400, usable, 2) : [];
    const gap = first ? 0 : 8 * u;
    const titleLh = big * 1.2;
    const detailLh = second * 1.42;
    const titleTop = label.h + 3 * u;
    const titleH = big * CAP + (title.length - 1) * titleLh;
    const detailH = detail.length ? 3 * u + second * CAP + (detail.length - 1) * detailLh : 0;
    return {
        h: gap + titleTop + titleH + detailH,
        draw: (top) => {
            const t0 = top + gap;
            const out = label.draw(t0);
            title.forEach((l, i) => out.push(text(x, t0 + titleTop + big * CAP + i * titleLh, l, big, 600, ink.head, { track: TRACK.line })));
            const d0 = t0 + titleTop + titleH + 3 * u + second * CAP;
            detail.forEach((l, i) => out.push(text(x, d0 + i * detailLh, l, second, 400, ink.body)));
            return out;
        },
    };
}

/**
 * Stage 16, the home picture's Coming up: the next days' to-dos and events, three at most: the day (and time) in one
 * column, the words after it. The block's height counts its gap above (none when it is the first).
 */
function comingUpRows(list: ReadonlyArray<{ at: string; text: string }>, W: number, x: number, usable: number, ink: Sky['ink'], first: boolean, maxLines = 3): Block {
    const rows = list.slice(0, 3);
    if (!rows.length) return { h: 0, draw: () => [] };
    const u = W / 100;
    const label = labelRow('Coming up', W, x, ink);
    const size = W * TYPE.secondary;
    const step = size * 1.62;
    const atW = Math.max(...rows.map((r) => textWidth(r.at, size, 600)));
    const gap = first ? 0 : 8 * u;
    const rowsTop = label.h + 4 * u;
    const tx = x + atW + 2.6 * u;
    // A long to-do wraps under itself, as the lock's rows do (the owner, 11-25), up to three lines (fewer when the
    // picture's band is full); the rest ends in "…".
    const rowW = x + usable - tx;
    const lh = size * 1.32;
    const rowLines = rows.map((r) => {
        const all = wrapText(r.text, size, 400, rowW, 99, 0, false);
        return all.length <= maxLines ? all : [...all.slice(0, maxLines - 1), fit(all.slice(maxLines - 1).join(' '), size, 400, rowW)];
    });
    const extra = rowLines.reduce((n, ls) => n + (ls.length - 1) * lh, 0);
    return {
        h: gap + rowsTop + size * CAP + (rows.length - 1) * step + extra,
        draw: (top) => {
            const t0 = top + gap;
            const out = label.draw(t0);
            let below = 0;
            rows.forEach((r, i) => {
                const base = t0 + rowsTop + size * CAP + i * step + below;
                out.push(text(x, base, r.at, size, 600, ink.head));
                rowLines[i]!.forEach((l, j) => out.push(text(tx, base + j * lh, l, size, 400, ink.body)));
                below += (rowLines[i]!.length - 1) * lh;
            });
            return out;
        },
    };
}

/**
 * The home picture (stage 16: ahead; the lock picture holds today): the backdrop, and at the left, above the dock, what
 * is ahead: Pick up (what they left unfinished), Coming up (the next days) and the buddy's thought, each only when there
 * is one. Nothing ahead and no thought: the picture alone. Laid out in what the phone shows (its zoom), its bottom at
 * 74 % of the height, never up into the clock and the search bar. The day's number, its reminders (on the lock picture
 * now), the date and the week's dots are gone (the owner, 11-20: nothing on both screens).
 */
export function drawWallpaper(input: WallpaperInput, width: number, height: number, theme: Theme): string {
    if (input.layout === 'glass' || input.layout === 'stack') return drawHomeV2(input, width, height, theme, input.layout);
    const W = width;
    const H = height;
    const look = lookOf(input, W, H, theme, 'home');
    const { defs, art } = look;
    const ink = look.ink;
    const x = W * 0.08;
    const usable = W - 2 * x;
    const words: string[] = [...look.overlay];
    // The blocks, with Coming up's to-dos on up to three lines each, two or one when the band (from 36 % to 74 % of the
    // height) would overflow (a full day on a short phone).
    const build = (lines: number): Block[] => {
        const blocks: Block[] = [];
        if (input.pickUp?.text.trim()) blocks.push(pickUpRows(input.pickUp, W, x, usable, ink, !blocks.length));
        if (input.comingUp?.length) blocks.push(comingUpRows(input.comingUp, W, x, usable, ink, !blocks.length, lines));
        if ((input.insight ?? '').trim()) blocks.push(insightRows(input.insight ?? '', W, x, usable, ink, blocks.length > 0, !blocks.length));
        return blocks;
    };
    const sum = (bs: Block[]) => bs.reduce((a, bl) => a + bl.h, 0);
    let blocks = build(3);
    for (const lines of [2, 1]) if (sum(blocks) > H * (0.74 - 0.36)) blocks = build(lines);
    const total = sum(blocks);
    // Never up into the clock and the search bar.
    let y = Math.max(H * 0.74 - total, H * 0.36);
    for (const bl of blocks) {
        words.push(...bl.draw(y));
        y += bl.h;
    }
    return picture(W, H, defs, art, words, input.zoom);
}

/** An arc of the dial: from angle a0 to a1 (degrees, 0 at the top, clockwise) on a circle at (cx, cy). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
    const p = (a: number) => {
        const t = ((a - 90) * Math.PI) / 180;
        return `${r1(cx + r * Math.cos(t))} ${r1(cy + r * Math.sin(t))}`;
    };
    return `M${p(a0)} A${r1(r)} ${r1(r)} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p(a1)}`;
}

/**
 * The ring of the day: one segment per thing (done ones first, so the lit part grows clockwise from
 * the top); past sixteen it is one arc, lit as far as the day has come; an empty day is a dim circle.
 */
function dayRing(items: NonNullable<WallpaperInput['items']>, cx: number, cy: number, R: number, stroke: number, lit: string, dim: string, look: RingLook = { lit, dim }): string[] {
    const out: string[] = [];
    const open = items.filter((i) => !i.done);
    const total = items.length;
    // A watch dial: sixty ticks just outside the ring, lit (in the accent) as far as the day is done.
    if (look.ticks) {
        const share = total ? (total - open.length) / total : 0;
        for (let t = 0; t < 60; t++) {
            const a = (t / 60) * Math.PI * 2 - Math.PI / 2;
            const major = t % 5 === 0;
            const r0 = R + stroke * 2.2;
            const r2 = r0 + (major ? R * 0.16 : R * 0.08);
            const on = total > 0 && t < Math.round(share * 60);
            out.push(`<line x1="${r1(cx + Math.cos(a) * r0)}" y1="${r1(cy + Math.sin(a) * r0)}" x2="${r1(cx + Math.cos(a) * r2)}" y2="${r1(cy + Math.sin(a) * r2)}" stroke="${on ? lit : dim}" stroke-width="${r1(major ? stroke * 1.6 : stroke)}" stroke-linecap="round"/>`);
        }
        out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${dim}" stroke-width="${stroke}"/>`);
        return out;
    }
    // Round dots on the circle, lit as far as the day is done (the dot-matrix style).
    if (look.dotted) {
        const n = 40;
        const share = total ? (total - open.length) / total : 0;
        for (let t = 0; t < n; t++) {
            const a = (t / n) * Math.PI * 2 - Math.PI / 2;
            const on = total > 0 && t < Math.round(share * n);
            out.push(`<circle cx="${r1(cx + Math.cos(a) * R)}" cy="${r1(cy + Math.sin(a) * R)}" r="${r1(stroke * 0.85)}" fill="${on ? lit : dim}"/>`);
        }
        return out;
    }

    if (total === 0) {
        out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${dim}" stroke-width="${stroke}"/>`);
    } else if (total > 16) {
        const share = (total - open.length) / total;
        out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${dim}" stroke-width="${stroke}"/>`);
        if (share > 0) out.push(`<path d="${arc(cx, cy, R, 0, Math.max(1, share * 359.9))}" fill="none" stroke="${lit}" stroke-width="${stroke}" stroke-linecap="round"/>`);
    } else {
        const seg = 360 / total;
        // Round ends reach half a stroke past each end: the visible gap stays about one stroke wide.
        const capDeg = (stroke / 2 / R) * (180 / Math.PI);
        const gap = total > 1 ? Math.min(seg * 0.45, 2 * capDeg + (stroke / R) * (180 / Math.PI) * 0.9) : 0;
        const ordered = [...items.filter((i) => i.done), ...open];
        ordered.forEach((it, i) => {
            const a0 = i * seg + gap / 2;
            const a1 = (i + 1) * seg - gap / 2;
            const color = it.done ? lit : dim;
            const shape = total === 1 ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${color}" stroke-width="${stroke}"/>` : `<path d="${arc(cx, cy, R, a0, Math.max(a0 + 0.5, a1))}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>`;
            // A soft light under a lit segment (the night styles).
            if (look.glow && it.done) out.push(shape.replace(`stroke-width="${stroke}"`, `stroke-width="${r1(stroke * 4)}" stroke-opacity="0.16"`));
            out.push(shape);
        });
    }
    return out;
}


// ── The lock picture ──────────────────────────────────────────────────────────────────────────

/** How far a ring reaches from its centre (a watch dial's ticks stand outside it). */
const ringReach = (R: number, stroke: number, look: RingLook) => (look.ticks ? R + stroke * 3 + R * 0.16 : R + stroke / 2 + (look.dotted ? stroke * 0.4 : 0));

/**
 * Inside a ring: what is left (a numeral with a small capital label under it), a tick once all is
 * done (with "Done for today" under it in a ring large enough: the dial's), or the words for a free
 * day; the block centred on the ring's centre.
 */
function ringCentre(input: WallpaperInput, cx: number, cy: number, W: number, numeralSize: number, label: string, ink: Sky['ink'], doneWords = false): string[] {
    const items = input.items ?? [];
    const open = items.filter((i) => !i.done).length;
    const quiet = W * TYPE.quiet;
    // A free day shows the tick too (the owner, 11-23 night: no "Free"): nothing is left either way. Only a day with
    // something done says "Done for today" under it.
    if (!items.length || !open) {
        doneWords = doneWords && items.length > 0;
        const h = numeralSize * 0.62;
        const w = h * 1.3;
        const out = [tick(cx - w / 2, cy - h / 2 - (doneWords ? quiet : 0), w, h, numeralSize * 0.085, ink.head)];
        if (doneWords) out.push(text(cx, cy + h / 2 + quiet * 1.4, 'Done for today', quiet, 500, ink.meta, { anchor: 'middle' }));
        return out;
    }
    const num = String(open);
    const gap = W * 0.024;
    const h = numeralSize * CAP + gap + quiet * CAP;
    const base = cy - h / 2 + numeralSize * CAP;
    return [
        text(cx, base, num, numeralSize, 600, ink.head, { anchor: 'middle', track: TRACK.numeral }),
        // Sentence case ("4 left today"): the number starts the phrase (the owner, 11-21).
        text(cx, base + gap + quiet * CAP, label, quiet, 500, ink.body, { anchor: 'middle' }),
    ];
}

/**
 * The day in words under its ring ("3 reviews · 1 focus line · 1 task"), close to the ring it explains (the owner, 11-21:
 * the ring, Buddy's line, the counts and the reminders felt bunched together). None on a free day, and none in the dial
 * when everything is done: its ring already says "Done for today".
 */
function countsRow(input: WallpaperInput, W: number, inDial: boolean): { words: string; size: number } {
    const items = input.items ?? [];
    const words = inDial && items.length > 0 && items.every((i) => i.done) ? '' : dayRow(input);
    const size = W * TYPE.counts;
    return { words, size: textWidth(words, size, 500) <= W * 0.84 ? size : W * TYPE.quiet };
}

/** The schedule's time column: the time; "Today" for today's things without one; "Late" for late ones. */
export function scheduleAt(at: string): string {
    return at === '' ? 'Today' : at === 'late' ? 'Late' : at;
}

/** The lock picture's left edge (the home picture's too): its words start here, wide enough not to feel squeezed. */
const LOCK_X = 0.08;
/** Its right margin: narrower, so Buddy's line and the rows run wide (the owner, 11-21). */
const LOCK_RIGHT = 0.05;

/**
 * The lock's ring (the owner, 11-21): no glow on it, and its lit part in a quiet blue unless they chose a colour.
 */
function lockRing(look: Look, theme: Theme, input: WallpaperInput): RingLook {
    return { ...look.ring, glow: false, ...(input.color ? {} : { lit: theme === 'dark' ? '#8AB4F8' : '#2F6BD8' }) };
}

/**
 * What is scheduled next (stage 16; aligned on the owner's word, 11-21: "to their left, like home"): today's next things
 * as an agenda at the picture's left edge, the times in one column (a thing without a time says "Today", a late one
 * "Late", both quieter) and the words after them; then the goal's days (quiet; only with their switch on). Its height
 * counts the gap above it. `fits` says how many of today's rows and whether the goal's row fit.
 */
function scheduleRows(input: WallpaperInput, W: number, gapAbove: number, fits: { today: number; goal: boolean }): { h: number; draw: (top: number, cx: number, ink: Sky['ink']) => string[] } {
    const u = W / 100;
    const quiet = W * TYPE.quiet;
    const maxW = W * 0.84;
    const list = (input.today ?? []).slice(0, Math.max(0, fits.today));
    const goal = fits.goal ? goalRow(input.goal) : '';
    const size = W * TYPE.secondary;
    const step = size * 1.78;
    const timed = (at: string) => at !== '' && at !== 'late';
    const atW = Math.max(0, ...list.map((r) => textWidth(scheduleAt(r.at), size, timed(r.at) ? 600 : 500)));
    const x = W * LOCK_X;
    const tx = x + atW + 2.6 * u;
    // A long reminder wraps under itself (the owner, 11-23 night), up to three lines; the rest ends in "…".
    const rowW = W * (1 - LOCK_RIGHT) - tx;
    const lh = size * 1.32;
    const rowLines = list.map((r) => {
        const all = wrapText(r.text, size, 400, rowW, 99, 0, false);
        return all.length <= 3 ? all : [...all.slice(0, 2), fit(all.slice(2).join(' '), size, 400, rowW)];
    });
    const extra = rowLines.reduce((n, ls) => n + (ls.length - 1) * lh, 0);
    const listH = list.length ? gapAbove + size * CAP + (list.length - 1) * step + extra : 0;
    const goalH = goal ? (list.length ? 5 * u : gapAbove) + quiet * CAP : 0;
    return {
        h: listH + goalH,
        draw: (top, _cx, ink) => {
            const out: string[] = [];
            let y = top;
            if (list.length) {
                let extraAbove = 0;
                list.forEach((r, i) => {
                    const base = y + gapAbove + size * CAP + i * step + extraAbove;
                    out.push(text(x, base, scheduleAt(r.at), size, timed(r.at) ? 600 : 500, timed(r.at) ? ink.head : ink.meta));
                    rowLines[i]!.forEach((l, j) => out.push(text(tx, base + j * lh, l, size, 400, ink.body)));
                    extraAbove += (rowLines[i]!.length - 1) * lh;
                });
                y += listH;
            }
            if (goal) {
                y += goalH;
                out.push(text(x, y, fit(goal, quiet, 400, maxW), quiet, 400, ink.meta));
            }
            return out;
        },
    };
}

/**
 * Stage 16: how much of the lock picture fits between the clock and the fingerprint, most first. Today's third row shows
 * when it fits; with two, both always show: the ring shrinks first, then goes, before the second row does. The goal's
 * row (their switch) is the first to go.
 */
function lockFits(n: number): Array<{ ring: number; today: number; goal: boolean }> {
    const two = Math.min(2, n);
    return [
        { ring: 1, today: Math.min(3, n), goal: true },
        { ring: 1, today: Math.min(3, n), goal: false },
        { ring: 1, today: two, goal: false },
        { ring: 0.75, today: two, goal: false },
        { ring: 0, today: two, goal: false },
        { ring: 0, today: Math.min(1, n), goal: false },
    ];
}

/** The lowest a lock picture's words may reach (the safe zone ends at 0.84: room for the last row's descenders). */
const LOCK_BOTTOM = 0.8;

/** A soft light behind the words (in the style's colour, or dark under the words on a bright backdrop). */
function softLight(defs: string[], look: Look, cx: number, cy: number, rx: number, ry: number, id: string, strength = 1): string[] {
    if (!look.glow || look.glowAlpha <= 0) return [];
    const a = Math.min(0.6, look.glowAlpha * strength);
    defs.push(`<radialGradient id="${id}"><stop offset="0" stop-color="${look.glow}" stop-opacity="${a}"/><stop offset="0.5" stop-color="${look.glow}" stop-opacity="${r1(a * 0.4 * 100) / 100}"/><stop offset="1" stop-color="${look.glow}" stop-opacity="0"/></radialGradient>`);
    return [`<ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(rx)}" ry="${r1(ry)}" fill="url(#${id})"/>`];
}

/**
 * The lock picture (B4; the owner, 11-16: "a whole circle like initially, not half"; B8: one type system):
 * the ring of the day with what is left inside it and its counts close under it, the buddy's line as the main words
 * (apart, 11-21), then what is scheduled next and the goal's days, quieter. The group is centred in the calm band
 * between the clock and the fingerprint. Without a line (the buddy off, or no line passed its lock
 * check): the dial.
 */
export function drawLock(input: WallpaperInput, width: number, height: number, theme: Theme): string {
    if (input.layout === 'glass' || input.layout === 'stack') return drawLockV2(input, width, height, theme, input.layout);
    const main = (input.line ?? '').trim();
    if (!main) return drawDial(input, width, height, theme);
    const W = width;
    const H = height;
    const look = lookOf(input, W, H, theme, 'lock');
    const { defs, art } = look;
    const ink = look.ink;
    const u = W / 100;
    const cx = W / 2;
    const withRing = (input.dayMark ?? 'ring') === 'ring';

    // The line (the owner, 11-21: smaller, and running wide to the right edge): at the left edge, filling each line before
    // the next (not balanced), as large as fits three lines (below the usual size only when it must).
    const weight: Weight = look.lineWeight >= 550 ? 600 : 500;
    const x = W * LOCK_X;
    const tx = x;
    const usable = W * (1 - LOCK_X - LOCK_RIGHT) * (look.lineWeight >= 650 ? 0.95 : 1); // Bold is measured as SemiBold, with room for its width
    let size: number = W * TYPE.lineMax;
    let lines: string[] = [];
    for (; ; size -= W * 0.002) {
        lines = wrapText(main, size, weight, usable, 99, size * TRACK.line, false);
        if (lines.length <= 3 || size <= W * TYPE.lineFloor) break;
    }
    lines = lines.slice(0, 3);
    const lh = size * 1.3;
    const lineH = size * CAP + (lines.length - 1) * lh;
    const ring = lockRing(look, theme, input);

    const band = input.iconSlot ? iconBand(W) : 0;
    // Three groups, apart (the owner, 11-21): the day (its ring, its counts close under it), Buddy's line (what it wants
    // noticed), what is scheduled next.
    const counts = countsRow(input, W, false);
    const shape = (f: { ring: number; today: number; goal: boolean }) => {
        const ringOn = withRing && f.ring > 0;
        const scale = ringOn ? f.ring : 1;
        const R = W * 0.135 * scale;
        const stroke = Math.max(3, W * (ring.stroke ?? 0.017) * 0.8 * scale);
        const reach = ringReach(R, stroke, ring);
        const ringH = ringOn ? 2 * reach : 0;
        const countsH = counts.words ? (ringOn ? 3.4 * u : 0) + counts.size * CAP : 0;
        const dayH = ringH + countsH;
        const lineGap = dayH ? 9 * u : 0;
        const rows = scheduleRows(input, W, 7 * u, f);
        const groupH = dayH + lineGap + lineH + rows.h + band;
        // A little above the middle (the clock sits higher than the fingerprint); never up into the clock.
        const top = Math.max(H * 0.3, H * 0.49 - groupH / 2);
        return { ringOn, scale, R, stroke, reach, ringH, countsH, lineGap, rows, groupH, top };
    };
    const tries = lockFits((input.today ?? []).length).map(shape);
    const pick = tries.find((t) => t.top + t.groupH <= H * LOCK_BOTTOM) ?? tries[tries.length - 1]!;
    const { R, stroke, reach, ringH, rows, groupH, top } = pick;
    const words: string[] = [...softLight(defs, look, cx, top + groupH / 2, W * 0.64, Math.max(W * 0.5, groupH * 0.75), 'lineGlow'), ...look.overlay];
    if (pick.ringOn) {
        const cy = top + reach;
        words.push(...dayRing(input.items ?? [], cx, cy, R, stroke, ring.lit, ring.dim, ring));
        words.push(...ringCentre(input, cx, cy, W, W * TYPE.ringNumeral * pick.scale, 'left', ink));
    }
    if (counts.words) words.push(text(cx, top + ringH + pick.countsH, fit(counts.words, counts.size, 500, W * 0.84), counts.size, 500, ink.body, { anchor: 'middle' }));
    const lineTop = top + ringH + pick.countsH + pick.lineGap;
    lines.forEach((l, i) => words.push(text(tx, lineTop + size * CAP + i * lh, l, size, look.lineWeight, ink.head, { track: TRACK.line })));
    words.push(...rows.draw(lineTop + lineH, cx, ink));
    return picture(W, H, defs, art, words, input.zoom, input.iconSlot ? iconSlotAt(lineTop + lineH + rows.h, W, ink.body) : undefined);
}

/**
 * The dial of the day (the lock picture without a line of the buddy's): a large ring of today's
 * things with what is left inside it, then the next step, the day in words and the goal's days.
 */
export function drawDial(input: WallpaperInput, width: number, height: number, theme: Theme): string {
    const W = width;
    const H = height;
    const look = lookOf(input, W, H, theme, 'lock');
    const { defs, art } = look;
    const ink = look.ink;
    const u = W / 100;
    const cx = W / 2;
    const items = input.items ?? [];
    const band = input.iconSlot ? iconBand(W) : 0;
    // Stage 16: today's rows take the place of the old "Next ·" row; the dial shrinks before a row goes. 11-21: the day
    // (the dial, its counts close under it) and what is scheduled next are two groups, apart.
    const counts = countsRow(input, W, true);
    const ring = lockRing(look, theme, input);
    const shape = (f: { ring: number; today: number; goal: boolean }) => {
        const scale = f.ring === 1 ? 1 : f.ring === 0.75 ? 0.8 : 0.65;
        const R = W * 0.2 * scale;
        const stroke = Math.max(4, W * Math.max(0.009, (ring.stroke ?? 0.017) * 1.15) * scale);
        const reach = ringReach(R, stroke, ring);
        const countsH = counts.words ? 4 * u + counts.size * CAP : 0;
        const rows = scheduleRows(input, W, 9 * u, f);
        const groupH = 2 * reach + countsH + rows.h + band;
        const top = Math.max(H * 0.3, H * 0.49 - groupH / 2);
        return { scale, R, stroke, reach, countsH, rows, groupH, top };
    };
    const tries = lockFits((input.today ?? []).length).map(shape);
    const pick = tries.find((t) => t.top + t.groupH <= H * LOCK_BOTTOM) ?? tries[tries.length - 1]!;
    const { R, stroke, reach, rows, top } = pick;
    const cy = top + reach;

    const words: string[] = [...softLight(defs, look, cx, cy, R * 2.3, R * 2.3, 'dialGlow', 1.3), ...look.overlay];
    words.push(...dayRing(items, cx, cy, R, stroke, ring.lit, ring.dim, ring));
    words.push(...ringCentre(input, cx, cy, W, W * TYPE.dialNumeral * pick.scale, 'left today', ink, true));
    if (counts.words) words.push(text(cx, top + 2 * reach + pick.countsH, fit(counts.words, counts.size, 500, W * 0.84), counts.size, 500, ink.body, { anchor: 'middle' }));
    const y = top + 2 * reach + pick.countsH;
    words.push(...rows.draw(y, cx, ink));
    return picture(W, H, defs, art, words, input.zoom, input.iconSlot ? iconSlotAt(y + rows.h, W, ink.body) : undefined);
}


// ── The lock picture, rethought (the owner, 11-22: "as if Apple did it on their lock screen") ──────────────────
//
// Two layouts to compare. Both keep the day at the top, under the phone's own clock: the ring with what is left in it
// and the kinds under it, centred. Below it, everything else sits low on the screen, where iOS puts its Live Activities
// and notifications, on frosted glass: the backdrop itself, blurred inside each card, with a thin tint and a hairline.
//  - 'glass': one panel, the buddy's line at the top and today's next things under a hairline, as an agenda.
//  - 'stack': the buddy's line on its own card, then each of today's next things on a slimmer card of its own, the
//    time at the right, as a notification stack.
// Nothing is cut: a line that won't fit three lines gets smaller; rows that won't fit go, the last first.

interface Glass {
    fill: string;
    edge: string;
    sheen: string;
    head: string;
    body: string;
    meta: string;
}

function glassOf(theme: Theme): Glass {
    return theme === 'dark'
        ? { fill: 'rgba(255,255,255,0.09)', edge: 'rgba(255,255,255,0.18)', sheen: 'rgba(255,255,255,0.07)', head: '#FFFFFF', body: 'rgba(255,255,255,0.90)', meta: 'rgba(255,255,255,0.66)' }
        : { fill: 'rgba(255,255,255,0.52)', edge: 'rgba(255,255,255,0.70)', sheen: 'rgba(255,255,255,0.18)', head: '#141311', body: 'rgba(20,19,17,0.82)', meta: 'rgba(20,19,17,0.56)' };
}

let frostSeq = 0;
/** A frosted card: the backdrop blurred inside the rounded rectangle, a tint over it, a hairline edge and a faint top sheen. */
function frosted(defs: string[], art: string[], x: number, y: number, w: number, h: number, r: number, g: Glass, W: number): string[] {
    const id = `frost${++frostSeq}`;
    const blur = W * 0.035;
    const pad = blur * 3;
    defs.push(`<clipPath id="${id}c"><rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${r1(r)}"/></clipPath>`);
    defs.push(`<filter id="${id}f" filterUnits="userSpaceOnUse" x="${r1(x - pad)}" y="${r1(y - pad)}" width="${r1(w + 2 * pad)}" height="${r1(h + 2 * pad)}"><feGaussianBlur stdDeviation="${r1(blur)}"/></filter>`);
    defs.push(`<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${g.sheen}"/><stop offset="0.5" stop-color="${g.sheen}" stop-opacity="0"/></linearGradient>`);
    return [
        `<g clip-path="url(#${id}c)"><g filter="url(#${id}f)">${art.join('')}</g></g>`,
        `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${r1(r)}" fill="${g.fill}"/>`,
        `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${r1(r)}" fill="url(#${id}s)"/>`,
        `<rect x="${r1(x + 0.75)}" y="${r1(y + 0.75)}" width="${r1(w - 1.5)}" height="${r1(h - 1.5)}" rx="${r1(r - 0.75)}" fill="none" stroke="${g.edge}" stroke-width="1.5"/>`,
    ];
}

/** The buddy's line at a size that fits `lines` lines of `width` (smaller only when it must), filling each line in turn. */
function lineFit(main: string, W: number, width: number, maxLines: number, weight: Weight, big: number, floor: number): { size: number; lines: string[] } {
    let size = W * big;
    let lines: string[] = [];
    for (; ; size -= W * 0.002) {
        lines = wrapText(main, size, weight, width, 99, size * TRACK.line, false);
        if (lines.length <= maxLines || size <= W * floor) break;
    }
    return { size, lines: lines.slice(0, maxLines) };
}

function drawLockV2(input: WallpaperInput, width: number, height: number, theme: Theme, layout: 'glass' | 'stack'): string {
    const W = width;
    const H = height;
    const u = W / 100;
    const cx = W / 2;
    const look = lookOf(input, W, H, theme, 'lock');
    const { defs, art } = look;
    const ink = look.ink;
    const g = glassOf(theme);
    const ring = lockRing(look, theme, input);
    const items = input.items ?? [];
    const main = (input.line ?? '').trim();
    const today = [...(input.today ?? [])];
    const band = input.iconSlot ? iconBand(W) : 0;

    // The day: a ring a little heavier than before (an activity ring), its numeral, and the kinds under it.
    const counts = countsRow(input, W, !main);
    const day = (scale: number) => {
        const R = W * 0.15 * scale;
        const stroke = Math.max(4, W * 0.024 * scale);
        const reach = ringReach(R, stroke, { ...ring, ticks: false, dotted: false });
        const countsH = counts.words ? 4 * u + counts.size * CAP : 0;
        return { R, stroke, reach, h: 2 * reach + countsH, countsH, scale };
    };

    // The cards, low on the screen: their bottom at 80 % of the height (above the fingerprint), the stack growing up.
    const x = W * 0.055;
    const cw = W * 0.89;
    const pad = 5.2 * u;
    const radius = W * 0.062;
    const timed = (at: string) => at !== '' && at !== 'late';
    const rowSize = W * 0.037;

    type Card = { h: number; draw: (top: number) => string[] };
    const lineCard = (maxLines: number): Card | null => {
        if (!main) return null;
        const { size, lines } = lineFit(main, W, cw - 2 * pad, maxLines, 500, 0.049, 0.04);
        const lh = size * 1.3;
        // No "Buddy" label (the owner, 11-22: an iPhone wouldn't name it; the words are enough).
        const labelH = 0;
        const h = pad + labelH + size * CAP + (lines.length - 1) * lh + pad;
        return {
            h,
            draw: (top) => {
                const out = frosted(defs, art, x, top, cw, h, radius, g, W);
                lines.forEach((l, i) => out.push(text(x + pad, top + pad + labelH + size * CAP + i * lh, l, size, 500, g.head, { track: TRACK.line })));
                return out;
            },
        };
    };
    // A row's words wrap under themselves (the owner, 11-23 night: a long reminder was cut with "…"), up to
    // three lines; only what still doesn't fit ends in "…".
    const ROW_LINES = 3;
    const agendaRows = (rows: ReadonlyArray<{ at: string; text: string }>, left: number, right: number) => {
        const atW = Math.max(0, ...rows.map((r) => textWidth(scheduleAt(r.at), rowSize, timed(r.at) ? 600 : 500)));
        const tx = left + atW + 3.2 * u;
        const width = right - tx;
        const lh = rowSize * 1.32;
        const gap = rowSize * 2.05 - lh;
        const wrapped = rows.map((r) => {
            const all = wrapText(r.text, rowSize, 400, width, 99, 0, false);
            if (all.length <= ROW_LINES) return all;
            return [...all.slice(0, ROW_LINES - 1), fit(all.slice(ROW_LINES - 1).join(' '), rowSize, 400, width)];
        });
        const heights = wrapped.map((ls) => rowSize * CAP + (ls.length - 1) * lh);
        return {
            h: rows.length ? heights.reduce((n, x) => n + x, 0) + (rows.length - 1) * (gap + lh - rowSize * CAP) : 0,
            draw: (top: number) => {
                const out: string[] = [];
                let y = top;
                rows.forEach((r, i) => {
                    const base = y + rowSize * CAP;
                    out.push(text(left, base, scheduleAt(r.at), rowSize, timed(r.at) ? 600 : 500, timed(r.at) ? g.head : g.meta));
                    wrapped[i]!.forEach((l, j) => out.push(text(tx, base + j * lh, l, rowSize, 400, g.body)));
                    y += heights[i]! + gap + lh - rowSize * CAP;
                });
                return out;
            },
        };
    };

    // 'glass': one panel with the line, a hairline, and the agenda.
    const panel = (lineLines: number, rows: number): Card | null => {
        const lc = main ? lineFit(main, W, cw - 2 * pad, lineLines, 500, 0.049, 0.04) : null;
        const list = today.slice(0, rows);
        if (!lc && !list.length) return null;
        const labelSize = W * 0.029;
        const labelH = labelSize * CAP + 2.6 * u;
        const lh = lc ? lc.size * 1.3 : 0;
        const lineH = lc ? lc.size * CAP + (lc.lines.length - 1) * lh : 0;
        const agenda = agendaRows(list, x + pad, x + cw - pad);
        const upLabelH = !lc && list.length ? labelH : 0;
        const sep = lc && list.length ? 9 * u : 0;
        const h = pad + lineH + sep + upLabelH + agenda.h + pad;
        return {
            h,
            draw: (top) => {
                const out = frosted(defs, art, x, top, cw, h, radius, g, W);
                let y = top + pad;
                if (lc) {
                    lc.lines.forEach((l, i) => out.push(text(x + pad, y + lc.size * CAP + i * lh, l, lc.size, 500, g.head, { track: TRACK.line })));
                    y += lineH;
                }
                if (sep) {
                    out.push(`<line x1="${r1(x + pad)}" y1="${r1(y + sep / 2)}" x2="${r1(x + cw - pad)}" y2="${r1(y + sep / 2)}" stroke="${g.edge}" stroke-width="2"/>`);
                    y += sep;
                }
                if (upLabelH) {
                    out.push(text(x + pad, y + labelSize * CAP, 'Up next', labelSize, 600, g.meta, { track: 0.01 }));
                    y += upLabelH;
                }
                out.push(...agenda.draw(y));
                return out;
            },
        };
    };

    // 'stack': the line's card, then a slimmer card per row (the time at the right), each a step apart.
    const stack = (lineLines: number, rows: number): Card | null => {
        const lc = lineCard(lineLines);
        const list = today.slice(0, rows);
        const rowPad = 3.9 * u;
        const rowH = rowPad * 2 + rowSize * CAP;
        const gap = 2 * u;
        const cards: Card[] = [];
        if (lc) cards.push(lc);
        list.forEach((r) => {
            // A long reminder wraps on its card (the owner, 11-23 night), up to three lines; the card grows with it.
            const at = scheduleAt(r.at);
            const atW = textWidth(at, rowSize * 0.9, 500);
            const textW = cw - 2 * pad - atW - 3 * u;
            const all = wrapText(r.text, rowSize, 500, textW, 99, 0, false);
            const lines = all.length <= 3 ? all : [...all.slice(0, 2), fit(all.slice(2).join(' '), rowSize, 500, textW)];
            const lh = rowSize * 1.32;
            const h = rowH + (lines.length - 1) * lh;
            cards.push({
                h,
                draw: (top) => {
                    const out = frosted(defs, art, x, top, cw, h, rowH * 0.36, g, W);
                    const base = top + rowPad + rowSize * CAP;
                    lines.forEach((l, j) => out.push(text(x + pad, base + j * lh, l, rowSize, 500, g.head)));
                    out.push(text(x + cw - pad, base, at, rowSize * 0.9, 500, timed(r.at) ? g.body : g.meta, { anchor: 'end' }));
                    return out;
                },
            });
        });
        if (!cards.length) return null;
        const h = cards.reduce((n, c) => n + c.h, 0) + gap * (cards.length - 1);
        return {
            h,
            draw: (top) => {
                const out: string[] = [];
                let y = top;
                cards.forEach((c) => {
                    out.push(...c.draw(y));
                    y += c.h + gap;
                });
                return out;
            },
        };
    };

    // What fits, most first: three lines and three rows with the full ring, then fewer rows, a smaller ring, fewer lines.
    const n = today.length;
    const tries: Array<{ scale: number; lines: number; rows: number }> = [
        { scale: 1, lines: 3, rows: Math.min(3, n) },
        { scale: 1, lines: 3, rows: Math.min(2, n) },
        { scale: 0.82, lines: 3, rows: Math.min(2, n) },
        { scale: 0.82, lines: 2, rows: Math.min(2, n) },
        { scale: 0.7, lines: 2, rows: Math.min(1, n) },
    ];
    // On his phone (11-22): the clock and date end near 21 % of the height; the phone's own notifications, its owner line
    // and the shortcuts take the bottom from about 78 %. The group starts under the clock and stays above 74 %.
    const ringTop = H * 0.275;
    const bottom = H * 0.74 - band;
    let chosen: { d: ReturnType<typeof day>; card: Card | null } | null = null;
    for (const t of tries) {
        const d = day(t.scale);
        const card = layout === 'glass' ? panel(t.lines, t.rows) : stack(t.lines, t.rows);
        if (!card || ringTop + d.h + 7 * u + card.h <= bottom) {
            chosen = { d, card };
            break;
        }
    }
    if (!chosen) {
        const t = tries[tries.length - 1]!;
        chosen = { d: day(t.scale), card: layout === 'glass' ? panel(t.lines, t.rows) : stack(t.lines, t.rows) };
    }
    const { d, card } = chosen;

    const words: string[] = [...look.overlay];
    // One group under the clock: the day, then the cards a step under it (a little lower when there is room to spare,
    // so the group sits in the calm band rather than tight under the date).
    const groupH = d.h + (card ? 7 * u + card.h : 0);
    const dayTop = Math.min(ringTop + Math.max(0, (bottom - ringTop - groupH) * 0.25), Math.max(ringTop, H * 0.47 - groupH / 2));
    const cardTop = dayTop + d.h + 7 * u;
    const cy = dayTop + d.reach;
    words.push(...dayRing(items, cx, cy, d.R, d.stroke, ring.lit, ring.dim, { ...ring, ticks: false, dotted: false, glow: false }));
    words.push(...ringCentre(input, cx, cy, W, W * 0.118 * d.scale, 'left today', ink, !main));
    if (counts.words) words.push(text(cx, dayTop + 2 * d.reach + d.countsH, fit(counts.words, counts.size, 500, W * 0.84), counts.size, 500, ink.body, { anchor: 'middle' }));
    if (card) words.push(...card.draw(cardTop));
    return picture(W, H, defs, art, words, input.zoom, input.iconSlot ? iconSlotAt(bottom, W, ink.body) : undefined);
}

/**
 * The home picture on frosted glass (the owner, 11-22: a choice beside the classic one), the same words as the classic
 * picture (Pick up, Coming up, the buddy's thought) in the same place, above the dock:
 *  - 'glass': one panel holding them all, a hairline between the parts;
 *  - 'stack': a card for each part, a step apart.
 */
function drawHomeV2(input: WallpaperInput, width: number, height: number, theme: Theme, layout: 'glass' | 'stack'): string {
    const W = width;
    const H = height;
    const u = W / 100;
    const look = lookOf(input, W, H, theme, 'home');
    const { defs, art } = look;
    const g = glassOf(theme);
    const ink = { ...look.ink, head: g.head, body: g.body, meta: g.meta };
    const x = W * 0.055;
    const cw = W * 0.89;
    const pad = 5.2 * u;
    const radius = W * 0.062;
    const inner = cw - 2 * pad;
    const sep = 9 * u;
    const gap = 2 * u;
    // Coming up's to-dos on up to three lines each, two or one when the cards would rise past 30 % of the height.
    const build = (lines: number): Block[] => {
        const parts: Block[] = [];
        if (input.pickUp?.text.trim()) parts.push(pickUpRows(input.pickUp, W, x + pad, inner, ink, true));
        if (input.comingUp?.length) parts.push(comingUpRows(input.comingUp, W, x + pad, inner, ink, true, lines));
        if ((input.insight ?? '').trim()) parts.push(insightRows(input.insight ?? '', W, x + pad, inner, ink, false, true));
        return parts;
    };
    const heightOf = (parts: Block[]) =>
        layout === 'glass' ? parts.reduce((a, p) => a + p.h, 0) + sep * (parts.length - 1) + 2 * pad : parts.reduce((a, p) => a + p.h + 2 * pad, 0) + gap * (parts.length - 1);
    let parts = build(3);
    for (const lines of [2, 1]) if (heightOf(parts) > H * (0.74 - 0.3)) parts = build(lines);
    const words: string[] = [...look.overlay];
    if (parts.length) {
        const heights = parts.map((p) => p.h + 2 * pad);
        const total = heightOf(parts);
        // Never up into the clock and the search bar; its bottom where the classic picture's words end.
        let y = Math.max(H * 0.74 - total, H * 0.3);
        if (layout === 'glass') {
            words.push(...frosted(defs, art, x, y, cw, total, radius, g, W));
            y += pad;
            parts.forEach((p, i) => {
                if (i > 0) {
                    words.push(`<line x1="${r1(x + pad)}" y1="${r1(y + sep / 2)}" x2="${r1(x + cw - pad)}" y2="${r1(y + sep / 2)}" stroke="${g.edge}" stroke-width="2"/>`);
                    y += sep;
                }
                words.push(...p.draw(y));
                y += p.h;
            });
        } else {
            parts.forEach((p, i) => {
                words.push(...frosted(defs, art, x, y, cw, heights[i]!, radius, g, W));
                words.push(...p.draw(y + pad));
                y += heights[i]! + gap;
            });
        }
    }
    return picture(W, H, defs, art, words, input.zoom);
}
