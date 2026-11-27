// ECOSYSTEM_V2_PLAN stage 12: one picture of the work, from every chat. Connected chats log one outcome a call (written
// at once unless removed or already there that day; `on` makes it news on a known line); a late older line never
// becomes the newest; two writes at once see each other (the person's lock); an app folds, rewords, links or removes
// only its own lines; Claude Code's lists keep their rows' ids; what is open closes when a later line follows it; the
// same picture on every surface (get_work_log's views, the briefs, the night, /you); the person's two choices (keep a
// log; share work folders' lines with connected chats); the daily cap; off and paused.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { drainBuddyQueue } from '../../src/services/buddy/worker';
import { WEB_LINES_PER_DAY, changeLine, listWork, logLine, logWork, workForBrief, workForNight, workForWebBrief, type LogLineResult } from '../../src/services/buddy/work';
import { loadLearningContext } from '../../src/services/learningDb/common';
import { addDays, type DayString } from '../../src/services/learning';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

const fake = new FakeClaude();
beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    setAiClientForTests(fake);
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = '';
    setAiClientForTests(null);
});
beforeEach(async () => {
    fake.reset();
    await prisma.buddyChunk.deleteMany({});
});

/** Friday 20 Nov 2026, from 11:30 in Kolkata (the test person's clock is read through loadLearningContext). */
const AT = (min: number) => new Date(Date.UTC(2026, 10, 20, 6, min));
const CHATGPT = { app: 'ChatGPT' };
const CLAUDE = { app: 'Claude' };

async function setup(over: { workLog?: boolean; shareOfficeWork?: boolean } = {}) {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, workLog: over.workLog ?? true, ...(over.shareOfficeWork === false ? { shareOfficeWork: false } : {}) });
    const { today } = await loadLearningContext(user.id, AT(0));
    return { user, today };
}

const saved = (r: LogLineResult) => {
    if (r.status !== 'saved') throw new Error(`expected saved, got ${JSON.stringify(r)}`);
    return r;
};

describe('a connected chat logs one outcome (W1-W9)', () => {
    it('written at once with its app and time; the answer carries the picture; the same line that day is not written again', async () => {
        const { user, today } = await setup();
        const first = saved(await logLine(user.id, CHATGPT, { text: 'Fixed the GST rounding in the invoice report', kind: 'did', project: 'ERP' }, AT(0)));
        expect(first.line).toMatchObject({ kind: 'did', project: 'erp', day: today, app: 'ChatGPT' });
        const row = await prisma.workLine.findUniqueOrThrow({ where: { id: first.line._id } });
        expect([row.source, row.app, row.happenedAt?.toISOString(), row.sessionKey.startsWith('w_'), row.office]).toEqual(['agent', 'ChatGPT', AT(0).toISOString(), true, false]);
        // The same words and kind from the other app that day: already there, named with its id.
        const again = await logLine(user.id, CLAUDE, { text: 'Fixed the GST rounding in the invoice report.', kind: 'did', project: 'erp' }, AT(5));
        expect(again).toMatchObject({ status: 'already', line: { _id: first.line._id, app: 'ChatGPT' } });
        // The same words as an open problem is news, not a repeat: written.
        saved(await logLine(user.id, CLAUDE, { text: 'Fixed the GST rounding in the invoice report', kind: 'stuck' }, AT(6)));
        // A different outcome close in words: written, and the answer shows the close line first.
        const close = saved(await logLine(user.id, CLAUDE, { text: 'Fixed the GST rounding in the credit note report', kind: 'did', project: 'erp' }, AT(7)));
        expect(close.picture.today[0]).toMatchObject({ _id: first.line._id, close: true });
        expect(await prisma.workLine.count({ where: { userId: user.id } })).toBe(3);
    });

    it('a line they removed is never written again; off and paused write nothing; the day has a cap', async () => {
        const { user } = await setup();
        const one = saved(await logLine(user.id, CHATGPT, { text: 'Renamed the client folders', kind: 'did' }, AT(0)));
        expect((await api(user).delete(`/api/buddy/work/${one.line._id}`)).status).toBe(200);
        expect(await logLine(user.id, CLAUDE, { text: 'Renamed the client folders', kind: 'did' }, AT(1))).toEqual({ status: 'removed' });
        const screens = 'billing search profile checkout inbox calendar reports settings uploads alerts exports invoices refunds payouts coupons pricing teams roles audit webhooks tokens sessions devices backups imports themes widgets badges ratings'.split(' ');
        for (let i = 1; i < WEB_LINES_PER_DAY; i++) saved(await logLine(user.id, CHATGPT, { text: `Shipped the new ${screens[i - 1]} screen`, kind: 'did' }, AT(2 + i)));
        expect((await logLine(user.id, CHATGPT, { text: 'Wrote the onboarding guide', kind: 'did' }, AT(40))).status).toBe('full');
        // News on a known line is never refused by the cap (a fix must always be able to close its open line).
        const anyLine = await prisma.workLine.findFirstOrThrow({ where: { userId: user.id, hidden: false } });
        expect((await logLine(user.id, CHATGPT, { text: 'The billing screen shipped to every region', kind: 'did', on: anyLine.id }, AT(41))).status).toBe('saved');
        await api(user).patch('/api/buddy/settings', { paused: true });
        expect(await logLine(user.id, CHATGPT, { text: 'Wrote the onboarding guide', kind: 'did' }, AT(31))).toEqual({ status: 'paused' });
        await api(user).patch('/api/buddy/settings', { paused: false, workLog: false });
        expect(await logLine(user.id, CHATGPT, { text: 'Wrote the onboarding guide', kind: 'did' }, AT(32))).toEqual({ status: 'off' });
    });

    it('two writes of one fix at the same moment: the second sees the first (the lock); one literal repeat is written once', async () => {
        const { user } = await setup();
        const [a, b] = await Promise.all([
            logLine(user.id, CHATGPT, { text: 'Fixed the upload timeouts by raising the proxy timeout', kind: 'did', project: 'api' }, AT(0)),
            logLine(user.id, CLAUDE, { text: 'Raised the nginx proxy timeout to 120 s so long uploads stop failing', kind: 'did', project: 'api' }, AT(0)),
        ]);
        const sa = saved(a);
        const sb = saved(b);
        const sawOther = [sa.picture.today.some((l) => l._id === sb.line._id), sb.picture.today.some((l) => l._id === sa.line._id)];
        expect(sawOther.filter(Boolean)).toHaveLength(1);
        const [c, d] = await Promise.all([
            logLine(user.id, CHATGPT, { text: 'Merged the release branch', kind: 'did' }, AT(10)),
            logLine(user.id, CLAUDE, { text: 'Merged the release branch', kind: 'did' }, AT(10)),
        ]);
        expect([c.status, d.status].sort()).toEqual(['already', 'saved']);
    });
});

