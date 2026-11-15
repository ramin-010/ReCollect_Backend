// Routines (BUDDY_MEMORY_PLAN B6): three accepted task items in 30 days bring the offer, once; his
// yes makes a routine; the next night adds the buddy's dated task by itself (an agent edit he can
// undo), tells the night so its note names it; a routine switched off does nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { nightIfDue } from '../../src/services/buddy/worker';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';

const fake = new FakeClaude();
beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    setAiClientForTests(fake);
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = '';
    setAiClientForTests(null);
});
beforeEach(() => fake.reset());

const night = {
    memory: [],
    who: '',
    heading: '',
    now: 'A week of building.',
    lines: ['morning', 'afternoon', 'evening'].map((slot) => ({ slot, text: `A ${slot} line`, form: 'plain', lockOk: true, sourceId: '' })),
    note: 'I added the form for Friday to your tasks.',
    followUp: '',
    suggestions: [],
    notebook: 'Added a task by itself tonight.',
    weekly: { use: false, strong: '', slipping: '', fix: '', deadline: '', focus: [] },
};

const item = (userId: string, text: string, dueDay?: string) =>
    prisma.suggestion.create({ data: { userId, kind: 'task', text, payload: { title: text, ...(dueDay ? { dueDay } : {}) }, proposedBy: 'buddy', status: 'pending' } });

describe('routines', () => {
    it('done when: three accepts bring the offer; after the yes the next night adds the dated task by itself, with Undo, and the night is told', async () => {
        const user = await createTestUser();
        await api(user).patch('/api/buddy/settings', { enabled: true });
        for (const t of ['One', 'Two', 'Three']) {
            const s = await item(user.id, `Task ${t}`);
            expect((await api(user).post(`/api/suggestions/${s.id}/accept`)).status).toBe(200);
        }
        const offer = await prisma.suggestion.findFirstOrThrow({ where: { userId: user.id, kind: 'routine' } });
        expect(offer).toMatchObject({ status: 'pending', proposedBy: 'buddy', text: 'Add the tasks you mention with a day by itself from now on?' });
        // A fourth accept doesn't offer again.
        await api(user).post(`/api/suggestions/${(await item(user.id, 'Task Four')).id}/accept`);
        expect(await prisma.suggestion.count({ where: { userId: user.id, kind: 'routine' } })).toBe(1);

        expect((await api(user).post(`/api/suggestions/${offer.id}/accept`)).body.data.result).toMatch(/by itself now/);
        const you = (await api(user).get('/api/buddy/you')).body.data;
        expect(you.routines).toEqual([expect.objectContaining({ kind: 'auto_task', enabled: true, runs: 0 })]);

        // The next night: a dated task item waiting, and one without a day (left alone).
        const dated = await prisma.suggestion.create({ data: { userId: user.id, kind: 'task', text: 'Send the form', payload: { title: 'Send the form', dueDay: '2026-11-20' }, proposedBy: 'buddy', status: 'candidate' } });
        const undated = await item(user.id, 'Read DDIA someday');
        fake.push(fakeMessage(night));
        await nightIfDue(user.id, new Date(Date.UTC(2026, 10, 15, 23, 30)));
        expect(JSON.stringify(fake.calls[0]!.messages)).toContain('By his standing yes you just: added the task');
        expect((await prisma.suggestion.findUniqueOrThrow({ where: { id: dated.id } })).status).toBe('accepted');
        expect((await prisma.suggestion.findUniqueOrThrow({ where: { id: undated.id } })).status).toBe('pending');
        const task = await prisma.todo.findFirstOrThrow({ where: { userId: user.id, title: 'Send the form' } });
        const edit = await prisma.agentEdit.findFirstOrThrow({ where: { userId: user.id, kind: 'task_create', entityId: task.id } });
        expect(edit.agentName).toBe('Your buddy');
        expect((await api(user).post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(200);
        expect(await prisma.todo.count({ where: { id: task.id } })).toBe(0);
        expect((await api(user).get('/api/buddy/you')).body.data.routines[0]).toMatchObject({ runs: 1 });

        // Switched off: the next dated item waits for his tap.
        await api(user).patch(`/api/buddy/routines/${you.routines[0]._id}`, { enabled: false });
        const later = await prisma.suggestion.create({ data: { userId: user.id, kind: 'task', text: 'Call the bank', payload: { title: 'Call the bank', dueDay: '2026-11-21' }, proposedBy: 'buddy', status: 'candidate' } });
        fake.push(fakeMessage(night));
        await nightIfDue(user.id, new Date(Date.UTC(2026, 10, 16, 23, 30)));
        expect((await prisma.suggestion.findUniqueOrThrow({ where: { id: later.id } })).status).toBe('candidate');
    });

    it("the focus routine: three accepted focus lines bring the offer; the night sets the day's first line from an open week target, with Undo", async () => {
        const user = await createTestUser();
        await api(user).patch('/api/buddy/settings', { enabled: true });
        for (const t of ['One', 'Two', 'Three']) {
            const s = await prisma.suggestion.create({ data: { userId: user.id, kind: 'focus_line', text: `Focus ${t}`, payload: { text: `Focus ${t}` }, proposedBy: 'app', status: 'pending' } });
            await api(user).post(`/api/suggestions/${s.id}/accept`);
        }
        const offer = await prisma.suggestion.findFirstOrThrow({ where: { userId: user.id, kind: 'routine' } });
        expect(offer.payload).toEqual({ routine: 'auto_focus' });
        await api(user).post(`/api/suggestions/${offer.id}/accept`);
        // Today already has focus lines (the three accepted): the routine leaves the day alone.
        fake.push(fakeMessage(night));
        expect((await api(user).post('/api/buddy/think')).status).toBe(200);
        expect(await prisma.agentEdit.count({ where: { userId: user.id, kind: 'focus_add' } })).toBe(0);
        // A new day without focus lines, and an open week target: the first line comes from it.
        await prisma.focusItem.deleteMany({ where: { userId: user.id } });
        expect((await api(user).post('/api/week/targets', { text: 'Finish message queues' })).status).toBe(201);
        fake.push(fakeMessage(night));
        await api(user).post('/api/buddy/think');
        const line = await prisma.focusItem.findFirstOrThrow({ where: { userId: user.id } });
        expect(line.text).toBe('Finish message queues');
        const edit = await prisma.agentEdit.findFirstOrThrow({ where: { userId: user.id, kind: 'focus_add' } });
        expect((await api(user).post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(200);
        expect(await prisma.focusItem.count({ where: { userId: user.id } })).toBe(0);
    });
});
