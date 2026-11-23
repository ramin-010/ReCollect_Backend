// The ambient phone's states (ALWAYS_ON_SPEC 6.6): what the wallpaper and widget say, by the hour and mode.
import { describe, expect, it } from 'vitest';
import { ambientFor, dayItems, wallpaperSvg } from '../../../src/services/ambient/ambient.service';
import { argbHex, pictureZoom, textWidth, wrapText } from '../../../src/services/ambient/wallpaperArt';
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
        // Stage 16: no estimated time (the owner, 11-20).
        expect(a.headline).toBe('3 reviews');
        expect(a.lines).toEqual(['Next: Caching part 2', 'Finish the LRU note']);
    });

    it('working hours: the focus line only', () => {
        const a = ambientFor(brief({ planned: 2, est: 9, focus: [{ text: 'Ship the share popover', done: false }] }), 'normal', 14, date);
        expect(a).toMatchObject({ state: 'working', headline: 'Ship the share popover', lines: ['2 reviews'] });
    });

    it('evening: one line on the day, never an overdue count', () => {
        const a = ambientFor(brief({ planned: 1, est: 5, done: 2 }), 'normal', 20, date);
        expect(a).toMatchObject({ state: 'evening', headline: '2 reviews done today', lines: ['1 left'] });
    });

    it('a done day with nothing ahead is the picture alone: the night sky, no words (stage 16: the home picture is what is ahead)', () => {
        const a = ambientFor(brief({ done: 3 }), 'normal', 16, date);
        expect(a).toMatchObject({ state: 'done', headline: '', lines: [] });
        const svg = wallpaperSvg(a, 1080, 2340, 'dark');
        expect(svg).toContain('mask="url(#crescent)"');
        expect(svg.match(/<text/g)).toBeNull();
    });

    it('the sky follows the state; the week’s dots and the date are gone from the home picture (stage 16)', () => {
        const week = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'].map((day, i) => ({ day, active: i !== 2 }));
        const morning = wallpaperSvg({ ...ambientFor(brief({ planned: 3, est: 12 }), 'normal', 8, date), week }, 1080, 2340, 'light');
        const evening = wallpaperSvg({ ...ambientFor(brief({ planned: 1, est: 5, done: 2 }), 'normal', 20, date), week }, 1080, 2340, 'light');
        expect(morning.match(/<linearGradient id="sky"[^]*?<\/linearGradient>/)?.[0]).not.toBe(evening.match(/<linearGradient id="sky"[^]*?<\/linearGradient>/)?.[0]);
        expect(morning.match(/<circle [^>]*r="11.3"/g)).toBeNull();
        expect(morning).not.toContain(date.toUpperCase());
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
        expect(ambientFor(brief({ planned: 1, est: 5 }), 'busy', 9, date)).toMatchObject({ state: 'rest', headline: 'A light day: 1 review' });
        expect(ambientFor(brief({ planned: 2, est: 8, next: 'Heaps' }), 'comeback', 9, date)).toMatchObject({ state: 'rest', headline: 'Welcome back: 2 reviews', lines: ['Next: Heaps'] });
    });

    it('"Hide titles": counts and plain words, never a topic or focus name', () => {
        const focus = [{ text: 'Finish the LRU note', done: false }, { text: 'Ship the share popover', done: false }];
        const morning = ambientFor(brief({ planned: 3, est: 12, next: 'Caching part 2', focus, tasks: 1 }), 'normal', 8, date, new Date(), { titles: false });
        expect(morning).toMatchObject({ state: 'morning', headline: '3 reviews', lines: ['Focus: 2 open', '1 task due'] });
        const free = ambientFor(brief({ focus: focus.slice(0, 1) }), 'normal', 8, date, new Date(), { titles: false });
        expect(free).toMatchObject({ headline: 'Focus: 1 open', lines: [] });
        expect(ambientFor(brief({ planned: 2, est: 9, focus }), 'normal', 14, date, new Date(), { titles: false })).toMatchObject({ state: 'working', headline: 'Focus: 2 open', lines: ['2 reviews'] });
        expect(ambientFor(brief({ planned: 2, est: 8, next: 'Heaps' }), 'comeback', 9, date, new Date(), { titles: false })).toMatchObject({ state: 'rest', lines: [] });
        const text = JSON.stringify(morning) + wallpaperSvg(morning, 1080, 2340, 'light');
        for (const name of ['Caching part 2', 'Finish the LRU note', 'Ship the share popover']) expect(text).not.toContain(name);
    });

    it('the wallpaper escapes text and keeps it off the clock area', () => {
        const a = { ...ambientFor(brief({ planned: 1, est: 5 }), 'normal', 9, date), pickUp: { id: 'pu_1', at: '', text: 'Read <b> & "quotes"' } };
        const svg = wallpaperSvg(a, 1080, 2340, 'light');
        expect(svg).toContain('Read &lt;b&gt; &amp; &quot;quotes&quot;');
        const ys = [...svg.matchAll(/<text x="\d+" y="(\d+)"/g)].map((m) => Number(m[1]));
        expect(Math.min(...ys)).toBeGreaterThan(2340 * 0.3);
        expect(Math.max(...ys)).toBeLessThan(2340 * 0.8);
    });
});