describe('stage 13: two or three results of one message in one call (`more`)', () => {
    it('each line written in order under one lock, with its own kind and `on`; the picture once; the first at the top level', async () => {
        const { user, today } = await setup();
        const open = saved(await logLine(user.id, CLAUDE, { text: 'Webhook retries pile up on the payments service', kind: 'stuck', project: 'api' }, AT(0)));
        const r = await logLine(
            user.id,
            CHATGPT,
            {
                text: 'Fixed the upload timeouts by raising the proxy timeout',
                kind: 'did',
                project: 'API',
                more: [
                    { text: 'Capped the webhook retries at five with backoff', kind: 'did', on: open.line._id },
                    { text: 'Decided to keep Postgres for the queue (one less service)', kind: 'decided' },
                ],
            },
            AT(5)
        );
        const s = saved(r);
        expect(s.line).toMatchObject({ kind: 'did', project: 'api', app: 'ChatGPT', day: today });
        expect(s.lines?.map((l) => l.status)).toEqual(['saved', 'saved', 'saved']);
        expect(s.lines?.[1]).toMatchObject({ line: { kind: 'did', project: 'api' }, follows: { _id: open.line._id } });
        expect(s.lines?.[2]?.line?.kind).toBe('decided');
        // The open problem is closed by the second line; nothing written by this call is shown back.
        expect(s.picture.open.map((l) => l._id)).not.toContain(open.line._id);
        expect(s.picture.today.map((l) => l._id)).not.toEqual(expect.arrayContaining([s.line._id]));
        const rows = await prisma.workLine.findMany({ where: { userId: user.id, app: 'ChatGPT' }, orderBy: { createdAt: 'asc' } });
        expect(rows.map((x) => [x.kind, x.followsId])).toEqual([
            ['did', null],
            ['did', open.line._id],
            ['decided', null],
        ]);
        const day = await prisma.buddyCaptureDay.findFirstOrThrow({ where: { userId: user.id } });
        expect(day.work).toBe(4);
        // The open view agrees: nothing open.
        expect((await listWork(user.id, { view: 'open' }, 'app', AT(6))).flatMap((d) => d.projects.flatMap((p) => p.lines)).filter((l) => l.kind === 'stuck' && !l.later)).toHaveLength(0);
    });

    it('a repeat among them is not written, the others are; one refused line never stops the rest; the cap counts each line', async () => {
        const { user } = await setup();
        saved(await logLine(user.id, CLAUDE, { text: 'Merged the release branch', kind: 'did' }, AT(0)));
        const r = await logLine(
            user.id,
            CHATGPT,
            { text: 'Merged the release branch', kind: 'did', more: [{ text: 'Tagged release 2.4 and wrote the notes', kind: 'did' }, { text: 'Tagged release 2.4 and wrote the notes.', kind: 'did' }] },
            AT(5)
        );
        expect(r.status).toBe('already');
        expect('lines' in r && r.lines?.map((l) => l.status)).toEqual(['already', 'saved', 'already']);
        expect(await prisma.workLine.count({ where: { userId: user.id } })).toBe(2);
        // A removed first line: the others still go, and the answer carries the picture.
        const gone = saved(await logLine(user.id, CHATGPT, { text: 'Renamed the client folders', kind: 'did' }, AT(6)));
        await api(user).delete(`/api/buddy/work/${gone.line._id}`);
        const after = await logLine(user.id, CHATGPT, { text: 'Renamed the client folders', kind: 'did', more: [{ text: 'Moved the backups to the new bucket', kind: 'did' }] }, AT(7));
        expect(after).toMatchObject({ status: 'removed', lines: [{ status: 'removed' }, { status: 'saved' }] });
        expect('picture' in after && after.picture).toBeTruthy();
        // The cap: with one line left today, the first goes and the second is refused.
        const screens = 'billing search profile checkout inbox calendar reports settings uploads alerts exports invoices refunds payouts coupons pricing teams roles audit webhooks tokens sessions devices backups imports themes'.split(' ');
        const left = WEB_LINES_PER_DAY - (await prisma.workLine.count({ where: { userId: user.id, sessionKey: { startsWith: 'w_' }, followsId: null } }));
        for (let i = 0; i < left - 1; i++) saved(await logLine(user.id, CHATGPT, { text: `Shipped the new ${screens[i]} screen`, kind: 'did' }, AT(10 + i)));
        const capped = await logLine(user.id, CHATGPT, { text: 'Wrote the onboarding guide', kind: 'did', more: [{ text: 'Recorded the onboarding video', kind: 'did' }] }, AT(50));
        expect('lines' in capped && capped.lines?.map((l) => l.status)).toEqual(['saved', 'full']);
    });

    it('the route takes more (at most 2) and answers 201 when any line was written', async () => {
        const { user } = await setup();
        const agent = asAgent((await createTestToken(user, ['read', 'sessions:write'], 'ChatGPT')).token, 'ChatGPT');
        const ok = await agent.post('/api/buddy/work/line', { text: 'Fixed the login redirect', more: [{ text: 'Fixed the logout redirect', kind: 'did' }] });
        expect(ok.status).toBe(201);
        expect(ok.body.data.lines).toHaveLength(2);
        const tooMany = await agent.post('/api/buddy/work/line', { text: 'a b c', more: [{ text: 'd e' }, { text: 'f g' }, { text: 'h i' }] });
        expect(tooMany.status).toBe(400);
        const again = await agent.post('/api/buddy/work/line', { text: 'Fixed the login redirect', more: [{ text: 'Fixed the password reset mail' }] });
        expect([again.status, again.body.data.status, again.body.data.lines.map((l: { status: string }) => l.status)]).toEqual([201, 'already', ['already', 'saved']]);
    });
});

