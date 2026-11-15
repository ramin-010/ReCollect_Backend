// The wallpaper's picture (ANDROID_APP_SPEC; Ramin 11-15: "the wallpaper has to be great, not a plain
// background with text"). One idea: the sky of your day. Its light follows the day's state: dawn in
// the morning, daylight while working, dusk in the evening, a starry night when the day is done, a
// soft mist on a light day. Soft colour fields over a horizon of hills, fine film grain (it also
// keeps the gradients from banding), the day's lines set in Inter, and the last seven days as dots.
// Every day draws a slightly different sky (the date seeds the shapes). Pure: SVG text in, out.
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
    /** Today's things (open first): the home picture lists them; the lock picture's dial is made of them. */
    items?: Array<{ kind: 'review' | 'focus' | 'task'; title: string; meta: string; done: boolean }>;
    counts?: { reviews: { done: number; total: number }; focus: { done: number; total: number }; tasks: { done: number; total: number }; minutesLeft: number };
    goal?: { title: string; daysLeft: number; done: number; total: number } | null;
    /**
     * The buddy's line for now (BUDDY_MEMORY_PLAN §3.4): the lock picture's main words. Only a line
     * the lock check passed; without one the lock picture says the day in plain words.
     */
    line?: string | null;
    /** The lock picture's day mark: a thin arc of the day over the line (default), or none. */
    dayMark?: 'arc' | 'none';
}

// ── Tiny icons (24-unit paths in lucide's style: 2-unit strokes, round ends) ─────────────────

type IconName = 'review' | 'focus' | 'task' | 'goal';
const ICONS: Record<IconName, string> = {
    review: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    focus: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    task: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/>',
    goal: '<path d="M4 22V4"/><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>',
};

/** An icon with its top-left corner at (x, y), `size` px square. */
function icon(name: IconName, x: number, y: number, size: number, color: string): string {
    return `<g transform="translate(${r1(x)} ${r1(y)}) scale(${r1((size / 24) * 1000) / 1000})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`;
}

