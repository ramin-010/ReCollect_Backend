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
 * The wallpaper. Areas, as fractions of the height: the clock and the phone's own date up to ~0.30,
 * notifications below it, the day's lines ending at ~0.74 (above the fingerprint and the shortcuts),
 * the horizon from ~0.78. Text sits on a calm part of the sky; nothing important is under the clock.
 */
export function drawWallpaper(input: WallpaperInput, width: number, height: number, theme: Theme): string {
    const W = width;
    const H = height;
    const sky = SKIES[input.state][theme];
    const rand = seeded(`${input.date}|${input.state}`);
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
            const y = Math.pow(rand(), 1.6) * H * 0.7;
            const big = rand() > 0.9;
            art.push(`<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1((big ? 2.6 : 1.3 + rand()) * (W / 1080))}" fill="#FFFFFF" opacity="${r1((0.25 + rand() * 0.6) * 100) / 100}"/>`);
        }
    }

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

    // Film grain over everything: fine, faint noise (it also hides gradient banding on AMOLED screens).
    // One small tile repeated, so the noise is worked out once, not for every pixel of the screen.
    const tile = 240;
    defs.push(`<filter id="grain" x="0" y="0" width="${tile}" height="${tile}" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${Math.floor(rand() * 1000)}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>`);
    defs.push(`<pattern id="grainTile" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse"><rect width="${tile}" height="${tile}" filter="url(#grain)"/></pattern>`);
    art.push(`<rect width="${W}" height="${H}" fill="url(#grainTile)" opacity="${sky.grain}"/>`);

    // ── The words ─────────────────────────────────────────────────────────────────────
    const ink = sky.ink;
    const font = `font-family="Inter"`;
    const x = Math.round(W * 0.08);
    const usable = W - 2 * x;
    const tagSize = Math.round(W * 0.03);
    const bodySize = Math.round(W * 0.04);
    const dateSize = Math.round(W * 0.031);
    // The headline as large as it can be in up to three lines (6.8 % of the width, down to 5.6 %).
    let headSize = Math.round(W * 0.068);
    let head: string[] = [];
    if (input.state !== 'done' && input.headline) {
        for (let size = headSize; size >= Math.round(W * 0.056); size -= Math.max(1, Math.round(W * 0.003))) {
            headSize = size;
            head = wrapText(input.headline, size, 600, usable, 99, -size * 0.02);
            if (head.length <= 3) break;
        }
        head = head.slice(0, 3);
    }
    const body = input.state === 'done' ? [] : input.lines.flatMap((l) => wrapText(l, bodySize, 400, usable, 2)).slice(0, 3);
    const week = input.week?.length === 7 ? input.week : null;

    // Heights of each part, to set the block's bottom at ~74 % of the screen.
    const tagH = Math.round(tagSize * 2.1);
    const headLH = Math.round(headSize * 1.14);
    const bodyLH = Math.round(bodySize * 1.42);
    const weekH = week ? Math.round(W * 0.075) : 0;
    const gapAfterTag = Math.round(W * 0.045);
    const gapAfterHead = head.length && body.length ? Math.round(W * 0.028) : 0;
    const gapBeforeWeek = week ? Math.round(W * 0.06) : 0;
    const blockH = tagH + (head.length ? gapAfterTag + head.length * headLH : 0) + gapAfterHead + body.length * bodyLH + gapBeforeWeek + weekH;
    let y = Math.round(H * 0.74 - blockH);
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
        // The last seven days as dots (filled: studied), each with its weekday's letter under it.
        y += gapBeforeWeek;
        const dot = W * 0.0105;
        const step = W * 0.052;
        const letters = 'SMTWTFS';
        week.forEach((d, i) => {
            const cx = x + dot * 1.75 + i * step;
            const isToday = i === 6;
            const fill = d.active ? ink.dotOn : 'none';
            const stroke = d.active ? 'none' : ink.dotOff;
            words.push(`<circle cx="${r1(cx)}" cy="${r1(y + dot)}" r="${r1(dot)}" fill="${fill}" stroke="${stroke}" stroke-width="${r1(W / 400)}"/>`);
            if (isToday) words.push(`<circle cx="${r1(cx)}" cy="${r1(y + dot)}" r="${r1(dot * 1.75)}" fill="none" stroke="${ink.dotOff}" stroke-width="${r1(W / 540)}"/>`);
            const weekday = new Date(`${d.day}T12:00:00Z`).getUTCDay();
            words.push(`<text x="${r1(cx)}" y="${r1(y + dot * 2 + W * 0.04)}" text-anchor="middle" ${font} font-size="${Math.round(W * 0.022)}" font-weight="500" fill="${ink.meta}">${letters[weekday] ?? ''}</text>`);
        });
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs.join('')}</defs>${art.join('')}${words.join('')}</svg>`;
}
