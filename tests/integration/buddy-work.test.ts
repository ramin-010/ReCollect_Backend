// The work log (BUDDY_MEMORY_PLAN §11.2, B9) on a fake Claude: off, the gate's request is exactly the one
// before B9 and nothing is logged; on, the gate's `work` label sends a piece to the summariser, which
// rewrites that session's lines for the day; work never becomes a note or memory about him; office
// lines reach only their own project's work brief; his own brief gets yesterday's lines; the night
// gets his last day's work and treats it as private for the lock screen; a line he removes stays
// hidden and is never written again; the routes' scopes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { drainBuddyQueue, nightIfDue } from '../../src/services/buddy/worker';
import { DIGEST_SCHEMA, GATE_SCHEMA, GATE_SCHEMA_WORK, GATE_SYSTEM, gateRequest } from '../../src/services/buddy/digest';
import { WORK_SCHEMA } from '../../src/services/buddy/work';
import { LOCK_SCHEMA, NIGHT_SCHEMA } from '../../src/services/buddy/think';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import { loadLearningContext } from '../../src/services/learningDb/common';
import { addDays } from '../../src/services/learning';

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

// Sunday 15 Nov 2026, 15:00 in Kolkata (his words), and the next morning's night at 05:00.
const SUNDAY = (min: number) => new Date(Date.UTC(2026, 10, 15, 9, 30 + min)).toISOString();
const AFTER = new Date(Date.UTC(2026, 10, 15, 10, 30));
const MONDAY_NIGHT = new Date(Date.UTC(2026, 10, 15, 23, 30));

const words = (hook: ReturnType<typeof asAgent>, seq: number, project: string, texts: Array<{ text: string; reply?: string }>, over: Record<string, unknown> = {}) =>
    hook.post('/api/buddy/words', { sessionKey: `cc_${project}`, seq, project, messages: texts.map((m, i) => ({ at: SUNDAY(i), ...m })), ...over });

async function setup(workLog = true) {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, ...(workLog ? { workLog: true } : {}) });
    const hook = asAgent((await createTestToken(user, ['read', 'sessions:write'], 'Claude Code hooks')).token, 'Claude Code hook');
    return { user, hook };
}

const gate = (labels: string[]) => fakeMessage({ labels: labels.map((label, i) => ({ i: i + 1, label })) }, { model: 'claude-haiku-5-5' });
const summary = (lines: Array<[string, string]>) => fakeMessage({ lines: lines.map(([kind, text]) => ({ kind, text })) }, { model: 'claude-sonnet-5-5' });
const digest = (notes: Array<{ text: string; kind: string; private: boolean }>) =>
    fakeMessage({ notes: notes.map((n) => ({ ...n, seenMemoryId: '' })), items: [] }, { model: 'claude-sonnet-5-5' });

const ERP = [
    { text: 'the invoice report rounds GST wrong, fix the rounding in invoice_totals', reply: 'Fixed: GST is now rounded per line, then summed. Tests pass.' },
    { text: 'yes do it' },
    { text: 'honestly this job is draining me, I keep thinking about leaving', reply: 'That sounds hard.' },
    { text: 'next we need to add the credit note export before Friday', reply: 'Noted.' },
];

