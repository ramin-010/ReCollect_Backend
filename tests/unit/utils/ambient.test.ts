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
        expect(svg).toContain(`>${date.toUpperCase()}<`); // the date as a small eyebrow (B8)
        expect(svg).toContain('Done for today');
        expect(svg).toContain('mask="url(#crescent)"');
        expect(svg.match(/<text/g)).toHaveLength(2);
    });

    it('the sky follows the state; the last seven days show as dots under the lines', () => {
        const week = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'].map((day, i) => ({ day, active: i !== 2 }));
        const morning = wallpaperSvg({ ...ambientFor(brief({ planned: 3, est: 12 }), 'normal', 8, date), week }, 1080, 2340, 'light');
        const evening = wallpaperSvg({ ...ambientFor(brief({ planned: 1, est: 5, done: 2 }), 'normal', 20, date), week }, 1080, 2340, 'light');
        // The state is the sky's light (B8: the state's pill is gone; the date is the eyebrow).
        expect(morning).not.toContain('>Morning<');
        expect(morning.match(/<linearGradient id="sky"[^]*?<\/linearGradient>/)?.[0]).not.toBe(evening.match(/<linearGradient id="sky"[^]*?<\/linearGradient>/)?.[0]);
        // Seven dots, six filled and one hollow of the same size; the weekday letters under them end on Sunday (today).
        expect(morning.match(/<circle [^>]*r="11.3" fill="#211F1D"/g)).toHaveLength(6);
        expect(morning.match(/<circle [^>]*r="10" fill="none"/g)).toHaveLength(1);
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

// ── The day's things, the home list and the lock dial (Ramin 11-15: "make it useful; the lock screen
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

    it('home (B4, B8): the sky over its hills and the day in numbers: the numeral, "left today" and the time beside it; no list', () => {
        const svg = wallpaperSvg(a, 1080, 2340, 'dark', 'home');
        expect(svg).toContain('id="hill0"');
        expect(svg).toMatch(/font-size="178.2" font-weight="600"[^>]*>3<\/text>/); // the numeral, 0.165 of the width
        expect(svg).toContain('>left today<');
        expect(svg).toContain('>about 16 min<');
        expect(svg).toContain('>SUNDAY 15 NOVEMBER<');
        expect(svg).not.toContain('>Monotonic stack<');
        expect(svg).not.toContain('>Heaps<');
        // Nothing smaller than the quiet size (0.031 of the width).
        for (const m of svg.matchAll(/font-size="([\d.]+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(1080 * 0.031 - 0.1);
    });

    it('home (B8): drawn for the zoom the phone shows it at: the words smaller about the centre, the backdrop whole', () => {
        const flat = wallpaperSvg(a, 1080, 2340, 'dark', 'home');
        const zoomed = wallpaperSvg(a, 1080, 2340, 'dark', 'home', { zoom: 1.1 });
        // s = 1/1.1; the shift keeps the centre: 540 × (1 − s), 1170 × (1 − s).
        expect(zoomed).toContain('<g transform="matrix(0.90909 0 0 0.90909 49.1 106.4)">');
        expect(flat).not.toContain('<g transform="matrix(');
        // Only the words and marks are inside the group: the hills are drawn before it, at full size.
        const group = zoomed.slice(zoomed.indexOf('<g transform="matrix('));
        expect(group).not.toContain('hill0');
        expect(group).toContain('>left today<');
        // The zoom a picture may be drawn for: 1 to 1.25.
        expect([pictureZoom('1.1'), pictureZoom(2), pictureZoom(0.9), pictureZoom('x'), pictureZoom(undefined)]).toEqual([1.1, 1.25, 1, 1, 1]);
        // A style's marks that belong with the words zoom with them (Mono's frame).
        const mono = wallpaperSvg(a, 1080, 2340, 'dark', 'home', { style: 'mono', zoom: 1.1 });
        expect(mono.slice(mono.indexOf('<g transform="matrix(')).match(/<rect x="64.8"/)).not.toBeNull();
    });

    it('lock (B4): the buddy line is the main thing, the day in numbers and the goal days under it; no hills', () => {
        const svg = wallpaperSvg({ ...a, line: { dayId: 'd1', slot: 'morning', text: 'Stop before midnight tonight' } }, 1080, 2340, 'dark', 'lock');
        expect(svg).not.toContain('id="hill0"');
        expect(svg).toContain('id="lineGlow"');
        const said = [...svg.matchAll(/>([^<>]+)<\/text>/g)].map((m) => m[1]).join(' ');
        expect(said).toContain('Stop before midnight tonight');
        // B8: one row of the day in words (no icons), then the goal's days.
        expect(svg).toContain('>2 reviews · 1 focus line · 16 min<');
        expect(svg).toContain('>LEFT<');
        expect(svg).toContain('182 days to Backend SDE offer');
        expect(svg).not.toContain('Monotonic stack');
        // The ring of the day over the line (Ramin 11-16: a whole circle, not the half arc): one segment per thing.
        expect((svg.match(/<path d="M[^"]+A[^"]+" fill="none" stroke=/g) ?? []).length).toBeGreaterThanOrEqual(3);
        // Without a line: the dial of the day (what is left inside the ring), as before the buddy.
        const plain = wallpaperSvg(a, 1080, 2340, 'dark', 'lock');
        expect(plain).toContain('>LEFT TODAY<');
        expect(plain).toContain('>Next · Monotonic stack · 8 min<');
        expect(plain).toContain('>2 reviews · 1 focus line · 16 min<');
        // A style draws its own backdrop and ring; an unknown style is the sky.
        const mono = wallpaperSvg({ ...a, line: { dayId: 'd1', slot: 'morning', text: 'Stop before midnight tonight' } }, 1080, 2340, 'dark', 'lock', { style: 'mono', color: 'lime' });
        expect((mono.match(/<line /g) ?? []).length).toBe(60);
        expect(wallpaperSvg(a, 1080, 2340, 'dark', 'lock', { style: 'nope' })).toBe(plain);
        // All of it between the clock and the fingerprint.
        const ys = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1]));
        expect(Math.min(...ys)).toBeGreaterThan(2340 * 0.33);
        expect(Math.max(...ys)).toBeLessThan(2340 * 0.79);
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
        expect(svg).not.toContain('left today');
        const free = wallpaperSvg({ ...a, ...dayItems(todayLike(), now) }, 1080, 2340, 'light', 'lock');
        expect(free).toContain('>A free day<');
    });
});