describe('news on a known thing (`on`), and its order', () => {
    it('an open problem from another app is closed by a line on it; a day shows each thing once; what is open is empty again', async () => {
        const { user, today } = await setup();
        const reader = asAgent((await createTestToken(user, ['read'], 'Claude')).token, 'Claude');
        const open = saved(await logLine(user.id, CHATGPT, { text: 'Review found the rollback script skips the cache', kind: 'stuck', project: 'api' }, AT(0)));
        expect((await reader.get('/api/buddy/work?view=open')).body.data[0].projects[0].lines.map((l: { _id: string }) => l._id)).toEqual([open.line._id]);
        // The brief a new chat starts with carries it as open, with its id.
        expect((await workForWebBrief(user.id, AT(1)))!.open.map((l) => l._id)).toEqual([open.line._id]);
        const fixed = saved(await logLine(user.id, CLAUDE, { text: 'Made the rollback script clear the cache first', kind: 'did', on: open.line._id, project: 'something else' }, AT(30)));
        expect(fixed.follows).toMatchObject({ _id: open.line._id, kind: 'stuck' });
        expect(fixed.line.project).toBe('api');
        // The open view: nothing still open; the finding listed as closed lately, with what closed it (the same day too).
        const after = (await reader.get('/api/buddy/work?view=open')).body.data[0].projects[0].lines;
        expect(after.map((l: { _id: string; later: { word: string; text: string } | null }) => [l._id, l.later?.word, l.later?.text])).toEqual([[open.line._id, 'fixed', 'Made the rollback script clear the cache first']]);
        const day = (await reader.get(`/api/buddy/work?from=${today}&to=${today}`)).body.data;
        expect(day[0].projects[0].lines.map((l: { text: string; app: string }) => [l.text, l.app])).toEqual([['Made the rollback script clear the cache first', 'Claude']]);
        // The day's line carries what it follows: the review's words stay findable.
        expect(day[0].projects[0].lines[0].was).toMatchObject({ text: 'Review found the rollback script skips the cache', kind: 'stuck', app: 'ChatGPT' });
        // An id it may not see, or that is gone, is no target: written as a new thing, and said so.
        const lost = saved(await logLine(user.id, CHATGPT, { text: 'Added the cache metrics dashboard', kind: 'did', on: 'no-such-line' }, AT(40)));
        expect([lost.onMissing, lost.follows]).toEqual([true, null]);
    });

    it('a decision changed later is the newest, and a late older decision never becomes the newest', async () => {
        const { user, today } = await setup();
        const first = saved(await logLine(user.id, CHATGPT, { text: 'Decided to keep MySQL for the jobs table', kind: 'decided', project: 'api' }, AT(0)));
        const changed = saved(await logLine(user.id, CLAUDE, { text: 'Decided to move the jobs table to Postgres: we need the joins', kind: 'decided', on: first.line._id }, AT(60)));
        // Claude Code's older summary arrives last: the decision's earlier wording, from before the change (05:00 local).
        await logWork(user.id, { key: 'cc_late', project: 'api', app: 'Claude Code', lines: [{ kind: 'decided', text: 'Leaning to keep MySQL for jobs, revisit later', at: '05:00', on: first.line._id }] }, AT(90));
        const late = await prisma.workLine.findFirstOrThrow({ where: { userId: user.id, sessionKey: 'cc_late' } });
        expect(late.followsId).toBe(first.line._id);
        const decided = await listWork(user.id, { view: 'decided', from: today, to: today }, 'app', AT(91));
        const lines = decided.flatMap((d) => d.projects.flatMap((p) => p.lines));
        expect(lines.map((l) => [l._id, l.was?.text ?? null])).toEqual([[changed.line._id, 'Decided to keep MySQL for the jobs table']]);
        // The day view shows the thing once, at its newest.
        const day = await listWork(user.id, { from: today, to: today }, 'app', AT(91));
        expect(day[0]!.projects[0]!.lines.map((l) => l._id)).toEqual([changed.line._id]);
    });

    it('an earlier day says what came later ("fixed"), and the briefs and the night say it too', async () => {
        const { user, today } = await setup();
        const yesterday = addDays(today, -1) as DayString;
        const open = saved(await logLine(user.id, CHATGPT, { text: 'The export times out on big months', kind: 'stuck', project: 'erp', day: yesterday }, AT(0)));
        const fix = saved(await logLine(user.id, CLAUDE, { text: 'Streamed the export rows; big months finish in 20 s', kind: 'did', on: open.line._id }, AT(5)));
        const days = await listWork(user.id, { from: yesterday, to: today }, 'app', AT(6));
        expect(days.map((d) => [d.day, d.projects[0]!.lines.map((l) => [l._id, l.later?.word ?? null])])).toEqual([
            [today, [[fix.line._id, null]]],
            [yesterday, [[open.line._id, 'fixed']]],
        ]);
        const brief = (await workForBrief(user.id, {}, AT(6)))!;
        expect(brief.days[0]!.projects[0]!.lines).toEqual([`Open: The export times out on big months (fixed ${today})`]);
        const night = (await workForNight(user.id, today, AT(6)))!;
        expect(night.text).toContain(`- stuck: The export times out on big months (fixed ${today})`);
    });
});