// ── The day's things, the home list and the lock dial (the owner, 11-15: "make it useful; the lock screen
// very different from the home screen, centred") ─────────────────────────────────────────────────

type DayInput = Parameters<typeof dayItems>[0];
function todayLike(over: Partial<{ planned: Array<{ title: string; minutes: number }>; doneToday: string[]; focus: Array<{ text: string; done: boolean }>; tasks: Array<{ title: string; status: string; dueDate?: string; completedAt?: string }> }> = {}): DayInput {
    return {
        today: '2026-11-15',
        timezone: 'Asia/Kolkata',
        plan: { planned: over.planned ?? [], doneToday: (over.doneToday ?? []).map((title) => ({ title })), estMinutes: (over.planned ?? []).reduce((s, p) => s + p.minutes, 0) },
        focus: { items: over.focus ?? [] },
        tasks: over.tasks ?? [],
        goals: [{ title: 'Backend SDE offer', daysLeft: 182, progress: { done: 1, total: 6 } }],
    } as unknown as DayInput;
}

describe('dayItems', () => {
    const now = new Date('2026-11-15T12:00:00Z'); // 17:30 in India
    it('reviews, focus lines and the tasks due today or late (with those done today); open first, then done', () => {
        const d = dayItems(
            todayLike({
                planned: [{ title: 'Monotonic stack', minutes: 8 }],
                doneToday: ['Heaps'],
                focus: [
                    { text: 'Two mediums', done: true },
                    { text: 'Read DDIA ch 5', done: false },
                ],
                tasks: [
                    { title: 'Mock interview', status: 'pending', dueDate: '2026-11-15T13:30:00Z' }, // 19:00 today
                    { title: 'Contest write-up', status: 'pending', dueDate: '2026-11-14T10:00:00Z' }, // yesterday
                    { title: 'Next week', status: 'pending', dueDate: '2026-11-20T10:00:00Z' }, // not today
                    { title: 'Booked the room', status: 'complete', completedAt: '2026-11-15T05:00:00Z' },
                    { title: 'Done last week', status: 'complete', completedAt: '2026-11-08T05:00:00Z' },
                ],
            }),
            now,
        );
        expect(d.items.map((i) => [i.kind, i.title, i.meta, i.done])).toEqual([
            ['review', 'Monotonic stack', '8 min', false],
            ['focus', 'Read DDIA ch 5', '', false],
            ['task', 'Contest write-up', '1 day late', false],
            ['task', 'Mock interview', '7 pm', false],
            ['review', 'Heaps', '', true],
            ['focus', 'Two mediums', '', true],
            ['task', 'Booked the room', '', true],
        ]);
        expect(d.counts).toEqual({ reviews: { done: 1, total: 2 }, focus: { done: 1, total: 2 }, tasks: { done: 1, total: 3 }, minutesLeft: 8 });
        expect(d.goal).toEqual({ title: 'Backend SDE offer', daysLeft: 182, done: 1, total: 6 });
    });

    it('"Hide titles": plain words for every title, the goal too', () => {
        const d = dayItems(todayLike({ planned: [{ title: 'Secret topic', minutes: 5 }], focus: [{ text: 'Private focus', done: false }], tasks: [{ title: 'Private task', status: 'pending', dueDate: '2026-11-15T13:30:00Z' }] }), now, false);
        expect(d.items.map((i) => i.title)).toEqual(['A review', 'A focus line', 'A task']);
        expect(d.goal?.title).toBe('Your goal');
        expect(JSON.stringify(d)).not.toMatch(/Secret|Private|Backend/);
    });
});

