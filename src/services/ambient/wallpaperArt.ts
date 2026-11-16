// The phone's pictures (ANDROID_APP_SPEC; BUDDY_MEMORY_PLAN §3.4 and §11.1). The backdrop is the sky
// of the day (its light follows the day's state: dawn, daylight, dusk, a starry night, a soft mist on a
// light day) or one of the dark styles (wallpaperStyles.ts). Over it, one type system for every picture
// (B8, Ramin 11-16: "how you use the font, spacing, weights… make it better"): three sizes of words
// and the numerals, gaps in units of 1 % of the width, Inter throughout. The home picture is drawn for
// the zoom the phone shows it at. Every day draws a slightly different backdrop (the date seeds it).
// Pure: SVG text in, out.
import { styleLook, type RingLook } from './wallpaperStyles';
import { INTER_ADVANCES, INTER_CHARS, INTER_DIGIT_LSB, INTER_UPM } from './interMetrics';

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
    /** The lock picture's day mark: the ring of the day over the line (default; Ramin 11-16), or none. */
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
    /** The buddy's line: as large as fits three balanced lines, between these. */
    lineMax: 0.06,
    lineMin: 0.05,
    /** Only when the line won't fit three lines at lineMin (it is never cut). */
    lineFloor: 0.042,
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
    anchor?: 'middle';
    /** Tracking in em. */
    track?: number;
}

/** One line of Inter, its baseline at y. */
function text(x: number, y: number, s: string, size: number, weight: number, fill: string, o: TextOpts = {}): string {
    const ls = o.track ? ` letter-spacing="${r1(o.track * size)}"` : '';
    return `<text x="${r1(x)}" y="${r1(y)}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''} font-family="Inter" font-size="${r1(size)}" font-weight="${weight}"${ls} fill="${fill}">${esc(s)}</text>`;
}