describe('an app changes only its own lines (W6)', () => {
    it('folds a repeat it saw after writing (not shown, not counted, kept in the export), rewords and removes its own, never another app’s', async () => {
        const { user, today } = await setup();
        const theirs = saved(await logLine(user.id, CHATGPT, { text: 'Fixed the flaky checkout test', kind: 'did', project: 'shop' }, AT(0)));
        const mine = saved(await logLine(user.id, CLAUDE, { text: 'Checkout test no longer flaky (waited for the cart API)', kind: 'did', project: 'shop' }, AT(1)));
        await expect(changeLine(user.id, CLAUDE, theirs.line._id, { remove: true }, AT(2))).rejects.toMatchObject({ statusCode: 403 });
        const joined = await changeLine(user.id, CLAUDE, mine.line._id, { sameAs: theirs.line._id }, AT(2));
        expect(joined).toMatchObject({ status: 'joined', into: { _id: theirs.line._id } });
        const day = await listWork(user.id, { from: today, to: today }, 'app', AT(3));
        expect(day[0]!.projects[0]!.lines.map((l) => l._id)).toEqual([theirs.line._id]);
        const exported = (await api(user).get('/api/buddy/export')).body.data.work;
        expect(exported.find((w: { _id: string }) => w._id === mine.line._id)).toMatchObject({ sameAs: theirs.line._id, app: 'Claude' });
        // News on the folded line counts on the line it repeats.
        const reopened = saved(await logLine(user.id, CLAUDE, { text: 'The checkout test failed again on CI', kind: 'stuck', on: mine.line._id }, AT(4)));
        expect(reopened.follows?._id).toBe(theirs.line._id);
        expect((await changeLine(user.id, CLAUDE, reopened.line._id, { text: 'The checkout test failed again on CI (timeouts)' }, AT(5))).status).toBe('reworded');
        expect((await changeLine(user.id, CLAUDE, reopened.line._id, { remove: true }, AT(6))).status).toBe('removed');
        expect(await logLine(user.id, CHATGPT, { text: 'The checkout test failed again on CI (timeouts)', kind: 'stuck' }, AT(7))).toEqual({ status: 'removed' });
        // A line written without `on` is linked afterwards; never a loop.
        const later = saved(await logLine(user.id, CLAUDE, { text: 'Pinned the cart API mock for the checkout test', kind: 'did' }, AT(8)));
        expect((await changeLine(user.id, CLAUDE, later.line._id, { on: theirs.line._id }, AT(9))).status).toBe('linked');
        await expect(changeLine(user.id, CHATGPT, theirs.line._id, { on: later.line._id }, AT(10))).rejects.toMatchObject({ statusCode: 409 });
    });

    it('the routes: a connected chat posts a line and changes its own; a read token can do neither; the app removes any', async () => {
        const { user } = await setup();
        const chat = asAgent((await createTestToken(user, ['read', 'sessions:write'], 'ChatGPT')).token, 'ChatGPT');
        const posted = await chat.post('/api/buddy/work/line', { text: 'Set up the staging deploy pipeline', project: 'Infra' });
        expect(posted.status).toBe(201);
        expect(posted.body.data).toMatchObject({ status: 'saved', line: { kind: 'did', project: 'infra', app: 'ChatGPT' } });
        const id = posted.body.data.line._id;
        expect((await chat.patch(`/api/buddy/work/line/${id}`, { text: 'Set up the staging deploy pipeline in CI' })).body.data.status).toBe('reworded');
        expect((await chat.patch(`/api/buddy/work/line/${id}`, { text: 'x', remove: true })).status).toBe(400);
        const reader = asAgent((await createTestToken(user, ['read'], 'Claude')).token, 'Claude');
        expect((await reader.post('/api/buddy/work/line', { text: 'Something' })).status).toBe(403);
        expect((await reader.patch(`/api/buddy/work/line/${id}`, { remove: true })).status).toBe(403);
        expect((await chat.get('/api/buddy/work/picture')).body.data.today.map((l: { _id: string }) => l._id)).toEqual([id]);
        expect((await api(user).delete(`/api/buddy/work/${id}`)).status).toBe(200);
    });
});