/** Done: a filled circle with a tick, centred on (cx, cy). */
function doneMark(cx: number, cy: number, r: number, fill: string, tick: string): string {
    const s = r / 9;
    return `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="${fill}"/><path d="M${r1(cx - 4 * s)} ${r1(cy + 0.3 * s)} L${r1(cx - 1.2 * s)} ${r1(cy + 3 * s)} L${r1(cx + 4.4 * s)} ${r1(cy - 3 * s)}" fill="none" stroke="${tick}" stroke-width="${r1(1.9 * s)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** `text` cut to fit `width` at `size`, with "…" when it had to be cut (a wallpaper can't wrap a list row). */
function fit(text: string, size: number, weight: Weight, width: number): string {
    if (textWidth(text, size, weight) <= width) return text;
    const chars = [...text];
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (textWidth(`${chars.slice(0, mid).join('').trimEnd()}…`, size, weight) <= width) lo = mid;
        else hi = mid - 1;
    }
    return `${chars.slice(0, lo).join('').trimEnd()}…`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The day in one line: what is left and about how long, or that it is done, or free. */
function dayLine(items: NonNullable<WallpaperInput['items']>, minutesLeft: number): string {
    const open = items.filter((i) => !i.done).length;
    if (!items.length) return 'A free day';
    if (!open) return 'All done for today';
    return `${open} left today${minutesLeft ? ` · about ${minutesLeft} min` : ''}`;
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

/** The word on the state's tag. */
const TAG: Record<SkyState, string> = { morning: 'Morning', working: 'Afternoon', evening: 'Evening', done: 'Done for today', rest: 'A light day' };

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

/** Film grain over everything: fine, faint noise (it also hides gradient banding on AMOLED screens), one small tile repeated. */
function grain(defs: string[], art: string[], W: number, H: number, amount: number, seed: number): void {
    const tile = 240;
    defs.push(`<filter id="grain" x="0" y="0" width="${tile}" height="${tile}" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${seed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>`);
    defs.push(`<pattern id="grainTile" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse"><rect width="${tile}" height="${tile}" filter="url(#grain)"/></pattern>`);
    art.push(`<rect width="${W}" height="${H}" fill="url(#grainTile)" opacity="${amount}"/>`);
}

/** The last seven days as dots (filled: studied), each with its weekday's letter under it; `cx0` is the first dot's centre. */
function weekDots(week: NonNullable<WallpaperInput['week']>, cx0: number, y: number, W: number, ink: Sky['ink']): string[] {
    const out: string[] = [];
    const dot = W * 0.0105;
    const step = W * 0.052;
    const letters = 'SMTWTFS';
    const font = `font-family="Inter"`;
    week.forEach((d, i) => {
        const cx = cx0 + i * step;
        const fill = d.active ? ink.dotOn : 'none';
        const stroke = d.active ? 'none' : ink.dotOff;
        out.push(`<circle cx="${r1(cx)}" cy="${r1(y + dot)}" r="${r1(dot)}" fill="${fill}" stroke="${stroke}" stroke-width="${r1(W / 400)}"/>`);
        if (i === 6) out.push(`<circle cx="${r1(cx)}" cy="${r1(y + dot)}" r="${r1(dot * 1.75)}" fill="none" stroke="${ink.dotOff}" stroke-width="${r1(W / 540)}"/>`);
        const weekday = new Date(`${d.day}T12:00:00Z`).getUTCDay();
        out.push(`<text x="${r1(cx)}" y="${r1(y + dot * 2 + W * 0.04)}" text-anchor="middle" ${font} font-size="${Math.round(W * 0.022)}" font-weight="500" fill="${ink.meta}">${letters[weekday] ?? ''}</text>`);
    });
    return out;
}

/**
 * The home picture: the sky of the day over its hills, and the day's own list. Areas, as fractions
 * of the height: the phone's clock and widgets up to ~0.30, the day's words ending at ~0.74 (above
 * the dock), the horizon from ~0.78. With today's items it lists them (an icon for each kind, a tick
 * on what is done); without, it sets the headline and lines.
 */
export function drawWallpaper(input: WallpaperInput, width: number, height: number, theme: Theme): string {
    const W = width;
    const H = height;
    const sky = SKIES[input.state][theme];
    const { defs, art, rand } = drawSky(input.state, input.date, W, H, theme, true);
    grain(defs, art, W, H, sky.grain, Math.floor(rand() * 1000));

    const ink = sky.ink;
    const font = `font-family="Inter"`;
    const x = Math.round(W * 0.08);
    const usable = W - 2 * x;
    const tagSize = Math.round(W * 0.03);
    const bodySize = Math.round(W * 0.04);
    const dateSize = Math.round(W * 0.031);
    const week = input.week?.length === 7 ? input.week : null;
    const items = input.items;

    // The headline: the day in numbers (no list: on a phone the number is enough), else the state's own headline.
    const headText = items ? dayLine(items, input.counts?.minutesLeft ?? 0) : input.state === 'done' ? '' : input.headline;
    const maxHead = items ? Math.round(W * 0.058) : Math.round(W * 0.068);
    const minHead = items ? Math.round(W * 0.05) : Math.round(W * 0.056);
    const maxHeadLines = items ? 2 : 3;
    let headSize = maxHead;
    let head: string[] = [];
    if (headText) {
        for (let size = maxHead; size >= minHead; size -= Math.max(1, Math.round(W * 0.003))) {
            headSize = size;
            head = wrapText(headText, size, 600, usable, 99, -size * 0.02);
            if (head.length <= maxHeadLines) break;
        }
        head = head.slice(0, maxHeadLines);
    }
    const body = items || input.state === 'done' ? [] : input.lines.flatMap((l) => wrapText(l, bodySize, 400, usable, 2)).slice(0, 3);

    // Heights, to set the block's bottom at ~74 % of the screen and its top no higher than ~34 %.
    const tagH = Math.round(tagSize * 2.1);
    const headLH = Math.round(headSize * 1.14);
    const bodyLH = Math.round(bodySize * 1.42);
    const weekH = week ? Math.round(W * 0.075) : 0;
    const gapAfterTag = Math.round(W * 0.045);
    const gapAfterHead = head.length && (body.length || items?.length) ? Math.round(W * 0.034) : 0;
    const gapBeforeWeek = week ? Math.round(W * 0.06) : 0;
    const fixedH = tagH + (head.length ? gapAfterTag + head.length * headLH : 0) + gapAfterHead + body.length * bodyLH + gapBeforeWeek + weekH;
    let y = Math.round(H * 0.74 - fixedH);
    y = Math.max(y, Math.round(H * 0.34));

    const words: string[] = [];
    // The state's tag, then the date beside it.
    const tagText = TAG[input.state];
    const tagPad = Math.round(tagSize * 0.8);
    const tagW = Math.round(textWidth(tagText, tagSize, 500) + tagPad * 2);
    const baseline = y + Math.round(tagH / 2 + tagSize * 0.36);
    words.push(`<rect x="${x}" y="${y}" width="${tagW}" height="${tagH}" rx="${tagH / 2}" fill="${ink.tag}" stroke="${ink.tagRing}" stroke-width="${r1(W / 540)}"/>`);
    words.push(`<text x="${x + tagPad}" y="${baseline}" ${font} font-size="${tagSize}" font-weight="500" fill="${ink.tagInk}">${esc(tagText)}</text>`);
    words.push(`<text x="${x + tagW + Math.round(tagSize * 0.7)}" y="${baseline}" ${font} font-size="${dateSize}" font-weight="400" fill="${ink.meta}">${esc(input.date)}</text>`);
    y += tagH;
    if (head.length) {
        y += gapAfterTag;
        for (const line of head) {
            y += headLH;
            words.push(`<text x="${x}" y="${y - Math.round(headLH * 0.22)}" ${font} font-size="${headSize}" font-weight="600" letter-spacing="${r1(-headSize * 0.02)}" fill="${ink.head}">${esc(line)}</text>`);
        }
    }
    y += gapAfterHead;
    for (const line of body) {
        y += bodyLH;
        words.push(`<text x="${x}" y="${y - Math.round(bodyLH * 0.26)}" ${font} font-size="${bodySize}" font-weight="400" fill="${ink.body}">${esc(line)}</text>`);
    }
    if (week) {
        y += gapBeforeWeek;
        words.push(...weekDots(week, x + W * 0.0105 * 1.75, y, W, ink));
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs.join('')}</defs>${art.join('')}${words.join('')}</svg>`;
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
 * The lock picture (B4, BUDDY_MEMORY_PLAN §3.4): the buddy's line is the main thing, centred in the
 * calm band between the clock and the fingerprint, as large as fits in three balanced lines; over it
 * a thin arc of the day (lit as far as the day's things are done; or no mark); under it, small, the
 * day in numbers with tiny icons and the goal's days. The open sky behind it, no horizon. Without a
 * line it says the day in plain words.
 */
export function drawLock(input: WallpaperInput, width: number, height: number, theme: Theme): string {
    const W = width;
    const H = height;
    const sky = SKIES[input.state][theme];
    const { defs, art, rand } = drawSky(input.state, input.date, W, H, theme, false, '|lock');
    const ink = sky.ink;
    const font = `font-family="Inter"`;
    const cx = W / 2;
    const items = input.items ?? [];
    const open = items.filter((i) => !i.done);
    const total = items.length;
    const glow = sky.light?.halo ?? sky.glows[0]?.color ?? '#FFFFFF';
    const cy = Math.round(H * 0.47);
    defs.push(`<radialGradient id="lineGlow"><stop offset="0" stop-color="${glow}" stop-opacity="${theme === 'dark' ? 0.26 : 0.4}"/><stop offset="0.5" stop-color="${glow}" stop-opacity="${theme === 'dark' ? 0.1 : 0.16}"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>`);
    art.push(`<ellipse cx="${cx}" cy="${cy}" rx="${r1(W * 0.62)}" ry="${r1(W * 0.5)}" fill="url(#lineGlow)"/>`);
    grain(defs, art, W, H, sky.grain, Math.floor(rand() * 1000));

    const words: string[] = [];
    const minutes = input.counts?.minutesLeft ?? 0;
    const plain = total === 0 ? 'A free day' : open.length === 0 ? 'Done for today' : `${open.length} left today${minutes ? ` · about ${minutes} min` : ''}`;
    const main = (input.line ?? '').trim() || plain;

    // The line: as large as fits in three balanced lines.
    const usable = W * 0.8;
    let size = Math.round(W * 0.066);
    let lines: string[] = [];
    for (; size >= Math.round(W * 0.046); size -= Math.max(1, Math.round(W * 0.003))) {
        lines = wrapText(main, size, 600, usable, 99, -size * 0.015);
        if (lines.length <= 3) break;
    }
    lines = lines.slice(0, 3);
    const lh = Math.round(size * 1.2);
    const blockH = lines.length * lh;
    let y = cy - blockH / 2;

    // The day's mark: a thin arc over the line, lit as far as the day's things are done.
    if ((input.dayMark ?? 'arc') === 'arc' && total > 0) {
        const r = W * 0.16;
        // The arc's ends sit half a radius below its top: keep them clear of the first line.
        const ay = y - r * 0.5 - W * 0.05;
        const stroke = Math.max(3, Math.round(W * 0.008));
        const a0 = -60;
        const a1 = 60;
        const share = (total - open.length) / total;
        words.push(`<path d="${arc(cx, ay + r, r, a0, a1)}" fill="none" stroke="${ink.dotOff}" stroke-width="${stroke}" stroke-linecap="round"/>`);
        if (share > 0) words.push(`<path d="${arc(cx, ay + r, r, a0, Math.max(a0 + 1, a0 + (a1 - a0) * share))}" fill="none" stroke="${ink.head}" stroke-width="${stroke}" stroke-linecap="round"/>`);
    }
    lines.forEach((line, i) => {
        words.push(`<text x="${cx}" y="${r1(y + (i + 1) * lh - lh * 0.24)}" text-anchor="middle" ${font} font-size="${size}" font-weight="600" letter-spacing="${r1(-size * 0.015)}" fill="${ink.head}">${esc(line)}</text>`);
    });
    y += blockH + W * 0.075;

    // Under it, small: the day in numbers with tiny icons (only when the line isn't already that).
    const c = input.counts;
    const chips = c && main !== plain
        ? ([
              ['review', c.reviews],
              ['focus', c.focus],
              ['task', c.tasks],
          ] as const).filter(([, n]) => n.total > 0)
        : [];
    if (chips.length) {
        const iconSize = Math.round(W * 0.036);
        const textSize = Math.round(W * 0.031);
        const inner = W * 0.016;
        const between = W * 0.06;
        const parts = chips.map(([kind, n]) => ({ kind, text: n.done === n.total ? 'done' : `${n.total - n.done} left`, all: n.done === n.total }));
        if (minutes) parts.push({ kind: 'review' as const, text: `about ${minutes} min`, all: false });
        const widths = parts.map((p, i) => (i === parts.length - 1 && minutes ? 0 : iconSize + inner) + textWidth(p.text, textSize, 500));
        let x = cx - (widths.reduce((a, b) => a + b, 0) + between * (parts.length - 1)) / 2;
        parts.forEach((p, i) => {
            const isMinutes = i === parts.length - 1 && minutes > 0;
            if (!isMinutes) words.push(icon(p.kind, x, y - iconSize / 2, iconSize, p.all ? ink.head : ink.body));
            words.push(`<text x="${r1(x + (isMinutes ? 0 : iconSize + inner))}" y="${r1(y + textSize * 0.36)}" ${font} font-size="${textSize}" font-weight="500" fill="${p.all ? ink.head : ink.body}">${esc(p.text)}</text>`);
            x += (widths[i] ?? 0) + between;
        });
        y += W * 0.075;
    }

    // The goal's days, quiet.
    const g = input.goal;
    if (g && y < H * 0.76) {
        const size2 = Math.round(W * 0.029);
        const flag = Math.round(W * 0.03);
        const days = g.daysLeft >= 0 ? `${plural(g.daysLeft, 'day')} to ${g.title}` : `${g.title}: past its date`;
        const text = fit(days, size2, 500, W * 0.74);
        const tw = textWidth(text, size2, 500) + flag + W * 0.016;
        const x0 = cx - tw / 2;
        words.push(icon('goal', x0, y - flag * 0.78, flag, ink.meta));
        words.push(`<text x="${r1(x0 + flag + W * 0.016)}" y="${r1(y)}" ${font} font-size="${size2}" font-weight="500" fill="${ink.meta}">${esc(text)}</text>`);
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs.join('')}</defs>${art.join('')}${words.join('')}</svg>`;
}

/** The dial of the day (11-15 night): kept for the gallery's comparison, not drawn for the phone any more. */
export function drawDial(input: WallpaperInput, width: number, height: number, theme: Theme): string {
    const W = width;
    const H = height;
    const sky = SKIES[input.state][theme];
    const { defs, art, rand } = drawSky(input.state, input.date, W, H, theme, false, '|lock');
    const ink = sky.ink;
    const font = `font-family="Inter"`;
    const cx = W / 2;
    const items = input.items ?? [];
    const open = items.filter((i) => !i.done);
    const total = items.length;

    // The dial's light: a soft halo behind the ring, in the state's light (the sun of this sky).
    const R = Math.round(W * 0.215);
    const stroke = Math.round(W * 0.024);
    const cy = Math.round(H * 0.455);
    const glow = sky.light?.halo ?? sky.glows[0]?.color ?? '#FFFFFF';
    defs.push(`<radialGradient id="dialGlow"><stop offset="0" stop-color="${glow}" stop-opacity="${theme === 'dark' ? 0.34 : 0.5}"/><stop offset="0.45" stop-color="${glow}" stop-opacity="${theme === 'dark' ? 0.14 : 0.22}"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>`);
    art.push(`<circle cx="${cx}" cy="${cy}" r="${r1(R * 2.3)}" fill="url(#dialGlow)"/>`);
    grain(defs, art, W, H, sky.grain, Math.floor(rand() * 1000));

    const words: string[] = [];
    const lit = ink.head;
    const dim = ink.dotOff;
    // The ring: one segment per thing (done ones first, so the lit part grows clockwise from the top);
    // past sixteen it is one arc, lit as far as the day has come.
    if (total === 0) {
        words.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${dim}" stroke-width="${stroke}"/>`);
    } else if (total > 16) {
        const share = (total - open.length) / total;
        words.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${dim}" stroke-width="${stroke}"/>`);
        if (share > 0) words.push(`<path d="${arc(cx, cy, R, 0, Math.max(1, share * 359.9))}" fill="none" stroke="${lit}" stroke-width="${stroke}" stroke-linecap="round"/>`);
    } else {
        const seg = 360 / total;
        // Round ends reach half a stroke past each end: the visible gap stays about one stroke wide.
        const capDeg = (stroke / 2 / R) * (180 / Math.PI);
        const gap = total > 1 ? Math.min(seg * 0.45, 2 * capDeg + (stroke / R) * (180 / Math.PI) * 0.9) : 0;
        const ordered = [...items.filter((i) => i.done), ...open];
        ordered.forEach((it, i) => {
            const a0 = i * seg + gap / 2;
            const a1 = (i + 1) * seg - gap / 2;
            if (total === 1) words.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${it.done ? lit : dim}" stroke-width="${stroke}"/>`);
            else words.push(`<path d="${arc(cx, cy, R, a0, Math.max(a0 + 0.5, a1))}" fill="none" stroke="${it.done ? lit : dim}" stroke-width="${stroke}" stroke-linecap="round"/>`);
        });
    }

    // Inside the ring: what is left (a big number), or a tick when the day is done, or a free day.
    const numSize = Math.round(W * 0.15);
    const labelSize = Math.round(W * 0.034);
    if (total > 0 && open.length === 0) {
        const s = W * 0.06;
        words.push(`<path d="M${r1(cx - s)} ${r1(cy - s * 0.05)} L${r1(cx - s * 0.3)} ${r1(cy + s * 0.62)} L${r1(cx + s * 1.02)} ${r1(cy - s * 0.66)}" fill="none" stroke="${lit}" stroke-width="${r1(W * 0.016)}" stroke-linecap="round" stroke-linejoin="round"/>`);
        words.push(`<text x="${cx}" y="${r1(cy + R * 0.58)}" text-anchor="middle" ${font} font-size="${labelSize}" font-weight="500" fill="${ink.meta}">Done for today</text>`);
    } else if (total === 0) {
        words.push(`<text x="${cx}" y="${r1(cy + W * 0.018)}" text-anchor="middle" ${font} font-size="${Math.round(W * 0.056)}" font-weight="600" letter-spacing="${r1(-W * 0.001)}" fill="${ink.head}">A free day</text>`);
    } else {
        const minutes = input.counts?.minutesLeft ?? 0;
        const numBase = cy + numSize * 0.2 - (minutes ? W * 0.02 : 0);
        words.push(`<text x="${cx}" y="${r1(numBase)}" text-anchor="middle" ${font} font-size="${numSize}" font-weight="600" letter-spacing="${r1(-numSize * 0.03)}" fill="${ink.head}">${open.length}</text>`);
        words.push(`<text x="${cx}" y="${r1(numBase + W * 0.062)}" text-anchor="middle" ${font} font-size="${labelSize}" font-weight="500" fill="${ink.body}">left today</text>`);
        if (minutes) words.push(`<text x="${cx}" y="${r1(numBase + W * 0.108)}" text-anchor="middle" ${font} font-size="${Math.round(W * 0.03)}" font-weight="400" fill="${ink.meta}">about ${minutes} min</text>`);
    }

    // Under the ring: the counts as tiny icons ("2 of 5" by a book for the reviews, and so on).
    let y = cy + R + stroke / 2 + W * 0.085;
    const c = input.counts;
    const chips = c
        ? ([
              ['review', c.reviews],
              ['focus', c.focus],
              ['task', c.tasks],
          ] as const).filter(([, n]) => n.total > 0)
        : [];
    if (chips.length) {
        const iconSize = Math.round(W * 0.04);
        const textSize = Math.round(W * 0.034);
        const inner = W * 0.018;
        const between = W * 0.065;
        const parts = chips.map(([kind, n]) => ({ kind, text: `${n.done} of ${n.total}`, all: n.done === n.total }));
        const widths = parts.map((p) => iconSize + inner + textWidth(p.text, textSize, 500));
        let x = cx - (widths.reduce((a, b) => a + b, 0) + between * (parts.length - 1)) / 2;
        parts.forEach((p, i) => {
            words.push(icon(p.kind, x, y - iconSize / 2, iconSize, p.all ? ink.head : ink.body));
            words.push(`<text x="${r1(x + iconSize + inner)}" y="${r1(y + textSize * 0.36)}" ${font} font-size="${textSize}" font-weight="500" fill="${p.all ? ink.head : ink.body}">${esc(p.text)}</text>`);
            x += (widths[i] ?? 0) + between;
        });
        y += W * 0.1;
    }

    // The next step, in up to two balanced lines.
    const next = open[0];
    if (next) {
        const size = Math.round(W * 0.038);
        const lines = wrapText(`Next · ${next.title}${next.meta ? ` · ${next.meta}` : ''}`, size, 500, W * 0.78, 2);
        lines.forEach((line, i) => {
            words.push(`<text x="${cx}" y="${r1(y + i * size * 1.32)}" text-anchor="middle" ${font} font-size="${size}" font-weight="500" fill="${ink.head}">${esc(line)}</text>`);
        });
        y += size * 1.32 * lines.length + W * 0.045;
    }

    // The goal: a flag and its name (whole, in up to two balanced lines), the days left and its
    // milestones in words, and a thin bar for them. The reason behind the day, kept quiet.
    const g = input.goal;
    if (g && y < H * 0.77) {
        const size = Math.round(W * 0.031);
        const flag = Math.round(W * 0.032);
        const gapX = W * 0.018;
        const name = wrapText(g.title, size, 500, W * 0.7, 2);
        name.forEach((line, i) => {
            const lw = textWidth(line, size, 500) + (i === 0 ? flag + gapX : 0);
            const x0 = cx - lw / 2;
            if (i === 0) words.push(icon('goal', x0, y - flag * 0.8, flag, ink.body));
            words.push(`<text x="${r1(i === 0 ? x0 + flag + gapX : x0)}" y="${r1(y)}" ${font} font-size="${size}" font-weight="500" fill="${ink.body}">${esc(line)}</text>`);
            y += size * 1.34;
        });
        const days = g.daysLeft >= 0 ? `${plural(g.daysLeft, 'day')} left` : 'Past its date';
        const facts = g.total > 0 ? `${days} · ${g.done} of ${g.total} milestones` : days;
        words.push(`<text x="${cx}" y="${r1(y)}" text-anchor="middle" ${font} font-size="${Math.round(W * 0.029)}" font-weight="400" fill="${ink.meta}">${esc(facts)}</text>`);
        if (g.total > 0) {
            const barW = W * 0.34;
            const barH = Math.max(3, Math.round(W * 0.007));
            const by = y + W * 0.03;
            words.push(`<rect x="${r1(cx - barW / 2)}" y="${r1(by)}" width="${r1(barW)}" height="${barH}" rx="${barH / 2}" fill="${dim}"/>`);
            if (g.done > 0) words.push(`<rect x="${r1(cx - barW / 2)}" y="${r1(by)}" width="${r1(Math.max(barH, (barW * Math.min(g.done, g.total)) / g.total))}" height="${barH}" rx="${barH / 2}" fill="${lit}"/>`);
        }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs.join('')}</defs>${art.join('')}${words.join('')}</svg>`;
}
