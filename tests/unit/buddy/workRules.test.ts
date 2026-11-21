// The work picture's pure rules (ECOSYSTEM_V2_PLAN stage 12): when two lines say the same thing in words (a labelled
// set of 40 pairs fixes the two thresholds: a wrong "same" loses an outcome, so no different pair may be the same; a
// same pair the words can't prove must at least be shown to the writer as close), what a thing is, its newest state
// by when it happened (never by arrival), the views (a day, open, decided), what a writer is shown, and project names.
import { describe, expect, it } from 'vitest';
import {
    buildPicture,
    closeWork,
    dayLines,
    decisionsOf,
    laterOf,
    laterWord,
    matchProject,
    openThings,
    sameWork,
    workMatch,
    writerView,
    type PicLine,
} from '../../../src/services/buddy/workRules';

/** Different apps' words for one outcome: never two entries (sameWork skips it, or closeWork shows it to the writer). */
const SAME: Array<[string, string]> = [
    ['Raised the nginx proxy timeout to 120 s so long uploads stop failing', 'Fixed the upload timeouts by raising the proxy timeout'],
    ['Fixed the GST rounding in the invoice report', 'Fixed GST rounding in the invoice report (per line, then summed)'],
    ['Decided to keep the old export until the client signs off', 'Decided: keep the old export until client sign-off'],
    ['Migrated the jobs table to Postgres', 'Moved the jobs table from MySQL to Postgres'],
    ['Added rate limiting to the login endpoint', 'Rate-limited the login endpoint (10 tries per 15 minutes)'],
    ['Fixed the memory leak in the websocket handler', 'Fixed a websocket handler memory leak'],
    ['Shipped the credit note export', 'Credit note export shipped and merged'],
    ['Rotated the deploy keys on the build server', "Rotated the build server's deploy keys"],
    ['Decided to use Redis for the session store', 'Going with Redis as the session store'],
    ['Wrote the migration for the orders table', 'Wrote the orders table migration'],
    ['Fixed the flaky checkout test', 'Fixed the flaky test in checkout'],
    ['Set up the staging deploy pipeline', 'Staging deploy pipeline set up in CI'],
    ['Found that the rollback script skips the cache', 'The rollback script skips the cache (found in review)'],
    ['Upgraded Next.js to 16 and fixed the build', 'Upgraded to Next.js 16; build fixed'],
    ['Decided to drop the legacy API in March', 'Decided the legacy API goes away in March'],
    ['Fixed the timezone bug in the reminder emails', "Reminder emails now use the user's timezone (bug fixed)"],
    ['Added indexes to the payments table', 'Indexed the payments table'],
    ['Stuck on the Safari login loop', 'Safari login loop still not fixed'],
    ['Reviewed the payroll migration', 'Reviewed the payroll migration PR'],
    ['Cut the dashboard load time from 4 s to 1 s', 'Dashboard now loads in 1 s instead of 4 s'],
];

/** Two outcomes in the same area: both must be written (a "same" here would lose one). */
const DIFFERENT: Array<[string, string]> = [
    ['Fixed the GST rounding in the invoice report', 'Fixed the GST rounding in the credit note report'],
    ['Raised the nginx proxy timeout to 120 s', 'Raised the database connection timeout to 30 s'],
    ['Decided to use Redis for the session store', 'Decided to use Redis for the job queue'],
    ['Migrated the jobs table to Postgres', 'Migrated the users table to Postgres'],
    ['Added rate limiting to the login endpoint', 'Added logging to the login endpoint'],
    ['Fixed the flaky checkout test', 'Fixed the flaky signup test'],
    ['Wrote the migration for the orders table', 'Wrote the rollback for the orders table migration'],
    ['Rotated the deploy keys on the build server', 'Rotated the API keys for the payment gateway'],
    ['Fixed the memory leak in the websocket handler', 'Fixed the reconnect bug in the websocket handler'],
    ['Shipped the credit note export', 'Shipped the invoice export'],
    ['Upgraded Next.js to 16', 'Upgraded React to 19'],
    ['Decided to drop the legacy API in March', 'Decided to keep the legacy API until June'],
    ['Added indexes to the payments table', 'Added a foreign key to the payments table'],
    ['Fixed the timezone bug in the reminder emails', 'Fixed the unsubscribe link in the reminder emails'],
    ['Set up the staging deploy pipeline', 'Set up the production deploy pipeline'],
    ['Reviewed the payroll migration', 'Reviewed the payroll report'],
    ['Stuck on the Safari login loop', 'Stuck on the Safari video autoplay'],
    ['Cut the dashboard load time', 'Cut the report export time'],
    ['Fixed the upload timeouts', 'Fixed the upload progress bar'],
    ['Found that the rollback script skips the cache', 'Found that the deploy script skips the tests'],
];