describe("Claude Code's lists keep their rows' ids (W10)", () => {
    it('log_work: a kept line stays the same row; a dropped one goes unless another line points at it', async () => {
        const { user } = await setup();
        const body = (lines: Array<{ kind: 'did' | 'stuck' | 'decided' | 'next'; text: string; at?: string }>) => ({ key: 'lw_one', project: 'erp', office: true, app: 'Claude Code', lines });
        await logWork(user.id, body([{ kind: 'stuck', text: 'Payroll export fails for March' }, { kind: 'did', text: 'Renamed the payroll columns' }]), AT(0));
        const before = await prisma.workLine.findMany({ where: { userId: user.id }, orderBy: { position: 'asc' } });
        // A connected chat fixes the open one (news on it).
        saved(await logLine(user.id, CHATGPT, { text: 'Fixed the March payroll export (date parsing)', kind: 'did', on: before[0]!.id }, AT(10)));
        // The chat logs again: the renamed line kept (same row, new words), the open one no longer listed but pointed at: it stays.
        await logWork(user.id, body([{ kind: 'did', text: 'Renamed the payroll columns', at: '11:00–11:20' }, { kind: 'next', text: 'Add the payroll audit log' }]), AT(20));
        const after = await prisma.workLine.findMany({ where: { userId: user.id, sessionKey: 'lw_one' }, orderBy: { position: 'asc' } });
        expect(after.map((r) => r.id)).toEqual(expect.arrayContaining([before[0]!.id, before[1]!.id]));
        expect(after.find((r) => r.id === before[1]!.id)?.at).toBe('11:00–11:20');
        // The day: the fix closed the open thing; one entry per thing.
        const open = await listWork(user.id, { view: 'open' }, 'app', AT(21));
        const lines = open.flatMap((d) => d.projects.flatMap((p) => p.lines));
        expect(lines.filter((l) => !l.later).map((l) => l.text)).toEqual(['Add the payroll audit log']);
        expect(lines.filter((l) => l.later).map((l) => [l.text, l.later!.word])).toEqual([['Payroll export fails for March', 'fixed']]);
    });

    it("the summariser is shown other chats' lines with ids, may say `on`, keeps its rows' ids and never writes another chat's line again", async () => {
        const { user, today } = await setup();
        const hook = asAgent((await createTestToken(user, ['read', 'sessions:write'], 'Claude Code hooks')).token, 'Claude Code hook');
        const open = saved(await logLine(user.id, CHATGPT, { text: 'Upload fails on big files', kind: 'stuck', project: 'api' }, AT(0)));
        const decided = saved(await logLine(user.id, CHATGPT, { text: 'Decided to stream uploads to S3 instead of buffering', kind: 'decided', project: 'api' }, AT(1)));
        const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 7, min)).toISOString();
        await hook.post('/api/buddy/words', { sessionKey: 'cc_api', seq: 1, project: 'api', messages: [{ at: at(0), text: 'stream the uploads to s3 like we decided, then fix the big file bug', reply: 'Done: uploads stream to S3; big files work now.' }] });
        const gate = fakeMessage({ labels: [{ i: 1, label: 'work' }] }, { model: 'claude-haiku-5-5' });
        fake.push(
            gate,
            fakeMessage(
                {
                    lines: [
                        { kind: 'did', text: 'Streamed uploads to S3; big files upload now', on: open.line._id },
                        { kind: 'decided', text: 'Decided to stream uploads to S3 instead of buffering', on: '' },
                        { kind: 'did', text: 'Added an upload size check', on: 'made-up-id' },
                    ],
                },
                { model: 'claude-sonnet-5-5' }
            )
        );
        await drainBuddyQueue(new Date(Date.UTC(2026, 10, 20, 8, 0)));
        const asked = JSON.stringify(fake.calls[1]!.messages);
        expect(asked).toContain('<already_logged>');
        expect(asked).toContain(`[${open.line._id}] open · Upload fails on big files (ChatGPT)`);
        expect(asked).toContain(`[${decided.line._id}] decided · Decided to stream uploads to S3`);
        const rows = await prisma.workLine.findMany({ where: { userId: user.id, sessionKey: 'cc_api' }, orderBy: { position: 'asc' } });
        // The decision another app logged is not written again; `on` kept only for an id it was shown.
        expect(rows.map((r) => [r.text, r.followsId, r.app])).toEqual([
            ['Streamed uploads to S3; big files upload now', open.line._id, 'Claude Code'],
            ['Added an upload size check', null, 'Claude Code'],
        ]);
        const openNow = await listWork(user.id, { view: 'open' }, 'app', new Date(Date.UTC(2026, 10, 20, 8, 1)));
        expect(openNow.flatMap((d) => d.projects.flatMap((p) => p.lines.filter((l) => !l.later)))).toEqual([]);
        // A later piece of the same session keeps the rows it still lists.
        await hook.post('/api/buddy/words', { sessionKey: 'cc_api', seq: 2, project: 'api', messages: [{ at: at(30), text: 'also add the size check message', reply: 'Added.' }] });
        fake.push(gate, fakeMessage({ lines: [{ kind: 'did', text: 'Streamed uploads to S3; big files upload now', on: '' }, { kind: 'did', text: 'Added an upload size check with a clear message', on: '' }] }, { model: 'claude-sonnet-5-5' }));
        await drainBuddyQueue(new Date(Date.UTC(2026, 10, 20, 8, 40)));
        const again = await prisma.workLine.findMany({ where: { userId: user.id, sessionKey: 'cc_api' }, orderBy: { position: 'asc' } });
        expect(again.map((r) => r.id)).toEqual(rows.map((r) => r.id));
        expect(again[0]!.followsId).toBe(open.line._id);
        expect((await listWork(user.id, { from: today, to: today }, 'app', new Date(Date.UTC(2026, 10, 20, 9, 0)))).length).toBe(1);
    });
});

