// PERSONAL_OFFICE_PLAN (11-23): every folder is personal, study or work; work is tracked for time and the work log but
// counts as progress only for a person who says so. The server stamps each session with its folder's area, the app's
// choice of a folder's kind wins over a PC's hint and moves the folder's past with it, and every reader that judges
// (Where you stand, the rhythm) reads the sessions through the person's progress lens.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { summariseWork } from '../../src/services/buddy/work';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function setup() {
    const user = await createTestUser();
    const hook = asAgent((await createTestToken(user, ['read', 'sessions:write'], 'Claude Code hook')).token, 'Claude Code hook');
    const close = (key: string, project: string, projectKind: 'personal' | 'study' | 'work' | undefined, minutes: number, extra: Record<string, unknown> = {}) =>
        hook.put(`/api/sessions/by-key/${key}`, {
            kindIfNew: 'build',
            source: 'hook',
            project,
            ...(projectKind ? { projectKind } : {}),
            // Started a moment ago, so the session's day is today whatever the hour (its minutes are what it says).
            startedAt: ago(2),
            endedAt: ago(1),
            minutes,
            titleIfNew: 'rename the invoice service for the client',
            details: { branch: 'feature/gst', commits: ['GST rounding for ACME invoices'] },
            ...extra,
        });
    const stand = async (lens?: string) => (await api(user).get(`/api/mirror/stand${lens ? `?lens=${lens}` : ''}`)).body.data;
    const today = async () => (await api(user).get('/api/today')).body.data.stats.rhythm.last7.at(-1);
    return { user, hook, close, stand, today };
}

