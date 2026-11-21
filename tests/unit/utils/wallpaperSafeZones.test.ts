// Stage 11 (ECOSYSTEM_V2_PLAN, his item 10a): wallpapers on regular Android phones. Every word the server draws stays
// inside the safe zone of its screen, on every size of the matrix (720×1600 to 1440×3200, 16:9 to 21:9), in every
// style and theme, with the fullest day (long words, six reminders, a thought, a goal): never under the maker's clock
// at the top of the lock screen, the shortcuts and the fingerprint at its foot, the home screen's status bar and dock,
// or the edges. Measured from the SVG's own text boxes (Inter's real advances).
import { describe, expect, it } from 'vitest';
import { wallpaperSvg, type Ambient, type WallpaperScreen } from '../../../src/services/ambient/ambient.service';
import { textWidth } from '../../../src/services/ambient/wallpaperArt';
import { WALLPAPER_STYLES } from '../../../src/services/ambient/wallpaperStyles';
import { SAFE_ZONES, SIZE_MATRIX } from '../../../src/services/ambient/safeZones';

const LONG = 'Book the dentist for Monday morning and tell Asha about the sliding window problem before the standup';

function fullest(): Ambient {
    return {
        state: 'working',
        date: 'Wednesday 18 November',
        headline: LONG,
        lines: ['Next: Consistent hashing, part 2 of the caching path', 'Finish the LRU note with the diagram', '3 reviews · about 14 min'],
        mode: 'normal',
        updatedAt: '2026-11-18T09:00:00.000Z',
        week: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${String(12 + i).padStart(2, '0')}`, active: i % 2 === 0 })),
        items: Array.from({ length: 9 }, (_, i) => ({ kind: (['review', 'focus', 'task'] as const)[i % 3], title: `${LONG.slice(0, 30 + i * 5)}`, done: i < 3 })) as unknown as NonNullable<Ambient['items']>,
        counts: { reviews: { done: 1, total: 3 }, focus: { done: 1, total: 3 }, tasks: { done: 1, total: 3 } } as unknown as NonNullable<Ambient['counts']>,
        goal: { title: 'Backend offer by May: system design and DSA every week', daysLeft: 178, forecast: 'on_track' } as unknown as NonNullable<Ambient['goal']>,
        line: { dayId: 'd', slot: 'morning', text: 'You said the interview prep felt rushed last week; one mock system design today would make Friday easier.' },
        reminders: Array.from({ length: 6 }, (_, i) => ({ at: `${9 + i}:30 pm`, text: `${LONG.slice(0, 40 + i * 6)}` })) as unknown as NonNullable<Ambient['reminders']>,
        insight: 'Two weeks of evening reviews in a row: the mornings are free for the course now, if you want them.',
        // Stage 16: the lock's rows (now) and the home's Pick up and Coming up (ahead), the fullest of each.
        today: Array.from({ length: 3 }, (_, i) => ({ id: `rm_${i}`, at: `${9 + i}:30 pm`, text: LONG.slice(0, 50 + i * 10) })),
        pickUp: { id: 'pu_1', at: '', text: 'Longest common subsequence with the rolling array trick', detail: LONG },
        comingUp: Array.from({ length: 3 }, (_, i) => ({ id: `tk_${i}`, at: `Wed ${10 + i}:30 am`, text: LONG.slice(0, 60 + i * 8) })),
    };
}

interface Box {
    text: string;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
}

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Every <text> of the SVG as the box its glyphs fill (Inter: ascent ~0.75 of the size above the baseline, 0.25 below). */
export function textBoxes(svg: string): Box[] {
    const out: Box[] = [];
    for (const m of svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
        const attrs = m[1]!;
        const num = (name: string) => Number(new RegExp(`\\b${name}="(-?[\\d.]+)"`).exec(attrs)?.[1] ?? NaN);
        const x = num('x');
        const y = num('y');
        const size = num('font-size');
        const weight = Number(/font-weight="(\d+)"/.exec(attrs)?.[1] ?? 400) as 400 | 500 | 600;
        const ls = Number(/letter-spacing="(-?[\d.]+)"/.exec(attrs)?.[1] ?? 0);
        const anchor = /text-anchor="(\w+)"/.exec(attrs)?.[1] ?? 'start';
        const text = decode(m[2]!);
        if (!text.trim() || !Number.isFinite(x + y + size)) continue;
        // A transform (rotate, translate) would move the box: none of the words carry one today.
        if (/transform=/.test(attrs)) continue;
        const w = textWidth(text, size, weight, ls);
        const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
        out.push({ text, x0, x1: x0 + w, y0: y - size * 0.75, y1: y + size * 0.25 });
    }
    return out;
}

/** The words that leave the screen's safe zone, as "text: where". */
export function outside(svg: string, width: number, height: number, screen: WallpaperScreen): string[] {
    const z = SAFE_ZONES[screen];
    const bad: string[] = [];
    for (const b of textBoxes(svg)) {
        const where: string[] = [];
        if (b.x0 < z.left * width - 0.5) where.push(`left ${(b.x0 / width).toFixed(3)}`);
        if (b.x1 > z.right * width + 0.5) where.push(`right ${(b.x1 / width).toFixed(3)}`);
        if (b.y0 < z.top * height - 0.5) where.push(`top ${(b.y0 / height).toFixed(3)}`);
        if (b.y1 > z.bottom * height + 0.5) where.push(`bottom ${(b.y1 / height).toFixed(3)}`);
        if (where.length) bad.push(`"${b.text.slice(0, 40)}": ${where.join(', ')}`);
    }
    return bad;
}

const STYLE_IDS = WALLPAPER_STYLES.map((s) => s.id);

describe('wallpapers on regular phones: every word inside its safe zone (stage 11, item 10a)', () => {
    it('the measure sees the words (the buddy’s line on the lock screen, the reminders and the thought at home)', () => {
        const lock = textBoxes(wallpaperSvg(fullest(), 1080, 2340, 'dark', 'lock', { style: 'sky' }));
        const home = textBoxes(wallpaperSvg(fullest(), 1080, 2340, 'dark', 'home', { style: 'sky' }));
        expect(lock.length).toBeGreaterThan(3);
        expect(home.length).toBeGreaterThan(5);
        expect(lock.map((b) => b.text).join(' ')).toMatch(/interview prep/);
        expect(home.map((b) => b.text).join(' ')).toMatch(/evening reviews/);
        // Stage 16: the lock's rows and the home's Pick up and Coming up are measured too.
        expect(lock.map((b) => b.text).join(' ')).toMatch(/Book the dentist/);
        expect(home.map((b) => b.text).join(' ')).toMatch(/Longest common subsequence/);
        expect(home.map((b) => b.text).join(' ')).toMatch(/Coming up/);
        const span = (bs: Box[]) => [Math.min(...bs.map((b) => b.y0)) / 2340, Math.max(...bs.map((b) => b.y1)) / 2340].map((n) => n.toFixed(3)).join('–');
        console.log(`lock words ${span(lock)}, home words ${span(home)} of the height`);
    });

    for (const screen of ['lock', 'home'] as const) {
        for (const [w, h] of SIZE_MATRIX) {
            it(`${screen} ${w}×${h}: every style, light and dark, the fullest day and an empty one`, () => {
                const bad: string[] = [];
                for (const style of STYLE_IDS) {
                    for (const theme of ['light', 'dark'] as const) {
                        for (const a of [fullest(), { ...fullest(), state: 'done' as const, headline: '', lines: [], line: null, reminders: [], insight: '', today: [], pickUp: null, comingUp: [] }]) {
                            const svg = wallpaperSvg(a, w, h, theme, screen, { style });
                            for (const b of outside(svg, w, h, screen)) bad.push(`${style}/${theme}/${a.state}: ${b}`);
                        }
                    }
                }
                expect(bad).toEqual([]);
            });
        }
    }
});