/** How far a numeral's first digit sits in from its x (the digit's side bearing), so it lines up with the words above. */
function digitInset(num: string, size: number, weight: Weight): number {
    const d = Number(num[0]);
    return Number.isInteger(d) ? ((INTER_DIGIT_LSB[weight][d] ?? 0) / INTER_UPM) * size : 0;
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

/** The day in one row of words: "7 reviews · 2 tasks · 56 min", "Done for today", or '' on a free day. */
function dayRow(input: WallpaperInput): string {
    const items = input.items ?? [];
    if (!items.length) return '';
    const open = items.filter((i) => !i.done).length;
    if (!open) return 'Done for today';
    const minutes = input.counts?.minutesLeft ?? 0;
    return [kindWords(input.counts) || `${open} left`, minutes ? `${minutes} min` : ''].filter(Boolean).join(' · ');
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

const DARK_INK = { head: '#F7F5F2', body: 'rgba(247,245,242,0.80)', meta: 'rgba(247,245,242,0.66)', tag: 'rgba(255,255,255,0.12)', tagInk: '#F7F5F2', tagRing: 'rgba(255,255,255,0.22)', dotOn: '#F7F5F2', dotOff: 'rgba(247,245,242,0.28)' };
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
export function wrapText(text: string, size: number, weight: Weight, width: number, max: number, letterSpacing = 0): string[] {
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
    if (lines.length > 1) {
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

/** The week's row: seven dots and their letters (today's dot ringed, last). Its height for the layout. */
const weekHeight = (W: number) => W * 0.021 + W * 0.03 + W * TYPE.quiet * CAP;

/** The last seven days as dots (filled: studied), each with its weekday's letter under it; the first dot's edge at x. */
function weekDots(week: NonNullable<WallpaperInput['week']>, x: number, top: number, W: number, ink: Sky['ink']): string[] {
    const out: string[] = [];
    const r = W * 0.0105;
    const step = W * 0.052;
    const cy = top + r;
    const quiet = W * TYPE.quiet;
    const letters = 'SMTWTFS';
    week.forEach((d, i) => {
        const cx = x + r + i * step;
        out.push(`<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(d.active ? r : r - W / 800)}" fill="${d.active ? ink.dotOn : 'none'}" stroke="${d.active ? 'none' : ink.dotOff}" stroke-width="${r1(W / 400)}"/>`);
        if (i === 6) out.push(`<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r * 1.75)}" fill="none" stroke="${ink.dotOff}" stroke-width="${r1(W / 540)}"/>`);
        const weekday = new Date(`${d.day}T12:00:00Z`).getUTCDay();
        out.push(text(cx, cy + r + W * 0.03 + quiet * CAP, letters[weekday] ?? '', quiet, 500, ink.meta, { anchor: 'middle' }));
    });
    return out;
}

interface Block {
    /** From the first line's cap top to the last line's baseline. */
    h: number;
    draw: (top: number) => string[];
}

/** A bell (lucide's), its box at (x, top), `size` square, in `color`. */
function bell(x: number, top: number, size: number, color: string): string {
    return `<g transform="translate(${r1(x)} ${r1(top)}) scale(${r1((size / 24) * 1000) / 1000})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></g>`;
}

/**
 * Today's reminders under the day's number (Ramin 11-16): a bell, the time and the words, one row each
 * in the secondary size; nothing at all when there are none. The block's height counts its gap above.
 */
function reminderRows(list: ReadonlyArray<{ at: string; text: string }>, W: number, x: number, usable: number, ink: Sky['ink']): Block {
    const rows = list.slice(0, 3);
    if (!rows.length) return { h: 0, draw: () => [] };
    const u = W / 100;
    const size = W * TYPE.secondary;
    const step = size * 1.62;
    const icon = size * 0.92;
    // The words start in one column after the widest time.
    const atW = Math.max(...rows.map((r) => textWidth(r.at, size, 600)));
    return {
        h: 7 * u + size * CAP + (rows.length - 1) * step,
        draw: (top) =>
            rows.flatMap((r, i) => {
                const base = top + 7 * u + size * CAP + i * step;
                const tx = x + icon + 2.4 * u;
                const room = x + usable - (tx + atW + 2.6 * u);
                return [
                    bell(x, base - size * CAP - (icon - size * CAP) / 2, icon, ink.body),
                    text(tx, base, r.at, size, 600, ink.head),
                    text(tx + atW + 2.6 * u, base, fit(r.text, size, 400, room), size, 400, ink.body),
                ];
            }),
    };
}

/** A message bubble (lucide's message-circle): the buddy's mark. Its box at (x, top), `size` square. */
function bubble(x: number, top: number, size: number, color: string): string {
    return `<g transform="translate(${r1(x)} ${r1(top)}) scale(${r1((size / 24) * 1000) / 1000})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></g>`;
}

/**
 * The buddy's thought for the home screen (Ramin 11-16: "reminders or a suggestion or an insight from
 * the buddy… helpful, meaningful and mindful"): its mark in the reminders' icon column and the words
 * wrapped after it (three balanced lines at most; the quiet size only if three won't hold them). The
 * block's height counts its gap above: a step after the reminders, the reminders' own gap after the day.
 */
function insightRows(insight: string, W: number, x: number, usable: number, ink: Sky['ink'], afterRows: boolean): Block {
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
    const gap = (afterRows ? 5 : 7) * u;
    return {
        h: gap + size * CAP + (lines.length - 1) * lh,
        draw: (top) => {
            const base = top + gap + size * CAP;
            return [bubble(x, base - size * CAP - (icon - size * CAP) / 2, icon, ink.body), ...lines.map((l, i) => text(tx, base + i * lh, l, size, 400, ink.head))];
        },
    };
}

/**
 * Two lines beside a numeral or a tick (x at their left edge), centred on its caps: the first in the
 * secondary size, the second quieter.
 */
function besideLines(x: number, top: number, capH: number, first: string, second: string, W: number, maxW: number, ink: Sky['ink']): string[] {
    const s1 = W * TYPE.secondary;
    const s2 = W * TYPE.quiet;
    const gap = W * 0.022;
    const h = s1 * CAP + (second ? gap + s2 * CAP : 0);
    const b1 = top + (capH - h) / 2 + s1 * CAP;
    const out = [text(x, b1, fit(first, s1, 600, maxW), s1, 600, ink.head)];
    if (second) out.push(text(x, b1 + gap + s2 * CAP, fit(second, s2, 400, maxW), s2, 400, ink.meta));
    return out;
}

/** The home picture's main block: the day's number with its words beside it, a tick when done, or the words alone. */
function homeHero(input: WallpaperInput, W: number, x: number, usable: number, ink: Sky['ink']): Block {
    const u = W / 100;
    const items = input.items;
    const N = W * TYPE.homeNumeral;
    const capH = N * CAP;
    if (items && items.length) {
        const open = items.filter((i) => !i.done).length;
        if (open) {
            const num = String(open);
            const nx = x - digitInset(num, N, 600);
            const nw = textWidth(num, N, 600, N * TRACK.numeral);
            const minutes = input.counts?.minutesLeft ?? 0;
            const second = minutes ? `about ${minutes} min` : kindWords(input.counts);
            const lx = nx + nw + 3 * u;
            return {
                h: capH,
                draw: (top) => [text(nx, top + capH, num, N, 600, ink.head, { track: TRACK.numeral }), ...besideLines(lx, top, capH, 'left today', second, W, x + usable - lx, ink)],
            };
        }
        // Done: a tick as tall as the numeral's caps.
        const tw = capH * 1.22;
        const lx = x + tw + 4 * u;
        return { h: capH, draw: (top) => [tick(x, top, tw, capH, N * 0.085, ink.head), ...besideLines(lx, top, capH, 'All done', 'Nothing left today', W, x + usable - lx, ink)] };
    }
    if (items) {
        // A free day: the words alone.
        const size = W * 0.07;
        return { h: size * CAP, draw: (top) => [text(x, top + size * CAP, 'A free day', size, 600, ink.head, { track: -0.02 })] };
    }
    // No items (an older caller): the headline and its lines, in the same sizes.
    const size = W * TYPE.lineMax;
    const second = W * TYPE.secondary;
    const headText = input.headline || (input.state === 'done' ? 'Done for today' : '');
    const head = headText ? wrapText(headText, size, 600, usable, 2, size * TRACK.line) : [];
    const body = input.lines.flatMap((l) => wrapText(l, second, 400, usable, 2)).slice(0, 3);
    const lh = size * 1.22;
    const bodyLh = second * 1.5;
    const headH = head.length ? size * CAP + (head.length - 1) * lh : 0;
    const h = headH + (body.length ? (head.length ? 3 * u : 0) + second * CAP + (body.length - 1) * bodyLh : 0);
    return {
        h,
        draw: (top) => {
            const out = head.map((l, i) => text(x, top + size * CAP + i * lh, l, size, 600, ink.head, { track: TRACK.line }));
            const b0 = top + headH + (head.length ? 3 * u : 0) + second * CAP;
            body.forEach((l, i) => out.push(text(x, b0 + i * bodyLh, l, second, 400, ink.body)));
            return out;
        },
    };
}

/**
 * The home picture: the backdrop (the sky of the day over its hills, or a style), and one block at
 * the left, above the dock: the date as a small eyebrow, the day's number with "left today" and the
 * time beside it, today's reminders still to come and the buddy's thought when there are any, then the
 * week's dots. Laid out in what the phone shows (its zoom), its bottom at 74 % of the height. No list
 * of the day's things (Ramin 11-16: on a phone the number is enough) and never the lock screen's line.
 */
export function drawWallpaper(input: WallpaperInput, width: number, height: number, theme: Theme): string {
    const W = width;
    const H = height;
    const look = lookOf(input, W, H, theme, 'home');
    const { defs, art } = look;
    const ink = look.ink;
    const u = W / 100;
    const x = W * 0.08;
    const usable = W - 2 * x;
    const quiet = W * TYPE.quiet;
    const week = input.week?.length === 7 ? input.week : null;
    const words: string[] = [...look.overlay];

    const hero = homeHero(input, W, x, usable, ink);
    const weekH = week ? weekHeight(W) : 0;
    const rem = reminderRows(input.reminders ?? [], W, x, usable, ink);
    const thought = insightRows(input.insight ?? '', W, x, usable, ink, rem.h > 0);
    let heroTop = H * 0.74 - weekH - (week ? 8 * u : 0) - thought.h - rem.h - hero.h;
    // Never up into the clock and the search bar.
    heroTop = Math.max(heroTop, H * 0.36);

    const eyebrow = (input.state === 'rest' ? `${input.date} · A light day` : input.date).toUpperCase();
    const ls = quiet * TRACK.caps;
    words.push(text(x, heroTop - 5 * u, fit(eyebrow, quiet, 500, usable, ls), quiet, 500, ink.meta, { track: TRACK.caps }));
    words.push(...hero.draw(heroTop));
    words.push(...rem.draw(heroTop + hero.h));
    words.push(...thought.draw(heroTop + hero.h + rem.h));
    if (week) words.push(...weekDots(week, x, heroTop + hero.h + rem.h + thought.h + 8 * u, W, ink));
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
    if (!items.length) {
        // A free day: one word in the lock picture's small ring, the words in the dial's.
        const small = numeralSize < W * 0.12;
        const size = small ? W * 0.058 : W * 0.056;
        return [text(cx, cy + (size * CAP) / 2, small ? 'Free' : 'A free day', size, 600, ink.head, { anchor: 'middle', track: -0.02 })];
    }
    if (!open) {
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
        text(cx, base + gap + quiet * CAP, label, quiet, 500, ink.body, { anchor: 'middle', track: TRACK.caps }),
    ];
}

/**
 * The rows under the main words, centred: the day in words (at `rowSize`, the secondary size unless
 * given; quiet when it is too long for it) and the goal's days (quiet).
 */
function rowsUnder(input: WallpaperInput, W: number, firstGap: number, rowMax: number = W * TYPE.secondary): { h: number; draw: (top: number, cx: number, ink: Sky['ink']) => string[] } {
    const u = W / 100;
    const quiet = W * TYPE.quiet;
    const maxW = W * 0.84;
    const row = dayRow(input);
    const rowSize = textWidth(row, rowMax, 500) <= maxW ? rowMax : quiet;
    const goal = goalRow(input.goal);
    const rowH = row ? firstGap + rowSize * CAP : 0;
    const goalH = goal ? (row ? 3.5 * u : firstGap) + quiet * CAP : 0;
    return {
        h: rowH + goalH,
        draw: (top, cx, ink) => {
            const out: string[] = [];
            let y = top;
            if (row) {
                y += rowH;
                out.push(text(cx, y, fit(row, rowSize, 500, maxW), rowSize, 500, ink.body, { anchor: 'middle' }));
            }
            if (goal) {
                y += goalH;
                out.push(text(cx, y, fit(goal, quiet, 400, maxW), quiet, 400, ink.meta, { anchor: 'middle' }));
            }
            return out;
        },
    };
}

/** A soft light behind the words (in the style's colour, or dark under the words on a bright backdrop). */
function softLight(defs: string[], look: Look, cx: number, cy: number, rx: number, ry: number, id: string, strength = 1): string[] {
    if (!look.glow || look.glowAlpha <= 0) return [];
    const a = Math.min(0.6, look.glowAlpha * strength);
    defs.push(`<radialGradient id="${id}"><stop offset="0" stop-color="${look.glow}" stop-opacity="${a}"/><stop offset="0.5" stop-color="${look.glow}" stop-opacity="${r1(a * 0.4 * 100) / 100}"/><stop offset="1" stop-color="${look.glow}" stop-opacity="0"/></radialGradient>`);
    return [`<ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(rx)}" ry="${r1(ry)}" fill="url(#${id})"/>`];
}

/**
 * The lock picture (B4; Ramin 11-16: "a whole circle like initially, not half"; B8: one type system):
 * the ring of the day with what is left inside it, the buddy's line under it as the main words, then
 * one row of the day in words and the goal's days, quieter. The group is centred in the calm band
 * between the clock and the fingerprint. Without a line (the buddy off, or no line passed its lock
 * check): the dial.
 */
export function drawLock(input: WallpaperInput, width: number, height: number, theme: Theme): string {
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

    // The line: as large as fits three balanced lines (below the usual size only when it must).
    const weight: Weight = look.lineWeight >= 550 ? 600 : 500;
    const usable = W * 0.8 * (look.lineWeight >= 650 ? 0.95 : 1); // Bold is measured as SemiBold, with room for its width
    let size: number = W * TYPE.lineMax;
    let lines: string[] = [];
    for (; ; size -= W * 0.002) {
        lines = wrapText(main, size, weight, usable, 99, size * TRACK.line);
        if (lines.length <= 3 || size <= W * TYPE.lineFloor) break;
    }
    lines = lines.slice(0, 3);
    const lh = size * 1.22;
    const lineH = size * CAP + (lines.length - 1) * lh;

    const R = W * 0.135;
    const stroke = Math.max(3, W * (look.ring.stroke ?? 0.017) * 0.8);
    const reach = ringReach(R, stroke, look.ring);
    const ringH = withRing ? 2 * reach + 8 * u : 0;
    const rows = rowsUnder(input, W, 7 * u);
    const band = input.iconSlot ? iconBand(W) : 0;
    const groupH = ringH + lineH + rows.h + band;
    // A little above the middle (the clock sits higher than the fingerprint); never up into the clock.
    const top = Math.max(H * 0.3, H * 0.49 - groupH / 2);

    const words: string[] = [...softLight(defs, look, cx, top + groupH / 2, W * 0.64, Math.max(W * 0.5, groupH * 0.75), 'lineGlow'), ...look.overlay];
    if (withRing) {
        const cy = top + reach;
        words.push(...dayRing(input.items ?? [], cx, cy, R, stroke, look.ring.lit, look.ring.dim, look.ring));
        words.push(...ringCentre(input, cx, cy, W, W * TYPE.ringNumeral, 'LEFT', ink));
    }
    const lineTop = top + ringH;
    lines.forEach((l, i) => words.push(text(cx, lineTop + size * CAP + i * lh, l, size, look.lineWeight, ink.head, { anchor: 'middle', track: TRACK.line })));
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
    const next = items.find((i) => !i.done);

    const R = W * 0.2;
    const stroke = Math.max(4, W * Math.max(0.009, (look.ring.stroke ?? 0.017) * 1.15));
    const reach = ringReach(R, stroke, look.ring);
    // The next step, in up to two balanced lines (secondary size).
    const second = W * TYPE.secondary;
    const nextLines = next ? wrapText(`Next · ${next.title}${next.meta ? ` · ${next.meta}` : ''}`, second, 500, W * 0.8, 2) : [];
    const nextLh = second * 1.32;
    const nextH = nextLines.length ? 8 * u + second * CAP + (nextLines.length - 1) * nextLh : 0;
    // Under the next step the day's row is quiet (one secondary line is enough).
    const rows = rowsUnder(input, W, nextLines.length ? 5 * u : 8 * u, nextLines.length ? W * TYPE.quiet : second);
    const band = input.iconSlot ? iconBand(W) : 0;
    const groupH = 2 * reach + nextH + rows.h + band;
    const top = Math.max(H * 0.3, H * 0.49 - groupH / 2);
    const cy = top + reach;

    const words: string[] = [...softLight(defs, look, cx, cy, R * 2.3, R * 2.3, 'dialGlow', 1.3), ...look.overlay];
    words.push(...dayRing(items, cx, cy, R, stroke, look.ring.lit, look.ring.dim, look.ring));
    words.push(...ringCentre(input, cx, cy, W, W * TYPE.dialNumeral, 'LEFT TODAY', ink, true));
    let y = top + 2 * reach;
    if (nextLines.length) {
        y += 8 * u + second * CAP;
        nextLines.forEach((l, i) => words.push(text(cx, y + i * nextLh, l, second, 500, ink.head, { anchor: 'middle' })));
        y += (nextLines.length - 1) * nextLh;
    }
    words.push(...rows.draw(y, cx, ink));
    return picture(W, H, defs, art, words, input.zoom, input.iconSlot ? iconSlotAt(y + rows.h, W, ink.body) : undefined);
}
