// The ambient phone (ECOSYSTEM_PLAN §10 step a; ALWAYS_ON_SPEC 6.6): a wallpaper picture and a small
// widget summary, both drawn from the brief. States, not statistics: what today holds in the morning,
// the focus line while working, one line on the day in the evening, a clean picture when the day is
// done, lighter in busy and comeback modes. Never red, never an overdue count as the headline.
import { getBrief, type Brief } from '../brief/brief.service';
import { getToday } from '../learningDb/today.service';
import type { PlanMode } from '../learning/plan';
import path from 'node:path';
import { svgToPng } from '../docs/diagram/png';
import { drawWallpaper } from './wallpaperArt';

export type AmbientState = 'morning' | 'working' | 'evening' | 'done' | 'rest';

export interface Ambient {
    state: AmbientState;
    /** e.g. "Sunday 15 November" */
    date: string;
    /** The one line that matters now; empty on a done day (the picture is the reward). */
    headline: string;
    /** Up to three quieter lines under it. */
    lines: string[];
    mode: PlanMode;
    updatedAt: string;
    /** The last seven days, oldest first: studied or not (Home's rhythm). The wallpaper draws them as dots. */
    week?: Array<{ day: string; active: boolean }>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface AmbientOptions {
    /**
     * false: no topic or focus names, only counts and plain words (the phone app's "Hide titles":
     * a lock screen is seen by anyone who picks the phone up). Default true.
     */
    titles?: boolean;
}

/** What to show, from the brief, the plan mode and the local hour (0–23). Pure: tested directly. */
export function ambientFor(b: Brief, mode: PlanMode, hour: number, date: string, now: Date = new Date(), options: AmbientOptions = {}): Ambient {
    const titles = options.titles !== false;
    const r = b.today.revisions;
    const openFocus = b.today.focus.filter((f) => !f.done);
    // His focus lines, or with titles hidden one count line in their place.
    const focusTexts = titles ? openFocus.map((f) => f.text) : openFocus.length ? [`Focus: ${openFocus.length} open`] : [];
    const next = b.next[0];
    const nextLine = next && titles ? `Next: ${next.topic.title}` : null;
    const tasksDue = b.tasks.dueToday + b.tasks.overdue;
    const base = { date, mode, updatedAt: now.toISOString() };

    const nothingLeft = r.planned === 0 && openFocus.length === 0 && tasksDue === 0;
    if (nothingLeft && (r.done > 0 || b.today.focus.length > 0 || hour >= 12)) {
        return { ...base, state: 'done', headline: '', lines: [] };
    }

    const revise = r.planned > 0 ? `${plural(r.planned, 'review')} · about ${r.estMinutes} min` : null;

    if (mode === 'busy' || mode === 'comeback') {
        const headline = mode === 'busy' ? (revise ? `A light day: ${revise}` : 'A light day') : revise ? `Welcome back: ${revise}` : 'Welcome back';
        return { ...base, state: 'rest', headline, lines: nextLine ? [nextLine] : [] };
    }

    if (hour < 12) {
        const lines = [nextLine, ...focusTexts.slice(0, 2), tasksDue > 0 ? `${plural(tasksDue, 'task')} due` : null].filter((x): x is string => !!x).slice(0, 3);
        return { ...base, state: 'morning', headline: revise ?? (focusTexts[0] ?? 'A free morning'), lines: revise ? lines : lines.filter((l) => l !== focusTexts[0]) };
    }
    if (hour < 18) {
        const focus = focusTexts[0];
        return { ...base, state: 'working', headline: focus ?? revise ?? 'Keep going', lines: focus && revise ? [revise] : [] };
    }
    const doneWords = r.done > 0 ? `${plural(r.done, 'review')} done today` : 'Nothing revised yet today';
    const left = r.planned > 0 ? `${r.planned} left · about ${r.estMinutes} min` : null;
    return { ...base, state: 'evening', headline: doneWords, lines: [left].filter((x): x is string => !!x) };
}

/** The local hour and a long date ("Sunday 15 November") in the user's zone. */
function localClock(now: Date, timezone: string): { hour: number; date: string } {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }).format(now)) % 24;
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(now).replace(',', '');
    return { hour, date };
}

export async function getAmbient(userId: string, now: Date = new Date(), options: AmbientOptions = {}): Promise<Ambient> {
    const [brief, today] = await Promise.all([getBrief(userId, {}, now), getToday(userId, now)]);
    const { hour, date } = localClock(now, brief.now.timezone);
    const mode = (today.plan?.mode ?? 'normal') as PlanMode;
    const week = today.stats?.rhythm?.last7?.map((d) => ({ day: d.day, active: d.active }));
    return { ...ambientFor(brief, mode, hour, date, now, options), ...(week?.length === 7 ? { week } : {}) };
}

// ── The wallpaper ────────────────────────────────────────────────────────────────────────

/** Inter (SIL OFL 1.1, assets/fonts): the picture looks the same on any server, with or without fonts of its own. */
export const WALLPAPER_FONTS = ['Regular', 'Medium', 'SemiBold', 'Bold'].map((w) => path.resolve(__dirname, '..', '..', '..', 'assets', 'fonts', `Inter-${w}.ttf`));

/** The wallpaper as SVG: the sky of the day (wallpaperArt.ts). */
export function wallpaperSvg(a: Ambient, width: number, height: number, theme: 'light' | 'dark'): string {
    return drawWallpaper({ state: a.state, date: a.date, headline: a.headline, lines: a.lines, ...(a.week ? { week: a.week } : {}) }, width, height, theme);
}

/** The wallpaper as a PNG, sized for the phone (pixels, not CSS px). */
export function wallpaperPng(a: Ambient, width: number, height: number, theme: 'light' | 'dark'): Buffer {
    return svgToPng(wallpaperSvg(a, width, height, theme), width, height, 1, Math.max(width, height), WALLPAPER_FONTS).png;
}
