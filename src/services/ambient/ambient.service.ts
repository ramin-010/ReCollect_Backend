// The ambient phone (ECOSYSTEM_PLAN §10 step a; ALWAYS_ON_SPEC 6.6): a wallpaper picture and a small
// widget summary, both drawn from the brief. States, not statistics: what today holds in the morning,
// the focus line while working, one line on the day in the evening, a clean picture when the day is
// done, lighter in busy and comeback modes. Never red, never an overdue count as the headline.
import { getBrief, type Brief } from '../brief/brief.service';
import { getToday } from '../learningDb/today.service';
import type { PlanMode } from '../learning/plan';
import { svgToPng } from '../docs/diagram/png';

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
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What to show, from the brief, the plan mode and the local hour (0–23). Pure: tested directly. */
export function ambientFor(b: Brief, mode: PlanMode, hour: number, date: string, now: Date = new Date()): Ambient {
    const r = b.today.revisions;
    const openFocus = b.today.focus.filter((f) => !f.done);
    const next = b.next[0];
    const nextLine = next ? `Next: ${next.topic.title}` : null;
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
        const lines = [nextLine, ...openFocus.slice(0, 2).map((f) => f.text), tasksDue > 0 ? `${plural(tasksDue, 'task')} due` : null].filter((x): x is string => !!x).slice(0, 3);
        return { ...base, state: 'morning', headline: revise ?? (openFocus[0]?.text ?? 'A free morning'), lines: revise ? lines : lines.filter((l) => l !== openFocus[0]?.text) };
    }
    if (hour < 18) {
        const focus = openFocus[0]?.text;
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

export async function getAmbient(userId: string, now: Date = new Date()): Promise<Ambient> {
    const [brief, today] = await Promise.all([getBrief(userId, {}, now), getToday(userId, now)]);
    const { hour, date } = localClock(now, brief.now.timezone);
    const mode = (today.plan?.mode ?? 'normal') as PlanMode;
    return ambientFor(brief, mode, hour, date, now);
}

// ── The wallpaper ────────────────────────────────────────────────────────────────────────

const THEMES = {
    // Notion's page tokens (DESIGN.md): the page, ink 1–3. No gradients, no glows.
    light: { ground: '#FFFFFF', ink1: '#2C2C2B', ink2: '#5F5E59', ink3: '#73706B', line: '#E3E2DF' },
    dark: { ground: '#191919', ink1: '#F0EFED', ink2: '#ADA9A3', ink3: '#8E8B86', line: '#383836' },
} as const;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Greedy wrap by an average glyph width (good enough for a few short lines). */
function wrap(text: string, maxChars: number): string[] {
    const words = text.split(/\s+/);
    const out: string[] = [];
    let line = '';
    for (const w of words) {
        if (!line) line = w;
        else if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
        else {
            out.push(line);
            line = w;
        }
    }
    if (line) out.push(line);
    return out.slice(0, 3);
}

/**
 * The wallpaper as SVG: the text block sits between 34 % and 78 % of the height (clear of the
 * clock above and the icons below), left-aligned on a 9 % margin. A done day is the bare ground
 * with one small date line: nothing to do on it.
 */
export function wallpaperSvg(a: Ambient, width: number, height: number, theme: 'light' | 'dark'): string {
    const t = THEMES[theme];
    const x = Math.round(width * 0.09);
    const usable = width - 2 * x;
    const font = `font-family="Segoe UI, Arial, sans-serif"`;
    const meta = Math.round(width * 0.034);
    const head = Math.round(width * 0.062);
    const body = Math.round(width * 0.041);
    let y = Math.round(height * 0.36);
    const parts: string[] = [];
    parts.push(`<text x="${x}" y="${y}" ${font} font-size="${meta}" fill="${t.ink3}">${esc(a.date)}</text>`);
    if (a.state !== 'done') {
        y += Math.round(meta * 1.2);
        for (const line of wrap(a.headline, Math.floor(usable / (head * 0.52)))) {
            y += Math.round(head * 1.25);
            parts.push(`<text x="${x}" y="${y}" ${font} font-size="${head}" font-weight="700" fill="${t.ink1}">${esc(line)}</text>`);
        }
        if (a.lines.length) {
            y += Math.round(body * 0.9);
            parts.push(`<rect x="${x}" y="${y}" width="${Math.round(width * 0.12)}" height="${Math.max(2, Math.round(width * 0.002))}" fill="${t.line}"/>`);
            y += Math.round(body * 0.4);
        }
        for (const l of a.lines) {
            for (const line of wrap(l, Math.floor(usable / (body * 0.5)))) {
                y += Math.round(body * 1.5);
                if (y > height * 0.78) break;
                parts.push(`<text x="${x}" y="${y}" ${font} font-size="${body}" fill="${t.ink2}">${esc(line)}</text>`);
            }
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${t.ground}"/>${parts.join('')}</svg>`;
}

/** The wallpaper as a PNG, sized for the phone (pixels, not CSS px). */
export function wallpaperPng(a: Ambient, width: number, height: number, theme: 'light' | 'dark'): Buffer {
    return svgToPng(wallpaperSvg(a, width, height, theme), width, height, 1, Math.max(width, height)).png;
}
