// The phone pictures' styles (the owner, 11-16: "more concepts", then "only one or two were good; take
// references; dark ones only"): a small set of dark concepts after the looks wallpapers use now (a grainy
// light, a layered night landscape, a glass orb, a dot-matrix screen, a silk ribbon of lines). Each style draws only the backdrop and says its inks and its ring's
// look; the lock and home pictures keep one layout (wallpaperArt.ts), so the words sit in the same calm
// band in every style. Pure SVG strings, drawn by resvg with Inter; seeded by the date, so each day's
// picture differs a little and the same day always looks the same.

export type StyleTheme = 'light' | 'dark';
export type StyleScreen = 'lock' | 'home';
type Kind = 'review' | 'focus' | 'task';

export interface Ink {
    head: string;
    body: string;
    meta: string;
    tag: string;
    tagInk: string;
    tagRing: string;
    dotOn: string;
    dotOff: string;
}

export interface RingLook {
    lit: string;
    dim: string;
    /** The stroke as a share of the width (default 0.017). */
    stroke?: number;
    /** A watch dial: sixty ticks around the ring, lit as far as the day is done. */
    ticks?: boolean;
    /** Round dots on the circle, lit as far as the day is done (a dot-matrix ring). */
    dotted?: boolean;
    /** A soft light under the lit segments. */
    glow?: boolean;
}

export interface StyleLook {
    defs: string[];
    /** The backdrop: drawn whole, at the picture's size (the phone's zoom enlarges it). */
    art: string[];
    /**
     * Marks that belong with the words (a frame, an accent under the clock): drawn with them, for the
     * phone's zoom, so they keep their place and their margins.
     */
    overlay: string[];
    ink: Ink;
    /** The soft light behind the words (null: none), and how strong. */
    glow: string | null;
    glowAlpha: number;
    ring: RingLook;
    /** The line's weight (Inter 400-700). */
    lineWeight: number;
}

export interface StyleColor {
    id: string;
    name: string;
    /** For the app's chips. */
    swatch: string;
}

export interface StyleInfo {
    id: string;
    name: string;
    blurb: string;
    colors: StyleColor[];
}

interface Ctx {
    W: number;
    H: number;
    theme: StyleTheme;
    screen: StyleScreen;
    date: string;
    state: string;
    items: Array<{ kind: Kind; done: boolean }>;
}

// ── Small helpers (kept here: this file draws on its own) ─────────────────────────────────────

const r1 = (n: number) => Math.round(n * 10) / 10;