describe('stale open lines (the live hour, 11-20): marked likely done at once, settled by the night where there is AI', () => {
    it('a fix from another app without `on`: the open view and the brief say "likely done" right away, with no AI', async () => {
        const { user } = await setup();
        const open = saved(await logLine(user.id, CHATGPT, { text: 'Docker build still fails at npm ci with EACCES after setting the npm cache to /tmp', kind: 'stuck', project: 'infra' }, AT(0)));
        const fix = saved(await logLine(user.id, CLAUDE, { text: 'Fixed the Docker npm ci build: running as the node user resolved the EACCES', kind: 'did', project: 'infra' }, AT(20)));
        const lines = (await listWork(user.id, { view: 'open' }, 'connected', AT(21))).flatMap((d) => d.projects.flatMap((p) => p.lines));
        expect(lines.map((l) => [l._id, l.later, l.likely?._id])).toEqual([[open.line._id, null, fix.line._id]]);
        expect((await workForWebBrief(user.id, AT(21)))!.open[0]!.likely?._id).toBe(fix.line._id);
        // A different fix in the same area is not taken for it.
        const other = await setup();
        saved(await logLine(other.user.id, CHATGPT, { text: 'Docker build fails at npm ci with EACCES', kind: 'stuck', project: 'infra' }, AT(0)));
        saved(await logLine(other.user.id, CLAUDE, { text: 'Rotated the registry password for the CI runner', kind: 'did', project: 'infra' }, AT(20)));
        expect((await listWork(other.user.id, { view: 'open' }, 'app', AT(21))).flatMap((d) => d.projects.flatMap((p) => p.lines)).map((l) => l.likely)).toEqual([null]);
    });

    it('the night links a fix to its open line, and folds an open problem logged twice so the fix closes the first', async () => {
        const { settleWork } = await import('../../src/services/buddy/work');
        const a = await setup();
        const d = saved(await logLine(a.user.id, CHATGPT, { text: 'Exports time out on big months', kind: 'stuck', project: 'erp' }, AT(0)));
        const e = saved(await logLine(a.user.id, CLAUDE, { text: 'Streamed the export rows; March finishes in 20 s', kind: 'did', project: 'erp' }, AT(30)));
        fake.push(fakeMessage({ pairs: [{ n: 1, verdict: 'closes' }] }, { model: 'claude-haiku-5-5' }));
        expect(await settleWork(a.user.id, AT(60))).toMatchObject({ linked: 1, folded: 0 });
        expect((await prisma.workLine.findUniqueOrThrow({ where: { id: e.line._id } })).followsId).toBe(d.line._id);
        expect(JSON.stringify(fake.calls[0]!.messages)).toContain('1. open: Exports time out on big months');

        // The relay's miss: the review's finding (ChatGPT), the same finding again (Claude), the fix on the copy.
        const b = await setup();
        const first = saved(await logLine(b.user.id, CHATGPT, { text: 'Nginx buffers whole request bodies to disk for big uploads', kind: 'stuck', project: 'uploads' }, AT(0)));
        const copy = saved(await logLine(b.user.id, CLAUDE, { text: 'Review found the app server writes uploads to disk first', kind: 'stuck', project: 'uploads' }, AT(10)));
        saved(await logLine(b.user.id, CLAUDE, { text: 'Switched uploads to stream straight to S3', kind: 'did', on: copy.line._id }, AT(20)));
        const stale = (await listWork(b.user.id, { view: 'open' }, 'app', AT(21))).flatMap((x) => x.projects.flatMap((p) => p.lines)).filter((l) => !l.later);
        expect(stale.map((l) => l._id)).toEqual([first.line._id]);
        fake.push(fakeMessage({ pairs: [{ n: 1, verdict: 'closes' }] }, { model: 'claude-haiku-5-5' }));
        expect(await settleWork(b.user.id, AT(60))).toMatchObject({ linked: 0, folded: 1 });
        expect((await prisma.workLine.findUniqueOrThrow({ where: { id: copy.line._id } })).sameAsId).toBe(first.line._id);
        const after = (await listWork(b.user.id, { view: 'open' }, 'app', AT(61))).flatMap((x) => x.projects.flatMap((p) => p.lines));
        expect(after.map((l) => [l._id, l.later?.word])).toEqual([[first.line._id, 'fixed']]);
        // Nothing open: no model call.
        const calls = fake.calls.length;
        expect(await settleWork((await setup()).user.id, AT(60))).toEqual({ linked: 0, folded: 0, costUsd: 0 });
        expect(fake.calls.length).toBe(calls);
    });
});