describe('the work log', () => {
    it('off: the gate asks exactly what it did before B9, and nothing is logged', async () => {
        const { user, hook } = await setup(false);
        // Byte for byte the request of B2 (with the high effort of 11-16).
        const before = gateRequest([{ at: SUNDAY(0), text: 'fix the rounding' }]);
        expect(JSON.stringify(before)).toBe(
            JSON.stringify({
                model: 'claude-haiku-5-5',
                max_tokens: 3120,
                output_config: { effort: 'high', format: { type: 'json_schema', schema: GATE_SCHEMA } },
                system: [{ type: 'text', text: GATE_SYSTEM, cache_control: { type: 'ephemeral' } }],
                messages: [{ role: 'user', content: [{ type: 'text', text: '<messages>\n[1] fix the rounding\n</messages>' }] }],
            })
        );
        expect(JSON.stringify(gateRequest([{ at: SUNDAY(0), text: 'fix the rounding' }], { work: false }))).toBe(JSON.stringify(before));
        expect(GATE_SYSTEM).not.toContain('work:');
        await words(hook, 1, 'erp', ERP);
        fake.push(gate(['none', 'none', 'about_him', 'none']), digest([{ text: 'Finds his job draining', kind: 'state', private: true }]));
        await drainBuddyQueue(AFTER);
        expect(fake.calls.map((c) => c.output_config?.format?.schema)).toEqual([GATE_SCHEMA, DIGEST_SCHEMA]);
        expect(fake.calls[0]!.system).toEqual([{ type: 'text', text: GATE_SYSTEM, cache_control: { type: 'ephemeral' } }]);
        expect(await prisma.workLine.count({ where: { userId: user.id } })).toBe(0);
    });

    it('on: work goes to the summariser and the log, his feelings to his memory, never the other way', async () => {
        const { user, hook } = await setup();
        expect((await words(hook, 1, 'erp', ERP, { office: true })).status).toBe(202);
        fake.push(
            gate(['work', 'none', 'about_him', 'work']),
            summary([
                ['did', 'Fixed the GST rounding in the invoice report (per line, then summed)'],
                ['next', 'Add the credit note export before Friday'],
            ]),
            digest([{ text: 'Finds his job draining, thinks about leaving', kind: 'state', private: true }])
        );
        const r = await drainBuddyQueue(AFTER);
        expect(r).toEqual({ digested: 1, dropped: 0, failed: 0, waiting: 0 });
        expect(fake.calls.map((c) => c.output_config?.format?.schema)).toEqual([GATE_SCHEMA_WORK, WORK_SCHEMA, DIGEST_SCHEMA]);
        // The summariser saw the whole piece: his words and the replies (what was done).
        const asked = JSON.stringify(fake.calls[1]!.messages);
        expect(asked).toContain('<project>erp</project>');
        expect(asked).toContain('agent: Fixed: GST is now rounded per line');
        // The digest saw only the message about him as KEEP.
        expect(JSON.stringify(fake.calls[2]!.messages)).toContain('KEEP: honestly this job is draining me');
        expect(JSON.stringify(fake.calls[2]!.messages)).not.toContain('KEEP: the invoice report');

        const lines = await prisma.workLine.findMany({ where: { userId: user.id }, orderBy: { position: 'asc' } });
        expect(lines.map((l) => [l.kind, l.text, l.office, l.project, l.day.toISOString().slice(0, 10)])).toEqual([
            ['did', 'Fixed the GST rounding in the invoice report (per line, then summed)', true, 'erp', '2026-11-15'],
            ['next', 'Add the credit note export before Friday', true, 'erp', '2026-11-15'],
        ]);
        // Work never became a note or a memory about him.
        const notes = await prisma.observation.findMany({ where: { userId: user.id } });
        expect(notes.map((n) => n.text)).toEqual(['Finds his job draining, thinks about leaving']);
        expect(await prisma.memory.count({ where: { userId: user.id } })).toBe(0);
        expect((await prisma.buddyCaptureDay.aggregate({ where: { userId: user.id }, _sum: { work: true } }))._sum.work).toBe(2);

        // A later piece of the same session rewrites the day's list (it is given the lines so far).
        await words(hook, 2, 'erp', [{ text: 'the credit note export is done too, ship it', reply: 'Added the credit note export, merged.' }], { office: true });
        fake.push(
            gate(['work']),
            summary([
                ['did', 'Fixed the GST rounding in the invoice report (per line, then summed)'],
                ['did', 'Added the credit note export and merged it'],
            ])
        );
        await drainBuddyQueue(AFTER);
        expect(JSON.stringify(fake.calls[4]!.messages)).toContain('next · Add the credit note export before Friday');
        expect((await prisma.workLine.findMany({ where: { userId: user.id }, orderBy: { position: 'asc' } })).map((l) => l.text)).toEqual([
            'Fixed the GST rounding in the invoice report (per line, then summed)',
            'Added the credit note export and merged it',
        ]);
    });

    it('reading it: the route by project and words; an office chat sees only its project; his brief gets yesterday; he removes a line for good', async () => {
        const { user, hook } = await setup();
        const { today } = await loadLearningContext(user.id, new Date());
        const yesterday = addDays(today, -1);
        const before = addDays(today, -3);
        const day = (d: string) => new Date(`${d}T00:00:00Z`);
        await prisma.workLine.createMany({
            data: [
                { userId: user.id, day: day(yesterday), project: 'erp', sessionKey: 'cc_erp', kind: 'did', text: 'Fixed the GST rounding in the invoice report', office: true, position: 0 },
                { userId: user.id, day: day(yesterday), project: 'second_brain', sessionKey: 'cc_sb', kind: 'did', text: 'Built the phone pictures for the zoom', position: 0 },
                { userId: user.id, day: day(before), project: 'erp', sessionKey: 'cc_erp0', kind: 'decided', text: 'Kept the old export until the client signs off', office: true, position: 0 },
            ],
        });
        const erp = await prisma.project.create({ data: { userId: user.id, key: 'erp', name: 'erp' } });
        await prisma.workSession.create({
            data: { userId: user.id, key: 'cc_erp', kind: 'build', day: day(yesterday), startedAt: new Date(`${yesterday}T09:00:00Z`), minutes: 95, title: 'ERP fixes', details: { commits: ['Fix GST rounding'] }, projectId: erp.id },
        });

        const reader = asAgent((await createTestToken(user, ['read'])).token);
        const all = (await reader.get(`/api/buddy/work?from=${before}&to=${today}`)).body.data;
        expect(all.map((d: { day: string }) => d.day)).toEqual([yesterday, before]);
        expect(all[0].projects.find((p: { project: string }) => p.project === 'erp')).toMatchObject({ office: true, minutes: 95, sessions: 1, commits: ['Fix GST rounding'] });
        const found = (await reader.get('/api/buddy/work?q=rounding')).body.data;
        expect(found.flatMap((d: { projects: Array<{ lines: Array<{ text: string }> }> }) => d.projects.flatMap((p) => p.lines.map((l) => l.text)))).toEqual(['Fixed the GST rounding in the invoice report']);
        // An office chat's question names its project.
        expect((await reader.get('/api/buddy/work?work=1')).status).toBe(400);
        expect((await reader.get('/api/buddy/work?work=1&project=erp')).body.data.flatMap((d: { projects: Array<{ project: string }> }) => d.projects.map((p) => p.project))).toEqual(['erp', 'erp']);

        // The briefs: an office chat gets its own project's days only and nothing personal; his own, yesterday.
        const office = (await hook.get('/api/brief?project=erp&work=1')).body.data;
        expect(office.work.days.map((d: { day: string }) => d.day)).toEqual([yesterday, before]);
        expect(JSON.stringify(office.work)).not.toContain('phone pictures');
        expect([office.goals, office.buddy.memories]).toEqual([[], []]);
        const mine = (await hook.get('/api/brief?project=second_brain')).body.data;
        expect(mine.work.days).toHaveLength(1);
        expect(JSON.stringify(mine.work)).toContain('phone pictures');
        expect(JSON.stringify(mine.work)).toContain('GST rounding');

        // Removing a line is his alone (the app); then it is gone from the log and the briefs.
        const id = all[0].projects.find((p: { project: string }) => p.project === 'erp').lines[0]._id;
        expect((await reader.delete(`/api/buddy/work/${id}`)).status).toBe(403);
        expect((await api(user).delete(`/api/buddy/work/${id}`)).status).toBe(200);
        expect(JSON.stringify((await api(user).get(`/api/buddy/work?from=${before}&to=${today}`)).body.data)).not.toContain('GST rounding');
        expect(JSON.stringify((await hook.get('/api/brief?project=second_brain')).body.data.work)).not.toContain('GST rounding');
        // The export has it, marked removed.
        const exported = (await api(user).get('/api/buddy/export')).body.data.work;
        expect(exported.find((w: { text: string }) => w.text.includes('GST'))).toMatchObject({ removed: true, office: true });
    });

    it("B10: an agent logs a day's work on his word (log_work): times, the office flag, one chat's lines replaced, another chat's and removed lines kept out; off and paused write nothing", async () => {
        const { user } = await setup(false);
        const agent = asAgent((await createTestToken(user, ['read', 'sessions:write'], 'Claude Code')).token, 'Claude Code');
        const { today } = await loadLearningContext(user.id, new Date());
        const body = (over: Record<string, unknown> = {}) => ({
            key: 'lw_chat1',
            project: 'ERP',
            office: true,
            lines: [
                { kind: 'did', text: 'Fixed the GST rounding in the invoice report', at: '10:15 - 11:40' },
                { kind: 'decided', text: 'Kept the old export until the client signs off', at: '14:05' },
                { kind: 'next', text: 'Add the credit note export', at: 'after lunch' },
            ],
            ...over,
        });
        // The work log off: nothing written.
        expect((await agent.post('/api/buddy/work', body())).body.data).toEqual({ status: 'off' });
        await api(user).patch('/api/buddy/settings', { workLog: true });

        const first = await agent.post('/api/buddy/work', body());
        expect(first.status).toBe(201);
        expect(first.body.data).toMatchObject({ status: 'saved', day: today, project: 'erp', saved: 3, skipped: 0 });
        const rows = await prisma.workLine.findMany({ where: { userId: user.id }, orderBy: { position: 'asc' } });
        expect(rows.map((r) => [r.kind, r.at, r.source, r.office, r.sessionKey])).toEqual([
            ['did', '10:15–11:40', 'agent', true, 'lw_chat1'],
            ['decided', '14:05', 'agent', true, 'lw_chat1'],
            ['next', null, 'agent', true, 'lw_chat1'],
        ]);
        // The same chat again: its lines for the day are replaced, not doubled.
        await agent.post('/api/buddy/work', body({ lines: [{ kind: 'did', text: 'Fixed the GST rounding in the invoice report and its tests', at: '10:15–12:00' }] }));
        expect(await prisma.workLine.count({ where: { userId: user.id, hidden: false } })).toBe(1);
        // Another chat: a line that says the same is skipped; a new one is kept.
        const other = await agent.post('/api/buddy/work', body({ key: 'lw_chat2', lines: [{ kind: 'did', text: 'Fixed GST rounding in the invoice report', at: '16:00' }, { kind: 'did', text: 'Reviewed the payroll migration' }] }));
        expect(other.body.data).toMatchObject({ saved: 1, skipped: 1 });
        // A line he removed is never written again, by any chat.
        const kept = await prisma.workLine.findFirstOrThrow({ where: { userId: user.id, sessionKey: 'lw_chat2' } });
        expect((await api(user).delete(`/api/buddy/work/${kept.id}`)).status).toBe(200);
        const again = await agent.post('/api/buddy/work', body({ key: 'lw_chat3', lines: [{ kind: 'did', text: 'Reviewed the payroll migration' }] }));
        expect(again.body.data).toMatchObject({ saved: 0, skipped: 1 });

        // Read back: the time and who wrote it; the office brief puts the time first.
        const day = (await api(user).get(`/api/buddy/work?from=${today}&to=${today}`)).body.data[0];
        expect(day.projects[0].lines[0]).toMatchObject({ text: 'Fixed the GST rounding in the invoice report and its tests', at: '10:15–12:00', source: 'agent' });
        const office = (await agent.get('/api/brief?project=erp&work=1')).body.data;
        expect(office.work.days[0].projects[0].lines).toEqual(['10:15–12:00 Fixed the GST rounding in the invoice report and its tests']);

        // A day too far back, a bad body, a token without the scope.
        expect((await agent.post('/api/buddy/work', body({ day: addDays(today, -5) }))).status).toBe(400);
        expect((await agent.post('/api/buddy/work', body({ lines: [] }))).status).toBe(400);
        const reader = asAgent((await createTestToken(user, ['read'])).token);
        expect((await reader.post('/api/buddy/work', body())).status).toBe(403);
        // Paused: nothing written.
        await api(user).patch('/api/buddy/settings', { paused: true });
        expect((await agent.post('/api/buddy/work', body({ key: 'lw_chat4' }))).body.data).toEqual({ status: 'paused' });
    });

    it("the night reads his last day's work, says it only off the lock screen, and the summariser never writes a removed line again", async () => {
        const { user, hook } = await setup();
        await prisma.workLine.createMany({
            data: [
                { userId: user.id, day: new Date('2026-11-15T00:00:00Z'), project: 'erp', sessionKey: 'cc_erp', kind: 'did', text: 'Fixed the GST rounding in the invoice report', office: true, position: 0 },
                { userId: user.id, day: new Date('2026-11-15T00:00:00Z'), project: 'erp', sessionKey: 'cc_old', kind: 'did', text: 'Renamed the client folders', office: true, hidden: true, position: 0 },
            ],
        });
        const night = {
            memory: [],
            who: '',
            heading: '',
            now: 'A Sunday on the ERP.',
            lines: [
                { slot: 'morning', text: 'Fixed that GST rounding yesterday, nice work', form: 'observation', lockOk: true, sourceId: '' },
                { slot: 'afternoon', text: 'One topic before lunch, then the build', form: 'push', lockOk: true, sourceId: '' },
                { slot: 'evening', text: 'Lights out by eleven tonight', form: 'push', lockOk: true, sourceId: '' },
            ],
            note: 'Good Sunday on the invoice report. Today, the reviews first.',
            followUp: '',
            suggestions: [],
            notebook: '',
            weekly: { use: false, strong: '', slipping: '', fix: '', deadline: '', focus: [] },
        };
        fake.push(fakeMessage(night), fakeMessage({ lines: [{ slot: 'morning', reveals: true }, { slot: 'afternoon', reveals: false }, { slot: 'evening', reveals: false }], note: true }, { model: 'claude-sonnet-5-5' }));
        const r = (await nightIfDue(user.id, MONDAY_NIGHT))!;
        expect(fake.calls.map((c) => c.output_config?.format?.schema)).toEqual([NIGHT_SCHEMA, LOCK_SCHEMA]);
        const told = JSON.stringify(fake.calls[0]!.messages);
        expect(told).toContain('<work_yesterday>');
        expect(told).toContain('erp (office)');
        expect(told).toContain('Fixed the GST rounding in the invoice report');
        expect(told).not.toContain('Renamed the client folders');
        // The lock check was given the work as private; the line that names it stays off the lock screen.
        expect(JSON.stringify(fake.calls[1]!.messages)).toContain('Fixed the GST rounding in the invoice report');
        expect(r.lines.map((l) => [l.slot, l.lockOk])).toEqual([['morning', false], ['afternoon', true], ['evening', true]]);
        expect((await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id } })).noteLockOk).toBe(false);

        // The summariser is told what he removed, and a line saying it again is not written.
        await words(hook, 1, 'erp', [{ text: 'rename the client folders to the new scheme', reply: 'Renamed them.' }], { office: true });
        fake.push(gate(['work']), summary([['did', 'Renamed the client folders'], ['did', 'Checked the folder scheme with the team']]));
        await drainBuddyQueue(AFTER);
        expect(JSON.stringify(fake.calls[3]!.messages)).toContain('<removed>\\nRenamed the client folders');
        const sunday = await prisma.workLine.findMany({ where: { userId: user.id, sessionKey: 'cc_erp', hidden: false }, orderBy: { position: 'asc' } });
        expect(sunday.map((l) => l.text)).toEqual(['Checked the folder scheme with the team']);
    });
});