function rng(text: string): () => number {
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

function hex(c: string): [number, number, number] {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** Mix two colours (t = 0: a, 1: b). */
function mix(a: string, b: string, t: number): string {
    const [r, g, bl] = hex(a);
    const [r2, g2, b2] = hex(b);
    return toHex(r + (r2 - r) * t, g + (g2 - g) * t, bl + (b2 - bl) * t);
}

function rgba(c: string, a: number): string {
    const [r, g, b] = hex(c);
    return `rgba(${r},${g},${b},${a})`;
}

/** Relative luminance (WCAG), to pick black or white words on a colour. */
function lum(c: string): number {
    const [r, g, b] = hex(c).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Inks for words on a ground: the ground's own contrast decides light or dark words. */
function inkOn(ground: string, accent?: string): Ink {
    const dark = lum(ground) > 0.36;
    const c = dark ? '#121212' : '#FFFFFF';
    return {
        head: c,
        body: rgba(c, 0.84),
        meta: rgba(c, 0.7),
        tag: rgba(dark ? '#FFFFFF' : '#000000', dark ? 0.5 : 0.22),
        tagInk: c,
        tagRing: rgba(c, 0.16),
        dotOn: accent ?? c,
        dotOff: rgba(c, 0.26),
    };
}

/** Fine film grain (as the sky's): one tile of noise repeated. */
function grainLayer(defs: string[], art: string[], W: number, H: number, amount: number, seed: number, id = 'sgrain'): void {
    const tile = 240;
    defs.push(`<filter id="${id}" x="0" y="0" width="${tile}" height="${tile}" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${seed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>`);
    defs.push(`<pattern id="${id}Tile" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse"><rect width="${tile}" height="${tile}" filter="url(#${id})"/></pattern>`);
    art.push(`<rect width="${W}" height="${H}" fill="url(#${id}Tile)" opacity="${amount}"/>`);
}

/** A soft round field of colour (a radial gradient that fades out). */
function blob(defs: string[], art: string[], id: string, x: number, y: number, r: number, color: string, alpha: number): void {
    defs.push(`<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${alpha}"/><stop offset="0.45" stop-color="${color}" stop-opacity="${r1(alpha * 0.55 * 100) / 100}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`);
    art.push(`<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(r)}" fill="url(#${id})"/>`);
}


// ── Aurora: deep night, slow colour lights (premium) ──────────────────────────────────────────

const AURORA: Array<StyleColor & { lights: [string, string, string] }> = [
    { id: 'borealis', name: 'Borealis', swatch: '#19E3B1', lights: ['#19E3B1', '#3B82F6', '#8B5CF6'] },
    { id: 'ember', name: 'Ember', swatch: '#FF6B35', lights: ['#FF6B35', '#F7258F', '#FFB627'] },
    { id: 'ocean', name: 'Ocean', swatch: '#00C2FF', lights: ['#00C2FF', '#2563EB', '#22D3EE'] },
    { id: 'orchid', name: 'Orchid', swatch: '#C026D3', lights: ['#C026D3', '#7C3AED', '#F472B6'] },
    { id: 'gold', name: 'Gold', swatch: '#F5B83D', lights: ['#F5B83D', '#D97706', '#FDE68A'] },
];

function aurora(c: Ctx, color: StyleColor): StyleLook {
    const { W, H } = c;
    const lights = (AURORA.find((a) => a.id === color.id) ?? AURORA[0]!).lights;
    const rand = rng(`${c.date}|aurora|${color.id}|${c.screen}`);
    const dark = true; // dark only (the owner, 11-16: "I prefer the darker wallpapers")
    const ground = dark ? '#06070D' : '#F6F6FA';
    const defs: string[] = [];
    const art: string[] = [`<rect width="${W}" height="${H}" fill="${ground}"/>`];
    const a = dark ? 0.78 : 0.5;
    // Curtains of light: wide fields high and low, one across the middle, faint.
    blob(defs, art, 'au0', W * (0.15 + rand() * 0.2), H * (0.1 + rand() * 0.08), W * 0.95, lights[0], a);
    blob(defs, art, 'au1', W * (0.75 + rand() * 0.2), H * (0.22 + rand() * 0.08), W * 0.8, lights[1], a * 0.9);
    blob(defs, art, 'au2', W * (0.2 + rand() * 0.6), H * (0.9 + rand() * 0.06), W * 1.05, lights[2], a * 0.85);
    blob(defs, art, 'au3', W * (0.8 + rand() * 0.15), H * (0.74 + rand() * 0.06), W * 0.6, lights[0], a * 0.55);
    blob(defs, art, 'au4', W * 0.5, H * 0.5, W * 0.9, lights[1], dark ? 0.16 : 0.12);
    // A soft vignette keeps the edges deep.
    defs.push(`<radialGradient id="auv" cx="0.5" cy="0.5" r="0.75"><stop offset="0.55" stop-color="${ground}" stop-opacity="0"/><stop offset="1" stop-color="${ground}" stop-opacity="${dark ? 0.7 : 0.35}"/></radialGradient>`);
    art.push(`<rect width="${W}" height="${H}" fill="url(#auv)"/>`);
    grainLayer(defs, art, W, H, dark ? 0.07 : 0.05, Math.floor(rand() * 1000));
    const ink = dark ? inkOn('#000000') : inkOn('#FFFFFF');
    return { defs, art, overlay: [], ink, glow: dark ? '#000000' : '#FFFFFF', glowAlpha: dark ? 0.35 : 0.5, ring: { lit: dark ? '#FFFFFF' : '#16161D', dim: dark ? 'rgba(255,255,255,0.18)' : 'rgba(22,22,29,0.16)', stroke: 0.011, glow: dark }, lineWeight: 500 };
}

// ── Mono: black or paper, a watch dial, one accent (sleek) ────────────────────────────────────

const MONO: StyleColor[] = [
    { id: 'orange', name: 'Orange', swatch: '#FF5A1F' },
    { id: 'lime', name: 'Lime', swatch: '#C8F031' },
    { id: 'blue', name: 'Blue', swatch: '#2F6BFF' },
    { id: 'red', name: 'Red', swatch: '#FF3B30' },
    { id: 'silver', name: 'Silver', swatch: '#A7A9AC' },
];

function mono(c: Ctx, color: StyleColor): StyleLook {
    const { W, H } = c;
    const dark = true; // dark only
    const ground = dark ? '#000000' : '#F2F1EE';
    const accent = color.id === 'lime' && !dark ? '#5E7D00' : color.id === 'silver' && !dark ? '#5D6066' : color.swatch;
    const defs: string[] = [];
    const art: string[] = [`<rect width="${W}" height="${H}" fill="${ground}"/>`];
    // Hairlines: a frame inset from the edges, a short rule under the clock's place (with the words: they keep their margins at any zoom).
    const ink = inkOn(ground, accent);
    const m = W * 0.06;
    const overlay = [
        `<rect x="${r1(m)}" y="${r1(m * 1.6)}" width="${r1(W - 2 * m)}" height="${r1(H - m * 3.2)}" rx="${r1(W * 0.06)}" fill="none" stroke="${ink.dotOff}" stroke-width="${r1(W / 720)}"/>`,
        ...(c.screen === 'lock' ? [`<rect x="${r1(W / 2 - W * 0.03)}" y="${r1(H * 0.26)}" width="${r1(W * 0.06)}" height="${r1(W * 0.004)}" fill="${accent}"/>`] : []),
    ];
    return { defs, art, overlay, ink: { ...ink, head: dark ? '#FFFFFF' : '#0E0E0E' }, glow: null, glowAlpha: 0, ring: { lit: accent, dim: ink.dotOff, stroke: 0.006, ticks: true }, lineWeight: 500 };
}

// ── Glow: one luminous light rising out of the dark, with film grain (the grainy-gradient look) ──

const GLOW: Array<StyleColor & { hot: string; core: string; edge: string }> = [
    { id: 'ember', name: 'Ember', swatch: '#FF6A3D', hot: '#FFC27A', core: '#FF6A3D', edge: '#C2185B' },
    { id: 'violet', name: 'Ultraviolet', swatch: '#7B5CFF', hot: '#D2C4FF', core: '#7B5CFF', edge: '#2B3BD9' },
    { id: 'jade', name: 'Jade', swatch: '#1ED6A0', hot: '#C2FFEA', core: '#1ED6A0', edge: '#0B6E74' },
    { id: 'rose', name: 'Rose', swatch: '#FF5C9A', hot: '#FFD3E4', core: '#FF5C9A', edge: '#8A2BE2' },
    { id: 'gold', name: 'Gold', swatch: '#F2B544', hot: '#FFF2C9', core: '#F2B544', edge: '#B4501A' },
];

function glow(c: Ctx, color: StyleColor): StyleLook {
    const { W, H } = c;
    const g = GLOW.find((x) => x.id === color.id) ?? GLOW[0]!;
    const rand = rng(`${c.date}|glow|${color.id}|${c.screen}`);
    const defs: string[] = [];
    const art: string[] = [`<rect width="${W}" height="${H}" fill="#050507"/>`];
    // The light: a wide ellipse whose centre sits below the bottom edge, so only its upper curve rises
    // into the picture; the words above stay on the dark.
    const cx = W * (0.38 + rand() * 0.24);
    defs.push(`<radialGradient id="glowMain"><stop offset="0" stop-color="${g.hot}" stop-opacity="1"/><stop offset="0.2" stop-color="${g.core}" stop-opacity="0.95"/><stop offset="0.5" stop-color="${g.edge}" stop-opacity="0.55"/><stop offset="0.78" stop-color="${g.edge}" stop-opacity="0.12"/><stop offset="1" stop-color="${g.edge}" stop-opacity="0"/></radialGradient>`);
    art.push(`<ellipse cx="${r1(cx)}" cy="${r1(H * 1.05)}" rx="${r1(W * 1.05)}" ry="${r1(H * (c.screen === 'home' ? 0.36 : 0.42))}" fill="url(#glowMain)"/>`);
    // A faint second light high on one side, so the dark above isn't flat.
    blob(defs, art, 'glowTop', rand() > 0.5 ? W * 0.95 : W * 0.05, H * 0.06, W * 0.75, g.edge, 0.2);
    grainLayer(defs, art, W, H, 0.13, Math.floor(rand() * 1000));
    return { defs, art, overlay: [], ink: inkOn('#000000'), glow: '#000000', glowAlpha: 0.3, ring: { lit: '#FFFFFF', dim: 'rgba(255,255,255,0.2)', stroke: 0.013, glow: true }, lineWeight: 600 };
}

// ── Peaks: a night landscape, ridge behind ridge, under stars and a crescent (layered, flat, clean) ──

const PEAKS: Array<StyleColor & { sky: [string, string, string]; ridges: [string, string, string, string, string]; moon: string; haze: string }> = [
    { id: 'midnight', name: 'Midnight', swatch: '#3B5BDB', sky: ['#04060D', '#0A1230', '#22356F'], ridges: ['#2A3C78', '#1E2C5C', '#152045', '#0E1631', '#070B1C'], moon: '#EEF2FF', haze: '#5C7CFA' },
    { id: 'dusk', name: 'Dusk', swatch: '#C2478F', sky: ['#06030A', '#1C0B27', '#5A2150'], ridges: ['#64295B', '#4B1F48', '#361737', '#241027', '#130816'], moon: '#FFE4EF', haze: '#F06595' },
    { id: 'forest', name: 'Forest', swatch: '#2F9E7F', sky: ['#020705', '#08201A', '#15493C'], ridges: ['#1F5546', '#174438', '#11342B', '#0B241E', '#051410'], moon: '#E6FFF6', haze: '#38D9A9' },
    { id: 'desert', name: 'Desert', swatch: '#E0823A', sky: ['#070403', '#24130A', '#5E3016'], ridges: ['#6B3A1E', '#522D18', '#3C2113', '#28160D', '#160C07'], moon: '#FFF0DC', haze: '#FFA94D' },
];

/** A ridge: three sine waves summed (a broad shape, then smaller bumps), filled down to the bottom. */
function ridgePath(W: number, H: number, base: number, amp: number, rand: () => number): string {
    const f = [1 + rand() * 1.5, 2.5 + rand() * 2.5, 6 + rand() * 5];
    const p = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
    const n = 96;
    let d = `M0 ${r1(H)}`;
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const y = base * H - amp * H * (0.6 * Math.sin(t * Math.PI * f[0]! + p[0]!) + 0.3 * Math.sin(t * Math.PI * f[1]! + p[1]!) + 0.1 * Math.sin(t * Math.PI * f[2]! + p[2]!));
        d += ` L${r1(t * W)} ${r1(y)}`;
    }
    return `${d} L${r1(W)} ${r1(H)} Z`;
}

function peaks(c: Ctx, color: StyleColor): StyleLook {
    const { W, H } = c;
    const p = PEAKS.find((x) => x.id === color.id) ?? PEAKS[0]!;
    const rand = rng(`${c.date}|peaks|${color.id}`);
    const defs: string[] = [`<linearGradient id="pkSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset="0.6" stop-color="${p.sky[1]}"/><stop offset="0.85" stop-color="${p.sky[2]}"/></linearGradient>`];
    const art: string[] = [`<rect width="${W}" height="${H}" fill="url(#pkSky)"/>`];
    // Stars: tiny, more of them high up.
    for (let i = 0; i < 90; i++) {
        const y = Math.pow(rand(), 1.8) * H * 0.7;
        art.push(`<circle cx="${r1(rand() * W)}" cy="${r1(y)}" r="${r1((rand() > 0.92 ? 2.2 : 1 + rand() * 0.8) * (W / 1080))}" fill="#FFFFFF" opacity="${r1((0.2 + rand() * 0.6) * 100) / 100}"/>`);
    }
    // The moon: a crescent high on one side, with a faint halo.
    const mx = rand() > 0.5 ? W * 0.8 : W * 0.2;
    const my = H * 0.16;
    const mr = W * 0.045;
    blob(defs, art, 'pkHalo', mx, my, mr * 5, p.haze, 0.18);
    defs.push(`<mask id="pkMoon"><circle cx="${r1(mx)}" cy="${r1(my)}" r="${r1(mr)}" fill="#FFFFFF"/><circle cx="${r1(mx + mr * 0.42)}" cy="${r1(my - mr * 0.18)}" r="${r1(mr * 0.88)}" fill="#000000"/></mask>`);
    art.push(`<circle cx="${r1(mx)}" cy="${r1(my)}" r="${r1(mr)}" fill="${p.moon}" mask="url(#pkMoon)"/>`);
    // A glow on the horizon, then the ridges: back (highest, palest) to front (lowest, darkest).
    // On the home picture the ridges sit lower: the day's words end above them (B8; the phone's zoom enlarges the backdrop).
    const lift = c.screen === 'home' ? 0.06 : 0;
    blob(defs, art, 'pkHorizon', W * 0.5, H * (0.8 + lift), W * 0.9, p.haze, 0.16);
    const bases = [0.75, 0.79, 0.83, 0.875, 0.92];
    const amps = [0.05, 0.04, 0.032, 0.024, 0.018];
    bases.forEach((b, i) => art.push(`<path d="${ridgePath(W, H, b + lift, amps[i]!, rand)}" fill="${p.ridges[i]}"/>`));
    grainLayer(defs, art, W, H, 0.06, Math.floor(rand() * 1000));
    return { defs, art, overlay: [], ink: inkOn('#000000'), glow: p.sky[0], glowAlpha: 0.45, ring: { lit: '#FFFFFF', dim: 'rgba(255,255,255,0.2)', stroke: 0.014 }, lineWeight: 600 };
}

// ── Orb: a glass sphere in an upper corner of the dark, lit from inside the picture (premium) ──

const ORB: Array<StyleColor & { light: string; body: string; rim: string }> = [
    { id: 'ice', name: 'Ice', swatch: '#4CC9F0', light: '#C8F4FF', body: '#3046D6', rim: '#4CC9F0' },
    { id: 'plasma', name: 'Plasma', swatch: '#C04CFD', light: '#FFD0F2', body: '#6A0DAD', rim: '#F72585' },
    { id: 'sun', name: 'Sun', swatch: '#FFB703', light: '#FFF3C8', body: '#D24D04', rim: '#FFB703' },
    { id: 'mint', name: 'Mint', swatch: '#52E3A4', light: '#D9FFF1', body: '#0A6B66', rim: '#52E3A4' },
];

function orb(c: Ctx, color: StyleColor): StyleLook {
    const { W, H } = c;
    const o = ORB.find((x) => x.id === color.id) ?? ORB[0]!;
    const rand = rng(`${c.date}|orb|${color.id}`);
    const defs: string[] = [];
    const art: string[] = [`<rect width="${W}" height="${H}" fill="#030305"/>`];
    const left = rand() > 0.5;
    const R = W * 0.5;
    const cx = left ? W * 0.06 : W * 0.94;
    const cy = H * 0.12;
    blob(defs, art, 'orbAura', cx, cy, R * 2.1, o.rim, 0.26);
    // The body: lit on the side that faces the picture, deep on the far side.
    defs.push(`<radialGradient id="orbBody" cx="${left ? 0.62 : 0.38}" cy="0.7" r="0.85" fx="${left ? 0.72 : 0.28}" fy="0.8"><stop offset="0" stop-color="${o.light}"/><stop offset="0.26" stop-color="${o.rim}"/><stop offset="0.62" stop-color="${o.body}"/><stop offset="1" stop-color="${mix(o.body, '#000000', 0.85)}"/></radialGradient>`);
    art.push(`<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(R)}" fill="url(#orbBody)"/>`);
    // Glass: a thin rim of light along the lower edge, and a soft highlight.
    defs.push(`<linearGradient id="orbRim" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="${o.light}" stop-opacity="0"/><stop offset="1" stop-color="${o.light}" stop-opacity="0.85"/></linearGradient>`);
    art.push(`<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(R - W * 0.004)}" fill="none" stroke="url(#orbRim)" stroke-width="${r1(W * 0.006)}"/>`);
    const hx = cx + (left ? R * 0.32 : -R * 0.32);
    const hy = cy + R * 0.52;
    defs.push(`<radialGradient id="orbShine"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.5"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`);
    art.push(`<ellipse cx="${r1(hx)}" cy="${r1(hy)}" rx="${r1(R * 0.34)}" ry="${r1(R * 0.15)}" fill="url(#orbShine)" transform="rotate(${left ? -30 : 30} ${r1(hx)} ${r1(hy)})"/>`);
    grainLayer(defs, art, W, H, 0.07, Math.floor(rand() * 1000));
    return { defs, art, overlay: [], ink: inkOn('#000000'), glow: '#000000', glowAlpha: 0.4, ring: { lit: o.light, dim: 'rgba(255,255,255,0.18)', stroke: 0.013, glow: true }, lineWeight: 600 };
}

// ── Dots: a dot-matrix screen on black, a dotted ring, one accent (Nothing-like, sleek) ──

const DOTS: StyleColor[] = [
    { id: 'red', name: 'Red', swatch: '#FF2D2D' },
    { id: 'white', name: 'White', swatch: '#FFFFFF' },
    { id: 'amber', name: 'Amber', swatch: '#FFB020' },
    { id: 'green', name: 'Green', swatch: '#2BD97C' },
    { id: 'blue', name: 'Blue', swatch: '#3D7BFF' },
];

function dots(c: Ctx, color: StyleColor): StyleLook {
    const { W, H } = c;
    const defs: string[] = [];
    const art: string[] = [`<rect width="${W}" height="${H}" fill="#000000"/>`];
    const step = W / 36;
    defs.push(`<pattern id="dotGrid" width="${r1(step)}" height="${r1(step)}" patternUnits="userSpaceOnUse"><circle cx="${r1(step / 2)}" cy="${r1(step / 2)}" r="${r1(W / 600)}" fill="#FFFFFF"/></pattern>`);
    // The grid fades out towards the middle, where the words are.
    defs.push(`<radialGradient id="dotFade" cx="0.5" cy="0.48" r="0.72"><stop offset="0.28" stop-color="#000000"/><stop offset="0.85" stop-color="#FFFFFF"/></radialGradient>`);
    defs.push(`<mask id="dotMask"><rect width="${W}" height="${H}" fill="url(#dotFade)"/></mask>`);
    art.push(`<rect width="${W}" height="${H}" fill="url(#dotGrid)" opacity="0.3" mask="url(#dotMask)"/>`);
    // One accent mark on the lock picture: a short row of lit dots under the clock's place (with the words).
    const overlay: string[] = [];
    if (c.screen === 'lock') for (let i = 0; i < 5; i++) overlay.push(`<circle cx="${r1(W / 2 + (i - 2) * step * 0.5)}" cy="${r1(H * 0.268)}" r="${r1(W / 280)}" fill="${color.swatch}" opacity="${i === 2 ? 1 : 0.45}"/>`);
    return { defs, art, overlay, ink: inkOn('#000000'), glow: null, glowAlpha: 0, ring: { lit: color.swatch, dim: 'rgba(255,255,255,0.22)', stroke: 0.012, dotted: true }, lineWeight: 500 };
}

// ── Flow: a silk ribbon of thin lines drifting across the dark (elegant) ──

const FLOW: Array<StyleColor & { from: string; mid: string; to: string }> = [
    { id: 'silk', name: 'Silk', swatch: '#8B5CF6', from: '#22D3EE', mid: '#8B5CF6', to: '#EC4899' },
    { id: 'flame', name: 'Flame', swatch: '#FF7A18', from: '#FFD166', mid: '#FF7A18', to: '#FF2E63' },
    { id: 'ocean', name: 'Ocean', swatch: '#00B4D8', from: '#90E0EF', mid: '#00B4D8', to: '#4361EE' },
    { id: 'lime', name: 'Lime', swatch: '#A3E635', from: '#D9F99D', mid: '#A3E635', to: '#0EA5E9' },
    { id: 'silver', name: 'Silver', swatch: '#D4D4D8', from: '#FFFFFF', mid: '#A1A1AA', to: '#52525B' },
];

function flow(c: Ctx, color: StyleColor): StyleLook {
    const { W, H } = c;
    const f = FLOW.find((x) => x.id === color.id) ?? FLOW[0]!;
    const rand = rng(`${c.date}|flow|${color.id}`);
    const defs: string[] = [`<linearGradient id="flowInk" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${f.from}"/><stop offset="0.5" stop-color="${f.mid}"/><stop offset="1" stop-color="${f.to}"/></linearGradient>`];
    const art: string[] = [`<rect width="${W}" height="${H}" fill="#050507"/>`];
    // The ribbon: lines that share one wave and drift in phase, so they fold over each other like silk.
    const base = H * (c.screen === 'home' ? 0.86 : 0.83);
    const amp = H * 0.055;
    const freq = 0.9 + rand() * 0.5;
    const phase = rand() * Math.PI * 2;
    blob(defs, art, 'flowGlow', W * 0.5, base, W * 0.85, f.mid, 0.18);
    const lines = 42;
    for (let k = 0; k < lines; k++) {
        const t = k / (lines - 1);
        let d = '';
        for (let i = 0; i <= 80; i++) {
            const u = i / 80;
            const y = base + (t - 0.5) * H * 0.07 + amp * Math.sin(u * Math.PI * 2 * freq + phase + t * 1.6) * (0.6 + 0.4 * Math.sin(t * Math.PI));
            d += `${i ? ' L' : 'M'}${r1(u * W * 1.1 - W * 0.05)} ${r1(y)}`;
        }
        art.push(`<path d="${d}" fill="none" stroke="url(#flowInk)" stroke-width="${r1(W / 900)}" opacity="${r1((0.18 + 0.55 * Math.sin(t * Math.PI)) * 100) / 100}"/>`);
    }
    grainLayer(defs, art, W, H, 0.06, Math.floor(rand() * 1000));
    return { defs, art, overlay: [], ink: inkOn('#000000'), glow: null, glowAlpha: 0, ring: { lit: f.mid, dim: 'rgba(255,255,255,0.18)', stroke: 0.012 }, lineWeight: 500 };
}

// ── The list ──────────────────────────────────────────────────────────────────────────────────

const strip = (cs: StyleColor[]): StyleColor[] => cs.map(({ id, name, swatch }) => ({ id, name, swatch }));

/** Every style but the sky (its own code in wallpaperArt.ts), with its colours. All dark (the owner, 11-16). */
const DRAW: Record<string, { info: StyleInfo; draw: (c: Ctx, color: StyleColor) => StyleLook }> = {
    glow: { info: { id: 'glow', name: 'Glow', blurb: 'One warm light rising out of the dark, with film grain', colors: strip(GLOW) }, draw: glow },
    peaks: { info: { id: 'peaks', name: 'Peaks', blurb: 'A night landscape, ridge behind ridge, under a crescent', colors: strip(PEAKS) }, draw: peaks },
    orb: { info: { id: 'orb', name: 'Orb', blurb: 'A glass sphere glowing in a corner of the dark', colors: strip(ORB) }, draw: orb },
    dots: { info: { id: 'dots', name: 'Dots', blurb: 'A dot-matrix screen on black, one accent', colors: DOTS }, draw: dots },
    flow: { info: { id: 'flow', name: 'Flow', blurb: 'A silk ribbon of thin lines drifting across the dark', colors: strip(FLOW) }, draw: flow },
    aurora: { info: { id: 'aurora', name: 'Aurora', blurb: 'Slow colour lights in a deep night', colors: strip(AURORA) }, draw: aurora },
    mono: { info: { id: 'mono', name: 'Mono', blurb: 'Black, a watch dial, one accent', colors: MONO }, draw: mono },
};

export const SKY_STYLE: StyleInfo = { id: 'sky', name: 'Sky', blurb: 'The sky of your day: dawn, daylight, dusk, a starry night', colors: [{ id: 'auto', name: 'By the hour', swatch: '#F3A47C' }] };

/** The styles the app offers, the sky first (its colours follow the day). */
export const WALLPAPER_STYLES: StyleInfo[] = [SKY_STYLE, ...Object.values(DRAW).map((d) => d.info)];

/** A style's look, or null for the sky (and for a style this server doesn't know: the sky then). */
export function styleLook(style: string | undefined, color: string | undefined, ctx: Ctx): StyleLook | null {
    const d = style ? DRAW[style] : undefined;
    if (!d) return null;
    const c = d.info.colors.find((x) => x.id === color) ?? d.info.colors[0]!;
    return d.draw(ctx, c);
}