describe('the person’s choices, and one picture on every surface', () => {
    it("share off: a work folder's lines stay in their folder and in Recollect; connected chats never see them, but a literal repeat is still caught", async () => {
        const { user, today } = await setup({ shareOfficeWork: false });
        await logWork(user.id, { key: 'lw_office', project: 'erp', office: true, app: 'Claude Code', lines: [{ kind: 'did', text: 'Fixed the vendor invoice import' }, { kind: 'stuck', text: 'Tax report totals off by a rupee' }] }, AT(0));
        saved(await logLine(user.id, CHATGPT, { text: 'Drafted the blog post on caching', kind: 'did', project: 'writing' }, AT(1)));
        const chat = asAgent((await createTestToken(user, ['read', 'sessions:write'], 'ChatGPT')).token, 'ChatGPT');
        const seen = JSON.stringify((await chat.get(`/api/buddy/work?from=${today}&to=${today}`)).body.data);
        expect(seen).toContain('blog post');
        expect(seen).not.toContain('vendor invoice');
        expect(JSON.stringify((await chat.get('/api/buddy/work?view=open')).body.data)).not.toContain('Tax report');
        expect(JSON.stringify(await workForWebBrief(user.id, AT(2)))).not.toMatch(/vendor|Tax report|"erp"/);
        // The repeat is caught without telling the chat what it repeats.
        expect(await logLine(user.id, CHATGPT, { text: 'Fixed the vendor invoice import', kind: 'did' }, AT(3))).toMatchObject({ status: 'already', line: null });
        // Recollect itself (the app, Ask AI) and the folder see everything that is theirs.
        const askAi = asAgent((await createTestToken(user, ['read'], 'Ask AI (built in)')).token, 'Ask AI');
        expect(JSON.stringify((await askAi.get(`/api/buddy/work?from=${today}&to=${today}`)).body.data)).toContain('vendor invoice');
        expect(JSON.stringify((await api(user).get('/api/buddy/work?view=open')).body.data)).toContain('Tax report');
        // The day asked for (the default is the last 7 days by the real clock, and AT is a fixed day: this line failed from 11-27).
        expect(JSON.stringify((await chat.get(`/api/buddy/work?work=1&project=erp&from=${today}&to=${today}`)).body.data)).toContain('vendor invoice');
        // Shared again: the connected chats see them.
        await api(user).patch('/api/buddy/settings', { shareOfficeWork: true });
        expect(JSON.stringify((await chat.get(`/api/buddy/work?from=${today}&to=${today}`)).body.data)).toContain('vendor invoice');
        expect((await api(user).get('/api/buddy/settings')).body.data).toMatchObject({ workLog: true, shareOfficeWork: true });
    });

    it('the web brief has the work part and its rule only with the log on; every surface reads one picture', async () => {
        const off = await setup({ workLog: false });
        const offView = (await api(off.user).get('/api/brief?view=buddy')).body.data;
        expect([offView.work, offView.howTo.join(' ').includes('log_work')]).toEqual([null, false]);

        const { user } = await setup();
        // The routes read the real clock: the lines are from the last few minutes, and "today" is the real one (this test
        // used the fixed Friday and failed from Saturday on).
        const RECENT = (min: number) => new Date(Date.now() - 12 * 60_000 + min * 60_000);
        const { today } = await loadLearningContext(user.id, new Date());
        const a = saved(await logLine(user.id, CHATGPT, { text: 'Found the webhook retries pile up', kind: 'stuck', project: 'payments' }, RECENT(0)));
        saved(await logLine(user.id, CLAUDE, { text: 'Capped webhook retries at 5 with backoff', kind: 'did', on: a.line._id }, RECENT(10)));
        saved(await logLine(user.id, CLAUDE, { text: 'Decided to move refunds to the queue', kind: 'decided', project: 'payments' }, RECENT(11)));
        const view = (await api(user).get('/api/brief?view=buddy')).body.data;
        expect(view.howTo.join(' ')).toContain('log_work');
        expect(view.work.open).toEqual([]);
        expect(view.work.projects).toEqual(['payments']);
        type Day = { projects: Array<{ lines: Array<{ text: string; was: { text: string } | null }> }> };
        const entries = (days: Day[]) => days.flatMap((d) => d.projects.flatMap((p) => p.lines.map((l) => l.text))).filter((t) => /webhook retries/i.test(t));
        // The route (/you, Ask AI, a chat), the web brief: the thing once, at its newest (what it fixed rides along as `was`).
        const routeDay: Day[] = (await api(user).get(`/api/buddy/work?from=${today}&to=${today}`)).body.data;
        expect(entries(routeDay)).toEqual(['Capped webhook retries at 5 with backoff']);
        expect(routeDay[0]!.projects[0]!.lines.find((l) => l.text.startsWith('Capped'))!.was?.text).toBe('Found the webhook retries pile up');
        expect(view.work.today.map((l: { text: string }) => l.text).filter((t: string) => /webhook retries/i.test(t))).toEqual(['Capped webhook retries at 5 with backoff']);
        const done = (await api(user).get('/api/buddy/work?view=done')).body.data;
        expect(done.flatMap((d: { projects: Array<{ lines: Array<{ text: string }> }> }) => d.projects.flatMap((p) => p.lines.map((l) => l.text)))).toEqual(['Capped webhook retries at 5 with backoff']);
    });

    it('a new account starts with its work log on and its work folders shared', async () => {
        const { startBuddyForNewAccount } = await import('../../src/services/buddy/state.service');
        const user = await createTestUser();
        await startBuddyForNewAccount(user.id);
        expect((await api(user).get('/api/buddy/settings')).body.data).toMatchObject({ enabled: true, loop: true, workLog: true, shareOfficeWork: true });
    });
});