describe('same thing, in words (the 40 labelled pairs)', () => {
    it('never calls two different outcomes the same (a lost outcome is the costly miss)', () => {
        const wrong = DIFFERENT.filter(([a, b]) => sameWork(a, b) || sameWork(b, a));
        expect(wrong, JSON.stringify(wrong.map(([a, b]) => [a, b, workMatch(a, b)]))).toEqual([]);
    });

    it('shows nearly every same pair to the writer (same, or close), and is symmetric', () => {
        const seen = SAME.filter(([a, b]) => sameWork(a, b) || closeWork(a, b));
        const missed = SAME.filter((p) => !seen.includes(p)).map(([a, b]) => [a, b, workMatch(a, b)]);
        expect(seen.length, JSON.stringify(missed)).toBeGreaterThanOrEqual(17);
        for (const [a, b] of [...SAME, ...DIFFERENT]) {
            expect(sameWork(a, b)).toBe(sameWork(b, a));
            expect(closeWork(a, b)).toBe(closeWork(b, a));
        }
    });

    it('the same words are the same line; nothing in common is neither', () => {
        expect(sameWork('Fixed the GST rounding!', 'fixed the gst rounding')).toBe(true);
        // More detail is not proof of the same line (the rollback pair above adds one word too): the writer judges it, shown it as close.
        expect(sameWork('Fixed the GST rounding in the invoice report', 'Fixed the GST rounding in the invoice report and its tests')).toBe(false);
        expect(closeWork('Fixed the GST rounding in the invoice report', 'Fixed the GST rounding in the invoice report and its tests')).toBe(true);
        expect(sameWork('Wrote docs', 'Fixed CI')).toBe(false);
        expect(closeWork('Wrote docs', 'Fixed CI')).toBe(false);
    });
});

const T0 = Date.UTC(2026, 10, 20, 4, 0);
let n = 0;
function line(over: Partial<PicLine> & { text: string }): PicLine {
    n++;
    const at = over.happenedAt ?? new Date(T0 + n * 60_000);
    return {
        id: over.id ?? `l${n}`,
        day: '2026-11-20',
        project: 'api',
        kind: 'did',
        at: null,
        source: 'agent',
        app: 'ChatGPT',
        office: false,
        hidden: false,
        sameAsId: null,
        followsId: null,
        sessionKey: `w_${n}`,
        createdAt: at,
        position: 0,
        ...over,
        happenedAt: at,
    };
}
const hour = (h: number) => new Date(Date.UTC(2026, 10, 20, h, 0));

