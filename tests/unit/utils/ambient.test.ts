// The ambient phone's states (ALWAYS_ON_SPEC 6.6): what the wallpaper and widget say, by the hour and mode.
import { describe, expect, it } from 'vitest';
import { ambientFor, wallpaperSvg } from '../../../src/services/ambient/ambient.service';
import { textWidth, wrapText } from '../../../src/services/ambient/wallpaperArt';
import type { Brief } from '../../../src/services/brief/brief.service';

function brief(over: { planned?: number; est?: number; done?: number; focus?: Array<{ text: string; done: boolean }>; tasks?: number; next?: string | null } = {}): Brief {
    return {
        now: { day: '2026-11-15', weekday: 'Sun', time: '08:00', timezone: 'Asia/Kolkata' },
        profile: null,
        goals: [],
        decisions: { due: [], project: [] },
        tasks: { dueToday: over.tasks ?? 0, overdue: 0, titles: [] },
        week: { weekStart: '2026-11-09', targets: [], reviewDue: false },
        today: {
            revisions: { planned: over.planned ?? 0, estMinutes: over.est ?? 0, done: over.done ?? 0, waiting: 0 },
            focus: (over.focus ?? []).map((f, i) => ({ _id: `f${i}`, ...f })),
        },
        next: over.next === null || over.next === undefined ? [] : [{ subject: { _id: 's', name: 'System Design', color: null }, topic: { _id: 't', title: over.next, position: 2, status: 'planned' }, done: 1, total: 9, nextStep: null, lastSession: null, weakSpots: [] }],
        recent: [],
        recall: { days: 7, finished: 0, weakTopics: [] },
        project: null,
        session: { key: 'k' },
    } as unknown as Brief;
}

const date = 'Sunday 15 November';