describe('the two pictures', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    const day = dayItems(
        todayLike({
            planned: [{ title: 'Monotonic stack', minutes: 8 }, { title: 'DP: 0/1 knapsack', minutes: 8 }],
            doneToday: ['Heaps'],
            focus: [{ text: 'Read DDIA ch 5', done: false }],
        }),
        now,
    );
    const a = { ...ambientFor(brief({ planned: 2, est: 16, done: 1 }), 'normal', 17, date), ...day };

    const ahead = {
        pickUp: { id: 'pu_s1', at: '', text: '3Sum', detail: 'has the two-pointer idea; duplicates still break it' },
        comingUp: [
            { id: 'tk_t1', at: 'Sun', text: 'Get a gift for my sister' },
            { id: 'tk_t2', at: 'Mon', text: 'Book the dentist' },
            { id: 'th_e1', at: 'Thu 3 pm', text: 'Interview' },
            { id: 'tk_t9', at: 'Fri', text: 'A fourth one' },
        ],
    };

    it('home (stage 16): what is ahead at the left above the dock: Pick up, Coming up; no number, minutes, date, dots or reminders', () => {
        const svg = wallpaperSvg({ ...a, ...ahead, reminders: [{ at: '6:30 pm', text: 'Call the bank' }] }, 1080, 2340, 'dark', 'home');
        expect(svg).toContain('id="hill0"');
        for (const words of ['>Pick up<', '>3Sum<', '>Coming up<', '>Sun<', '>Get a gift for my sister<', '>Thu 3 pm<', '>Interview<']) expect(svg).toContain(words);
        // Where they stopped, wrapped (two lines at most).
        expect([...svg.matchAll(/>([^<>]+)<\/text>/g)].map((m) => m[1]).join(' ')).toContain('has the two-pointer idea; duplicates still break it');
        expect(svg).not.toContain('A fourth one');
        for (const gone of ['left today', 'about 16 min', 'SUNDAY 15 NOVEMBER', 'Call the bank', 'Monotonic stack']) expect(svg).not.toContain(gone);
        // The days in one column, the words after them in another.
        const xs = ['Get a gift for my sister', 'Book the dentist', 'Interview'].map((t) => Number(new RegExp(`<text x="([\\d.]+)" [^>]*>${t}<`).exec(svg)?.[1]));
        expect(new Set(xs).size).toBe(1);
        // Nothing smaller than the quiet size (0.031 of the width); the block's foot above the dock.
        for (const m of svg.matchAll(/font-size="([\d.]+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(1080 * 0.031 - 0.1);
        const ys = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1]));
        expect(Math.max(...ys)).toBeLessThanOrEqual(2340 * 0.745);
        expect(Math.min(...ys)).toBeGreaterThan(2340 * 0.36);
    });

    it('home: each part only when there is one; nothing ahead and no thought: the picture alone', () => {
        const none = wallpaperSvg(a, 1080, 2340, 'dark', 'home');
        expect(none.match(/<text/g)).toBeNull();
        const onlyAhead = wallpaperSvg({ ...a, comingUp: ahead.comingUp }, 1080, 2340, 'dark', 'home');
        expect(onlyAhead).not.toContain('Pick up');
        expect(onlyAhead).toContain('Coming up');
        const onlyPick = wallpaperSvg({ ...a, pickUp: ahead.pickUp }, 1080, 2340, 'dark', 'home');
        expect(onlyPick).toContain('Pick up');
        expect(onlyPick).not.toContain('Coming up');
    });

    it("home: the buddy's thought last (its mark, the words wrapped, three lines at most); alone it is the only block", () => {
        const insight = 'Your sharpest hours are before noon, so keep the monotonic stack review there tomorrow';
        const svg = wallpaperSvg({ ...a, insight }, 1080, 2340, 'dark', 'home');
        expect(svg).toContain('M7.9 20A9 9 0 1 0 4 16.1L2 22Z'); // the message mark
        const rows = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" font-family="Inter" font-size="([\d.]+)" font-weight="400"[^>]*>([^<]+)</g)].filter((m) => insight.includes(m[4]!));
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(rows.length).toBeLessThanOrEqual(3);
        expect(rows.map((m) => m[4]).join(' ')).toBe(insight);
        expect(new Set(rows.map((m) => m[1])).size).toBe(1); // one left edge, after the mark
        expect(Number(rows[0]![3])).toBeCloseTo(1080 * 0.039, 0);
        // With what is ahead: the thought comes last, and the whole block grew upward.
        const both = wallpaperSvg({ ...a, ...ahead, insight }, 1080, 2340, 'dark', 'home');
        const yOf = (s: string, words: string) => Number(new RegExp(`<text x="[\\d.]+" y="([\\d.]+)"[^>]*>${words}<`).exec(s)?.[1]);
        expect(yOf(both, rows[0]![4]!)).toBeGreaterThan(yOf(both, 'Interview'));
        // Never a fourth line: a long one steps down to the quiet size, then ends with "…".
        const long = wallpaperSvg({ ...a, insight: `${insight} and then ${insight} and once more ${insight}` }, 1080, 2340, 'dark', 'home');
        const longRows = [...long.matchAll(/font-weight="400"[^>]*>([^<]+)</g)].filter((m) => m[1]!.length > 10);
        expect(longRows.length).toBeLessThanOrEqual(3);
        for (const m of long.matchAll(/font-size="([\d.]+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(1080 * 0.031 - 0.1);
    });

    it('home (B8): drawn for the zoom the phone shows it at: the words smaller about the centre, the backdrop whole', () => {
        const flat = wallpaperSvg({ ...a, ...ahead }, 1080, 2340, 'dark', 'home');
        const zoomed = wallpaperSvg({ ...a, ...ahead }, 1080, 2340, 'dark', 'home', { zoom: 1.1 });
        // s = 1/1.1; the shift keeps the centre: 540 × (1 − s), 1170 × (1 − s).
        expect(zoomed).toContain('<g transform="matrix(0.90909 0 0 0.90909 49.1 106.4)">');
        expect(flat).not.toContain('<g transform="matrix(');
        // Only the words and marks are inside the group: the hills are drawn before it, at full size.
        const group = zoomed.slice(zoomed.indexOf('<g transform="matrix('));
        expect(group).not.toContain('hill0');
        expect(group).toContain('>3Sum<');
        // The zoom a picture may be drawn for: 1 to 1.25.
        expect([pictureZoom('1.1'), pictureZoom(2), pictureZoom(0.9), pictureZoom('x'), pictureZoom(undefined)]).toEqual([1.1, 1.25, 1, 1, 1]);
        // A style's marks that belong with the words zoom with them (Mono's frame).
        const mono = wallpaperSvg({ ...a, ...ahead }, 1080, 2340, 'dark', 'home', { style: 'mono', zoom: 1.1 });
        expect(mono.slice(mono.indexOf('<g transform="matrix(')).match(/<rect x="64.8"/)).not.toBeNull();
    });

    it('lock (B4): the buddy line is the main thing, the day in numbers and the goal days under it; no hills', () => {
        const svg = wallpaperSvg({ ...a, line: { dayId: 'd1', slot: 'morning', text: 'Stop before midnight tonight' } }, 1080, 2340, 'dark', 'lock');
        expect(svg).not.toContain('id="hill0"');
        expect(svg).toContain('id="lineGlow"');
        const said = [...svg.matchAll(/>([^<>]+)<\/text>/g)].map((m) => m[1]).join(' ');
        expect(said).toContain('Stop before midnight tonight');
        // B8: one row of the day in words (no icons), then the goal's days (stage 16: no estimated time).
        expect(svg).toContain('>2 reviews · 1 focus line<');
        expect(svg).toContain('>left<');
        expect(svg).toContain('182 days to Backend SDE offer');
        expect(svg).not.toContain('Monotonic stack');
        // The ring of the day over the line (the owner, 11-16: a whole circle, not the half arc): one segment per thing.
        expect((svg.match(/<path d="M[^"]+A[^"]+" fill="none" stroke=/g) ?? []).length).toBeGreaterThanOrEqual(3);
        // Without a line: the dial of the day (what is left inside the ring), as before the buddy.
        const plain = wallpaperSvg(a, 1080, 2340, 'dark', 'lock');
        expect(plain).toContain('>left today<');
        // Stage 16: the "Next ·" row is gone (today's rows take its place).
        expect(plain).not.toContain('Next ·');
        expect(plain).toContain('>2 reviews · 1 focus line<');
        // A style draws its own backdrop and ring; an unknown style is the sky.
        const mono = wallpaperSvg({ ...a, line: { dayId: 'd1', slot: 'morning', text: 'Stop before midnight tonight' } }, 1080, 2340, 'dark', 'lock', { style: 'mono', color: 'lime' });
        expect((mono.match(/<line /g) ?? []).length).toBe(60);
        expect(wallpaperSvg(a, 1080, 2340, 'dark', 'lock', { style: 'nope' })).toBe(plain);
        // All of it between the clock and the fingerprint.
        const ys = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1]));
        expect(Math.min(...ys)).toBeGreaterThan(2340 * 0.33);
        expect(Math.max(...ys)).toBeLessThan(2340 * 0.79);
    });

    it('lock (stage 16): today’s next things under the day’s row, the times in one column; the goal only when given; never an estimated time', () => {
        const today = [
            { id: 'rm_1', at: '6:30 pm', text: 'Call the bank' },
            { id: 'th_1', at: '9 pm', text: 'Contest on Codeforces' },
            { id: 'tk_1', at: '', text: 'Send the invoice' },
        ];
        const line = { dayId: 'd1', slot: 'evening', text: 'Stop before midnight tonight' };
        for (const withLine of [true, false]) {
            const svg = wallpaperSvg({ ...a, today, ...(withLine ? { line } : {}) }, 1080, 2340, 'dark', 'lock');
            for (const r of today) expect(svg).toContain(`>${r.text}<`);
            expect(svg).toContain('>6:30 pm<');
            expect(svg).toContain('>9 pm<');
            const xs = today.map((r) => Number(new RegExp(`<text x="([\\d.]+)" [^>]*>${r.text}<`).exec(svg)?.[1]));
            expect(new Set(xs).size).toBe(1);
            expect(svg).not.toMatch(/\d+ min</);
            // Between the clock and the fingerprint.
            const ys = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1]));
            expect(Math.min(...ys)).toBeGreaterThan(2340 * 0.26);
            expect(Math.max(...ys)).toBeLessThan(2340 * 0.8);
        }
        // The goal's row only when the picture is given one (their switch, stage 16).
        expect(wallpaperSvg({ ...a, today, line }, 1080, 2340, 'dark', 'lock')).toContain('182 days to Backend SDE offer');
        expect(wallpaperSvg({ ...a, today, line, goal: null }, 1080, 2340, 'dark', 'lock')).not.toContain('days to');
    });

    it('lock (the owner, 11-21): the schedule reads as an agenda at the left: times in one column, "Today" and "Late" quieter, the titles in one column after them; the line at the same left edge; the ring without its glow', () => {
        const today = [
            { id: 'rm_1', at: '6:30 pm', text: 'Call the bank' },
            { id: 'tk_1', at: '', text: 'Send the invoice' },
            { id: 'tk_2', at: 'late', text: 'Renew the passport' },
        ];
        for (const withLine of [true, false]) {
            const svg = wallpaperSvg({ ...a, today, ...(withLine ? { line: { dayId: 'd1', slot: 'evening', text: 'Stop before midnight tonight' } } : {}) }, 1080, 2400, 'dark', 'lock');
            const cell = (words: string) => new RegExp(`<text x="([\\d.]+)" y="([\\d.]+)"( text-anchor="end")? font-family="Inter" font-size="[\\d.]+" font-weight="(\\d+)"[^>]*fill="([^"]+)">${words}<`).exec(svg);
            const times = ['6:30 pm', 'Today', 'Late'].map(cell);
            // One left edge for the times, at the picture's left like the home picture (the owner, 11-21); a real time
            // stands out, "Today" and "Late" are quieter.
            for (const t of times) expect(t?.[3], `${withLine}`).toBeUndefined();
            expect(new Set(times.map((t) => t?.[1])).size).toBe(1);
            expect(Number(times[0]?.[1])).toBeCloseTo(1080 * 0.08, 0);
            expect(times.map((t) => t?.[4])).toEqual(['600', '500', '500']);
            expect(times[1]?.[5]).not.toBe(times[0]?.[5]);
            // One left edge for the titles, after the times, each on its time's baseline.
            const titles = today.map((r) => cell(r.text));
            expect(new Set(titles.map((t) => t?.[1])).size).toBe(1);
            expect(Number(titles[0]?.[1])).toBeGreaterThan(Number(times[0]?.[1]));
            titles.forEach((t, i) => expect(t?.[2]).toBe(times[i]?.[2]));
            // Sentence case, never caps.
            expect(svg).not.toMatch(/>(TODAY|LATE|LEFT|LEFT TODAY|COMING UP|PICK UP)</);
            // No chat mark on the lock (the owner, 11-21: the home picture's thought keeps it).
            expect(svg).not.toContain('M7.9 20A9 9 0 1 0 4 16.1L2 22Z');
            // No soft light under the ring's lit part.
            expect(svg).not.toContain('stroke-opacity="0.16"');
        }
    });

    it('lock (stage 16): on a short phone two rows always show (the ring shrinks, then goes); the third only when it fits', () => {
        const today = [
            { id: 'rm_1', at: '6:30 pm', text: 'Call the bank' },
            { id: 'rm_2', at: '9 pm', text: 'Contest on Codeforces' },
            { id: 'tk_1', at: '', text: 'Send the invoice' },
        ];
        const long = 'You said the interview prep felt rushed last week; one mock system design today would make Friday easier.';
        for (const [w, h] of [[720, 1600], [1080, 1920], [1080, 2340]] as const) {
            const svg = wallpaperSvg({ ...a, today, line: { dayId: 'd', slot: 'evening', text: long } }, w, h, 'dark', 'lock', { iconSlot: true });
            expect(svg, `${w}x${h}`).toContain('>Call the bank<');
            expect(svg, `${w}x${h}`).toContain('>Contest on Codeforces<');
            const ys = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1]));
            expect(Math.max(...ys), `${w}x${h}`).toBeLessThan(h * 0.8);
        }
        // A tall phone keeps all three and the ring.
        const tall = wallpaperSvg({ ...a, today, line: { dayId: 'd', slot: 'evening', text: 'Stop before midnight tonight' } }, 1080, 2400, 'dark', 'lock');
        expect(tall).toContain('>Send the invoice<');
        expect(tall).toContain('>left<');
    });

    it('the live lock screen (app 0.4.0): a band under the words for the notification icons, its place on the picture', () => {
        const withLine = { ...a, line: { dayId: 'd1', slot: 'morning', text: 'Stop before midnight tonight' } };
        const plain = wallpaperSvg(withLine, 1080, 2340, 'dark', 'lock');
        const live = wallpaperSvg(withLine, 1080, 2340, 'dark', 'lock', { iconSlot: true });
        expect(plain).not.toContain('data-icons');
        const [cy, size, ink] = (/data-icons="([^"]+)"/.exec(live)?.[1] ?? '').split(',');
        expect(Number(size)).toBeCloseTo(54, 0);
        expect(ink).toMatch(/^#[0-9A-F]{8}$/);
        // The band sits under the last row, and the group moved up to keep it centred.
        const lastText = Math.max(...[...live.matchAll(/<text x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1])));
        expect(Number(cy)).toBeGreaterThan(lastText);
        expect(Number(cy)).toBeLessThan(2340 * 0.8);
        const firstY = (svg: string) => Number(/<text x="[\d.]+" y="([\d.]+)"/.exec(svg)?.[1]);
        expect(firstY(live)).toBeLessThan(firstY(plain));
        // The dial (no line) leaves the band too.
        expect(wallpaperSvg(a, 1080, 2340, 'dark', 'lock', { iconSlot: true })).toMatch(/^<svg [^>]*data-icons="[\d.]+,[\d.]+,#[0-9A-F]{8}"/);
        expect([argbHex('rgba(255,255,255,0.84)'), argbHex('#F7F5F2'), argbHex('nope')]).toEqual(['#D6FFFFFF', '#FFF7F5F2', '#FFFFFFFF']);
    });

    it('lock: a done day is the whole dial lit with a tick; an empty day says so', () => {
        const done = { ...a, ...dayItems(todayLike({ doneToday: ['Heaps', 'Tries'] }), now) };
        const svg = wallpaperSvg(done, 1080, 2340, 'light', 'lock');
        expect(svg).toContain('>Done for today<');
        // Once: inside the ring, not again under it (seen in the day-in-the-life sheet, 11-21).
        expect(svg.split('>Done for today<').length - 1).toBe(1);
        expect(svg).not.toContain('left today');
        const free = wallpaperSvg({ ...a, ...dayItems(todayLike(), now) }, 1080, 2340, 'light', 'lock');
        // A free day: the tick alone (no "Free", no "Done for today").
        expect(free).not.toMatch(/>(A free day|Free)</);
        expect(free).not.toContain('>Done for today<');
    });
});