describe('things and their state', () => {
    it('a chain is one thing; its state is the newest by when it happened, so a late older line never becomes the newest', () => {
        const open = line({ id: 'a', kind: 'stuck', text: 'Upload fails on big files', happenedAt: hour(5) });
        const fixed = line({ id: 'b', kind: 'did', text: 'Raised the proxy timeout; uploads work', followsId: 'a', happenedAt: hour(9) });
        // Claude Code's older summary arrives last, news on the same thing, from earlier in the day.
        const late = line({ id: 'c', kind: 'stuck', text: 'Uploads still failing after the retry change', followsId: 'a', happenedAt: hour(7), createdAt: hour(11) });
        const p = buildPicture([late, fixed, open]);
        expect(p.things).toHaveLength(1);
        expect(p.things[0]!.lines.map((l) => l.id)).toEqual(['a', 'c', 'b']);
        expect(p.things[0]!.newest.id).toBe('b');
        expect(openThings(p, '2026-11-20')).toEqual([]);
        expect(dayLines(p, '2026-11-20').map((l) => l.id)).toEqual(['b']);
    });

    it('a folded repeat is never shown or counted, and news on it counts on the line it repeats', () => {
        const one = line({ id: 'one', kind: 'stuck', text: 'Login loop on Safari' });
        const again = line({ id: 'two', kind: 'stuck', text: 'Safari users stuck in a login loop', sameAsId: 'one', app: 'Claude' });
        const fix = line({ id: 'fix', kind: 'did', text: 'Fixed the Safari login loop (cookie SameSite)', followsId: 'two' });
        const gone = line({ id: 'gone', text: 'Renamed the folders', hidden: true });
        const p = buildPicture([one, again, fix, gone]);
        expect(p.things).toHaveLength(1);
        expect(p.things[0]!.lines.map((l) => l.id)).toEqual(['one', 'fix']);
        expect(dayLines(p, '2026-11-20').map((l) => l.id)).toEqual(['fix']);
    });

    it('a chain survives an ancestor that is not loaded, and a loop in the data never hangs', () => {
        const x = line({ id: 'x', followsId: 'old-not-loaded', text: 'Fixed the cache key' });
        const y = line({ id: 'y', followsId: 'old-not-loaded', kind: 'decided', text: 'Decided to drop the cache' });
        const loopA = line({ id: 'p', followsId: 'q', text: 'A' });
        const loopB = line({ id: 'q', followsId: 'p', text: 'B' });
        const p = buildPicture([x, y, loopA, loopB]);
        expect(p.thingOf.get('x')).toBe(p.thingOf.get('y'));
        expect(p.things.length).toBeGreaterThanOrEqual(2);
    });

    it('a day shows each thing once; an earlier day says what came later', () => {
        const mon = line({ id: 'm', day: '2026-11-19', kind: 'stuck', text: 'Export times out', happenedAt: new Date(Date.UTC(2026, 10, 19, 6)) });
        const monLater = line({ id: 'm2', day: '2026-11-19', kind: 'stuck', text: 'Export times out on big months', followsId: 'm', happenedAt: new Date(Date.UTC(2026, 10, 19, 9)) });
        const tue = line({ id: 't', day: '2026-11-20', kind: 'did', text: 'Fixed the export timeout (streamed rows)', followsId: 'm', happenedAt: hour(6) });
        const p = buildPicture([mon, monLater, tue]);
        expect(dayLines(p, '2026-11-19').map((l) => l.id)).toEqual(['m2']);
        expect(laterOf(p.byId.get('m2')!, p)?.id).toBe('t');
        expect(laterOf(p.byId.get('t')!, p)).toBeNull();
        expect(laterWord('stuck', 'did')).toBe('fixed');
        expect(laterWord('decided', 'decided')).toBe('changed');
        expect(laterWord('did', 'stuck')).toBe('reopened');
        expect(laterWord('next', 'did')).toBe('done');
    });

    it('open: problems 30 days, next steps 3 days, unless something followed them', () => {
        const old = line({ id: 'old', day: '2026-10-10', kind: 'stuck', text: 'Old problem' });
        const open = line({ id: 'open', day: '2026-11-01', kind: 'stuck', text: 'Webhook retries pile up' });
        const nextOld = line({ id: 'n1', day: '2026-11-15', kind: 'next', text: 'Add the audit log' });
        const nextNew = line({ id: 'n2', day: '2026-11-19', kind: 'next', text: 'Write the release notes' });
        const p = buildPicture([old, open, nextOld, nextNew]);
        expect(openThings(p, '2026-11-20').map((t) => t.newest.id).sort()).toEqual(['n2', 'open']);
    });

    it('decided: each decision at its newest state, with the one it changed', () => {
        const a = line({ id: 'd1', kind: 'decided', text: 'Decided to keep MySQL for now', happenedAt: hour(5) });
        const b = line({ id: 'd2', kind: 'decided', text: 'Decided to move to Postgres: we need the joins', followsId: 'd1', happenedAt: hour(8) });
        const c = line({ id: 'd3', kind: 'did', text: 'Started the Postgres migration', followsId: 'd2', happenedAt: hour(9) });
        const other = line({ id: 'e', kind: 'decided', text: 'Decided to ship on Friday' });
        const d = decisionsOf(buildPicture([a, b, c, other]));
        expect(d.map((x) => [x.line.id, x.was?.id ?? null]).sort()).toEqual([
            ['d2', 'd1'],
            ['e', null],
        ]);
    });
});

describe('what a writer is shown (W5)', () => {
    it('what is open and the day’s other lines; a line close in words first; the thing just written left out', () => {
        const open = line({ id: 'o', kind: 'stuck', text: 'Upload fails on big files', project: 'api' });
        const a = line({ id: 'a', text: 'Updated the README', project: 'docs' });
        const b = line({ id: 'b', text: 'Raised the proxy timeout to 120 s for uploads', project: 'api' });
        const mine = line({ id: 'mine', text: 'Wrote the release notes', project: 'api' });
        const p = buildPicture([open, a, b, mine]);
        const v = writerView(p, { day: '2026-11-20', today: '2026-11-20', project: 'api', text: 'Fixed the upload timeouts by raising the proxy timeout', exclude: ['mine'] });
        expect(v.open.map((l) => l.id)).toEqual(['o']);
        expect(v.day.map((d) => [d.line.id, d.close])).toEqual([
            ['b', true],
            ['a', false],
        ]);
    });
});

describe('projects without Projects', () => {
    it('a given name matches an existing one loosely; none given is other', () => {
        const existing = ['second_brain', 'erp', 'payments api'];
        expect(matchProject('Second Brain', existing)).toBe('second_brain');
        expect(matchProject('ERP', existing)).toBe('erp');
        expect(matchProject('API payments', existing)).toBe('payments api');
        expect(matchProject('Recollect', existing)).toBe('recollect');
        expect(matchProject('', existing)).toBe('other');
        expect(matchProject(undefined, existing)).toBe('other');
    });
});