describe('ambientFor', () => {
    it('morning: what today holds, then the next topic and focus lines', () => {
        const a = ambientFor(brief({ planned: 3, est: 12, next: 'Caching part 2', focus: [{ text: 'Finish the LRU note', done: false }] }), 'normal', 8, date);
        expect(a.state).toBe('morning');
        expect(a.headline).toBe('3 reviews · about 12 min');
        expect(a.lines).toEqual(['Next: Caching part 2', 'Finish the LRU note']);
    });

    it('working hours: the focus line only', () => {
        const a = ambientFor(brief({ planned: 2, est: 9, focus: [{ text: 'Ship the share popover', done: false }] }), 'normal', 14, date);
        expect(a).toMatchObject({ state: 'working', headline: 'Ship the share popover', lines: ['2 reviews · about 9 min'] });
    });

    it('evening: one line on the day, never an overdue count', () => {
        const a = ambientFor(brief({ planned: 1, est: 5, done: 2 }), 'normal', 20, date);
        expect(a).toMatchObject({ state: 'evening', headline: '2 reviews done today', lines: ['1 left · about 5 min'] });
    });

    it('a done day is a clean picture: the night sky, "Done for today" and the date, nothing to do', () => {
        const a = ambientFor(brief({ done: 3 }), 'normal', 16, date);
        expect(a).toMatchObject({ state: 'done', headline: '', lines: [] });
        const svg = wallpaperSvg(a, 1080, 2340, 'dark');
        expect(svg).toContain(date);
        expect(svg).toContain('Done for today');
        expect(svg).toContain('mask="url(#crescent)"');
        expect(svg.match(/<text/g)).toHaveLength(2);
    });

    it('the sky follows the state; the last seven days show as dots under the lines', () => {
        const week = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'].map((day, i) => ({ day, active: i !== 2 }));
        const morning = wallpaperSvg({ ...ambientFor(brief({ planned: 3, est: 12 }), 'normal', 8, date), week }, 1080, 2340, 'light');
        const evening = wallpaperSvg({ ...ambientFor(brief({ planned: 1, est: 5, done: 2 }), 'normal', 20, date), week }, 1080, 2340, 'light');
        expect(morning).toContain('>Morning<');
        expect(evening).toContain('>Evening<');
        expect(morning.match(/<linearGradient id="sky"[^]*?<\/linearGradient>/)?.[0]).not.toBe(evening.match(/<linearGradient id="sky"[^]*?<\/linearGradient>/)?.[0]);
        // Seven dots, six filled; the weekday letters under them end on Sunday (today).
        expect(morning.match(/<circle [^>]*r="11.3"/g)).toHaveLength(7);
        expect(morning).toMatch(/>M<[^]*>S<\/text><\/svg>$/);
    });

    it('lines wrap by real widths, evenly, never starting with a separator or splitting "3 reviews"', () => {
        const usable = 1080 - 2 * Math.round(1080 * 0.08);
        const lines = wrapText('A light day: 1 review · about 5 min', 73, 600, usable * 0.62, 3);
        expect(lines.length).toBeGreaterThan(1);
        for (const l of lines) expect(l.startsWith('·')).toBe(false);
        expect(lines.join(' ')).toContain('1 review');
        expect(Math.max(...lines.map((l) => textWidth(l, 73, 600)))).toBeLessThanOrEqual(usable * 0.62);
        // Balanced: no line holds a single short word.
        const balanced = wrapText('Finish the LRU cache note before the standup', 73, 600, usable, 3);
        expect(balanced).toEqual(['Finish the LRU cache', 'note before the standup']);
        // Inter's real widths: an M is wider than an i.
        expect(textWidth('MMMM', 40, 400)).toBeGreaterThan(textWidth('iiii', 40, 400) * 2);
    });

    it('busy and comeback modes are lighter', () => {
        expect(ambientFor(brief({ planned: 1, est: 5 }), 'busy', 9, date)).toMatchObject({ state: 'rest', headline: 'A light day: 1 review · about 5 min' });
        expect(ambientFor(brief({ planned: 2, est: 8, next: 'Heaps' }), 'comeback', 9, date)).toMatchObject({ state: 'rest', headline: 'Welcome back: 2 reviews · about 8 min', lines: ['Next: Heaps'] });
    });

    it('"Hide titles": counts and plain words, never a topic or focus name', () => {
        const focus = [{ text: 'Finish the LRU note', done: false }, { text: 'Ship the share popover', done: false }];
        const morning = ambientFor(brief({ planned: 3, est: 12, next: 'Caching part 2', focus, tasks: 1 }), 'normal', 8, date, new Date(), { titles: false });
        expect(morning).toMatchObject({ state: 'morning', headline: '3 reviews · about 12 min', lines: ['Focus: 2 open', '1 task due'] });
        const free = ambientFor(brief({ focus: focus.slice(0, 1) }), 'normal', 8, date, new Date(), { titles: false });
        expect(free).toMatchObject({ headline: 'Focus: 1 open', lines: [] });
        expect(ambientFor(brief({ planned: 2, est: 9, focus }), 'normal', 14, date, new Date(), { titles: false })).toMatchObject({ state: 'working', headline: 'Focus: 2 open', lines: ['2 reviews · about 9 min'] });
        expect(ambientFor(brief({ planned: 2, est: 8, next: 'Heaps' }), 'comeback', 9, date, new Date(), { titles: false })).toMatchObject({ state: 'rest', lines: [] });
        const text = JSON.stringify(morning) + wallpaperSvg(morning, 1080, 2340, 'light');
        for (const name of ['Caching part 2', 'Finish the LRU note', 'Ship the share popover']) expect(text).not.toContain(name);
    });

    it('the wallpaper escapes text and keeps it off the clock area', () => {
        const a = ambientFor(brief({ planned: 1, est: 5, focus: [{ text: 'Read <b> & "quotes"', done: false }] }), 'normal', 9, date);
        const svg = wallpaperSvg(a, 1080, 2340, 'light');
        expect(svg).toContain('Read &lt;b&gt; &amp; &quot;quotes&quot;');
        const ys = [...svg.matchAll(/<text x="\d+" y="(\d+)"/g)].map((m) => Number(m[1]));
        expect(Math.min(...ys)).toBeGreaterThan(2340 * 0.3);
        expect(Math.max(...ys)).toBeLessThan(2340 * 0.8);
    });
});