describe('a work folder (PERSONAL_OFFICE_PLAN stage 1)', () => {
    it('a new folder takes the hook’s hint; its session is work, titled by the folder, without commits; it does not count', async () => {
        const { user, close, stand, today } = await setup();
        const res = await close('cc_work1', 'erp-workspace', 'work', 240);
        expect(res.status).toBe(200);
        expect(res.body.data.session).toMatchObject({ kind: 'build', area: 'work', title: 'erp-workspace', project: { key: 'erp-workspace' } });
        expect(res.body.data.session.details).toEqual({ commits: [] });
        expect(await prisma.project.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ key: 'erp-workspace', kind: 'work' });

        // Personal only (the default): no active day, no minutes, on Home's year and in the rhythm.
        const s = await stand();
        expect(s).toMatchObject({ lens: 'personal', progressLens: 'personal', hasWork: true, workFolders: ['erp-workspace'] });
        expect(s.periods.week.current).toMatchObject({ activeDays: 0, totalMinutes: 0 });
        expect(await today()).toMatchObject({ active: false });

        // The Work lens sees it; All sees it with the split.
        const work = await stand('work');
        expect(work.periods.week.current).toMatchObject({ activeDays: 1, totalMinutes: 240, minutesByArea: { personal: 0, work: 240 } });
        expect(work.periods.week.verdict[0]).toBe('Worked today, the first day of the record.');
        expect(work.days.at(-1)).toMatchObject({ active: true, minutes: 240, places: [{ name: 'erp-workspace', minutes: 240, area: 'work' }] });
        expect((await stand('all')).periods.week.current).toMatchObject({ activeDays: 1, totalMinutes: 240 });
        expect((await api(user).get('/api/mirror/stand?lens=office')).status).toBe(400);

        // Their choice: work counts too. Then Home's year and the rhythm count it.
        expect((await api(user).patch('/api/learning/settings', { progressIncludesWork: true })).body.data).toMatchObject({ progressIncludesWork: true });
        expect((await stand()).lens).toBe('all');
        expect((await stand()).periods.week.current).toMatchObject({ activeDays: 1, totalMinutes: 240 });
        expect(await today()).toMatchObject({ active: true });
    });

    it('the app’s kind wins: a known folder ignores the hint; flipping a folder moves its past (area, build ↔ study, office lines)', async () => {
        const { user, close, stand } = await setup();
        await close('cc_mine1', 'second_brain', 'personal', 60);
        // A PC that calls it work later does not change a folder the server knows.
        const later = await close('cc_mine2', 'second_brain', 'work', 30);
        expect(later.body.data.session).toMatchObject({ area: 'personal', title: 'GST rounding for ACME invoices' });
        expect((await stand()).periods.week.current.totalMinutes).toBe(90);

        const project = await prisma.project.findFirstOrThrow({ where: { userId: user.id } });
        await prisma.workLine.create({ data: { userId: user.id, day: new Date(), project: 'second_brain', sessionKey: 'cc_mine1', kind: 'did', text: 'Paths in the library' } });

        // Work: its sessions and lines go with it.
        const flipped = await api(user).patch(`/api/projects/${project.id}`, { kind: 'work' });
        expect(flipped.status).toBe(200);
        expect(flipped.body.data).toMatchObject({ kind: 'work', minutes28: 90 });
        expect(await prisma.workSession.count({ where: { userId: user.id, area: 'work' } })).toBe(2);
        expect(await prisma.workLine.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ office: true });
        expect((await stand()).periods.week.current.totalMinutes).toBe(0);

        // Study: personal again, and the hook's coding sessions are study now; a later session there is study too.
        await api(user).patch(`/api/projects/${project.id}`, { kind: 'study' });
        const rows = await prisma.workSession.findMany({ where: { userId: user.id }, select: { kind: true, area: true } });
        expect(rows).toEqual([
            { kind: 'study', area: 'personal' },
            { kind: 'study', area: 'personal' },
        ]);
        expect(await prisma.workLine.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ office: false });
        expect((await close('cc_mine3', 'second_brain', undefined, 20)).body.data.session).toMatchObject({ kind: 'study', area: 'personal' });
        expect((await stand()).periods.week.current).toMatchObject({ totalMinutes: 110, minutes: { study: 110, build: 0 } });

        // The list shows each folder's kind; a bad kind is refused.
        expect((await api(user).get('/api/projects')).body.data).toEqual([expect.objectContaining({ key: 'second_brain', kind: 'study', minutes28: 110 })]);
        expect((await api(user).patch(`/api/projects/${project.id}`, { kind: 'office' })).status).toBe(400);
    });

    it('a session with no folder is personal; a study folder from the PC starts as study', async () => {
        const { user, close, stand } = await setup();
        const chat = asAgent((await createTestToken(user)).token, 'study-chat');
        expect((await chat.put('/api/sessions/by-key/s_chat1', { title: 'Graphs: BFS', minutes: 30 })).body.data.session).toMatchObject({ area: 'personal' });
        expect((await close('cc_learn1', 'dsa-practice', 'study', 45)).body.data.session).toMatchObject({ kind: 'study', area: 'personal' });
        expect((await stand()).periods.week.current).toMatchObject({ activeDays: 1, totalMinutes: 75 });
    });

    it('an agent’s change of a folder’s kind is logged with an Undo that moves the past back', async () => {
        const { user, close } = await setup();
        await close('cc_w1', 'erp-workspace', 'work', 100);
        const project = await prisma.project.findFirstOrThrow({ where: { userId: user.id } });
        const agent = asAgent((await createTestToken(user)).token, 'Claude Code');
        expect((await agent.patch(`/api/projects/${project.id}`, { kind: 'personal' })).status).toBe(200);
        expect(await prisma.workSession.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ area: 'personal' });
        const edit = await prisma.agentEdit.findFirstOrThrow({ where: { userId: user.id, kind: 'project_update' } });
        expect(edit.summary).toBe('Changed the project "erp-workspace": marked it as personal');
        expect((await api(user).post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(200);
        expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ kind: 'work' });
        expect(await prisma.workSession.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ area: 'work' });
    });
});

describe('words and work lines from a folder the server knows as work', () => {
    it('words are office work, and so are lines a chat logs there, whatever the PC said', async () => {
        const { user, close } = await setup();
        await close('cc_w1', 'erp-workspace', 'work', 60);
        await api(user).patch('/api/buddy/settings', { enabled: true, workLog: true });
        const agent = asAgent((await createTestToken(user)).token, 'Claude Code');
        const words = await agent.post('/api/buddy/words', { sessionKey: 'cc_w2', seq: 1, project: 'erp-workspace', messages: [{ at: new Date().toISOString(), text: 'rename the invoice service for the client' }] });
        expect(words.status).toBe(202);
        expect(await prisma.buddyChunk.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ office: true });

        const logged = await agent.post('/api/buddy/work', { key: 'lw_w1', project: 'erp-workspace', lines: [{ kind: 'did', text: 'Fixed the GST rounding in the invoice report' }] });
        expect(logged.status).toBe(201);
        expect(await prisma.workLine.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ office: true });
    });

    it('a study folder’s chat writes no work lines (no AI is asked)', async () => {
        const { user, close } = await setup();
        await close('cc_s1', 'dsa-practice', 'study', 30);
        const out = await summariseWork({ userId: user.id, sessionKey: 'cc_s1', project: 'dsa-practice', office: false }, [{ at: new Date().toISOString(), text: 'solved two sum with a hash map' }]);
        expect(out).toEqual({ lines: 0, costUsd: 0 });
    });
});
