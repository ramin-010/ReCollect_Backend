// The ambient phone's states (ALWAYS_ON_SPEC 6.6): what the wallpaper and widget say, by the hour and mode.
import { describe, expect, it } from 'vitest';
import { ambientFor, wallpaperSvg } from '../../../src/services/ambient/ambient.service';
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

    it('a done day is a clean picture with nothing on it', () => {
        const a = ambientFor(brief({ done: 3 }), 'normal', 16, date);
        expect(a).toMatchObject({ state: 'done', headline: '', lines: [] });
        const svg = wallpaperSvg(a, 1080, 2340, 'dark');
        expect(svg).toContain(date);
        expect(svg.match(/<text/g)).toHaveLength(1);
    });

    it('busy and comeback modes are lighter', () => {
        expect(ambientFor(brief({ planned: 1, est: 5 }), 'busy', 9, date)).toMatchObject({ state: 'rest', headline: 'A light day: 1 review · about 5 min' });
        expect(ambientFor(brief({ planned: 2, est: 8, next: 'Heaps' }), 'comeback', 9, date)).toMatchObject({ state: 'rest', headline: 'Welcome back: 2 reviews · about 8 min', lines: ['Next: Heaps'] });
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
