// The Revise import's mapping (src/services/import/reviseImport.ts): what each Revise row becomes,
// what a second run skips, and what is said plainly about what can't come over as it was.
import { describe, expect, it } from 'vitest';
import { dueOfTask, planReviseImport, type ReviseCapture, type ReviseData } from '../../../src/services/import/reviseImport';

const at = (iso: string) => new Date(iso);

function capture(over: Partial<ReviseCapture> & Pick<ReviseCapture, 'id' | 'type'>): ReviseCapture {
    return {
        goalType: 'NONE',
        title: null,
        isPinned: false,
        subjectId: null,
        topicId: null,
        categoryId: null,
        content: null,
        url: null,
        cloudPublicId: null,
        fileType: null,
        isDone: false,
        completedAt: null,
        dueDate: null,
        time: null,
        createdAt: at('2026-09-01T10:00:00Z'),
        updatedAt: at('2026-09-02T10:00:00Z'),
        ...over,
    };
}

function source(over: Partial<ReviseData> = {}): ReviseData {
    return {
        subjects: [
            { id: 's-dsa', name: 'DSA', description: null, icon: null, color: '#007acc', createdAt: at('2026-08-01T00:00:00Z') },
            { id: 's-os', name: 'Operating systems', description: 'Kernel notes', icon: null, color: null, createdAt: at('2026-08-02T00:00:00Z') },
        ],
        categories: new Map([['cat-1', 'Idea']]),
        captures: [],
        attachments: [],
        revisions: [],
        quickNotes: [],
        reminders: { total: 0, ahead: 0 },
        left: { topics: 12 },
        ...over,
    };
}

const target = (imported: string[] = []) => ({ timezone: 'Asia/Kolkata', subjectsByName: new Map([['dsa', 'rc-dsa']]), imported: new Set(imported) });

describe('dueOfTask', () => {
    it("reads Revise's day labels (and the legacy 18:30Z ones) at the task's time, else 18:00, in his zone", () => {
        expect(dueOfTask(at('2026-11-20T00:00:00Z'), '09:00')!.toISOString()).toBe('2026-11-20T03:30:00.000Z');
        expect(dueOfTask(at('2026-11-19T18:30:00Z'), null)!.toISOString()).toBe('2026-11-20T12:30:00.000Z');
        expect(dueOfTask(at('2026-11-20T00:00:00Z'), 'soon')!.toISOString()).toBe('2026-11-20T12:30:00.000Z');
        expect(dueOfTask(null, '09:00')).toBeNull();
    });
});

describe('planReviseImport', () => {
    it('notes and links become captures: subject matched by name or made once, category by name, files without their Cloudinary ids', () => {
        const plan = planReviseImport(
            source({
                captures: [
                    capture({ id: 'n1', type: 'NOTE', title: 'Heap tricks', content: 'k smallest', subjectId: 's-dsa', categoryId: 'cat-1', isPinned: true }),
                    capture({ id: 'n2', type: 'NOTE', content: 'Paging', subjectId: 's-os', topicId: 't-1' }),
                    capture({ id: 'l1', type: 'LINK', url: 'https://res.cloudinary.com/x/raw/upload/a.pdf', cloudPublicId: 'revise/a', fileType: 'application/pdf', subjectId: 's-os' }),
                ],
                attachments: [{ captureId: 'n1', url: 'https://res.cloudinary.com/x/image/upload/h.png', fileType: 'image/png', fileName: 'h.png' }],
            }),
            target()
        );
        expect(plan.captures.map((c) => [c.sourceId, c.data.type, c.subject])).toEqual([
            ['n1', 'NOTE', { existing: 'rc-dsa' }],
            ['n2', 'NOTE', { make: 's-os' }],
            ['l1', 'LINK', { make: 's-os' }],
        ]);
        expect(plan.subjectsToMake).toEqual([{ sourceId: 's-os', data: { name: 'Operating systems', description: 'Kernel notes', icon: null, color: null, createdAt: at('2026-08-02T00:00:00Z') } }]);
        expect(plan.captures[0]!.data).toMatchObject({ title: 'Heap tricks', category: 'Idea', isPinned: true, attachments: [{ url: 'https://res.cloudinary.com/x/image/upload/h.png', publicId: '', fileName: 'h.png', fileType: 'image/png' }] });
        expect(plan.captures[2]!.data).toMatchObject({ url: 'https://res.cloudinary.com/x/raw/upload/a.pdf', fileType: 'application/pdf' });
        expect(plan.notes).toEqual([
            '1 note(s), link(s) or task(s) were filed under a topic: they come over without it (topics stay in Revise)',
            "2 item(s) carry uploaded files: they come over as links to the same files (deleting them here never deletes Revise's files)",
        ]);
        expect(plan.left).toEqual({ topics: 12 });
    });

    it('revisions come with their note: days read from labels, one per cycle (the newest), unknown statuses left out', () => {
        const plan = planReviseImport(
            source({
                captures: [capture({ id: 'n1', type: 'NOTE', title: 'Tries' })],
                revisions: [
                    { id: 'r1', captureId: 'n1', cycleNumber: 1, intervalDays: 1, scheduledFor: at('2026-11-09T18:30:00Z'), completedAt: at('2026-11-10T05:00:00Z'), status: 'done', createdAt: at('2026-11-09T00:00:00Z') },
                    { id: 'r2a', captureId: 'n1', cycleNumber: 2, intervalDays: 3, scheduledFor: at('2026-11-13T00:00:00Z'), completedAt: null, status: 'pending', createdAt: at('2026-11-10T00:00:00Z') },
                    { id: 'r2b', captureId: 'n1', cycleNumber: 2, intervalDays: 3, scheduledFor: at('2026-11-14T00:00:00Z'), completedAt: null, status: 'pending', createdAt: at('2026-11-11T00:00:00Z') },
                    { id: 'r3', captureId: 'n1', cycleNumber: 3, intervalDays: 7, scheduledFor: at('2026-11-21T00:00:00Z'), completedAt: null, status: 'skipped', createdAt: at('2026-11-11T00:00:00Z') },
                ],
            }),
            target()
        );
        expect(plan.captures[0]!.revisions.map((r) => [r.sourceId, r.data.cycleNumber, r.data.scheduledFor.toISOString().slice(0, 10), r.data.status])).toEqual([
            ['r1', 1, '2026-11-10', 'done'],
            ['r2b', 2, '2026-11-14', 'pending'],
        ]);
        expect(plan.notes).toEqual([
            '1 revision(s) repeat a cycle of the same note: the newest of each cycle comes over',
            "1 revision(s) have a status Kaaga doesn't know: left out",
        ]);
    });

    it('tasks become personal todos: a title from the text when there is none, the text as HTML, done, due, goals', () => {
        const plan = planReviseImport(
            source({
                captures: [
                    capture({ id: 't1', type: 'TASK', content: 'Mock interview <system design>\n\nbook a slot', dueDate: at('2026-11-20T00:00:00Z'), time: '19:30', goalType: 'WEEKLY' }),
                    capture({ id: 't2', type: 'TASK', title: 'Renew domain', isDone: true, completedAt: at('2026-10-01T08:00:00Z') }),
                ],
                revisions: [{ id: 'rt', captureId: 't2', cycleNumber: 1, intervalDays: 1, scheduledFor: at('2026-10-02T00:00:00Z'), completedAt: null, status: 'pending', createdAt: at('2026-10-01T00:00:00Z') }],
                reminders: { total: 2, ahead: 1 },
            }),
            target()
        );
        expect(plan.todos.map((t) => t.data)).toEqual([
            {
                title: 'Mock interview <system design>',
                description: '<p>Mock interview &lt;system design&gt;</p><p>book a slot</p>',
                status: 'pending',
                completedAt: null,
                dueDate: at('2026-11-20T14:00:00Z'),
                goalType: 'WEEKLY',
                createdAt: at('2026-09-01T10:00:00Z'),
                updatedAt: at('2026-09-02T10:00:00Z'),
            },
            {
                title: 'Renew domain',
                description: null,
                status: 'complete',
                completedAt: at('2026-10-01T08:00:00Z'),
                dueDate: null,
                goalType: 'NONE',
                createdAt: at('2026-09-01T10:00:00Z'),
                updatedAt: at('2026-09-02T10:00:00Z'),
            },
        ]);
        expect(plan.captures).toEqual([]);
        expect(plan.notes).toEqual([
            '1 revision(s) belong to tasks: a task here has no revision schedule, so they are left out',
            '2 reminder(s) are not brought (1 still ahead): set them again here',
        ]);
    });

    it('quick notes keep Vault or Scratch (anything else goes to the Vault), with new ids', () => {
        const plan = planReviseImport(
            source({
                quickNotes: [
                    { id: 'q1', content: 'git rebase -i', isPinned: true, category: 'PRIMARY', attachments: [{ url: 'https://x/y.png', publicId: 'p', fileName: 'y.png', fileType: 'image/png' }], createdAt: at('2026-09-01T00:00:00Z'), updatedAt: at('2026-09-01T00:00:00Z') },
                    { id: 'q2', content: 'call bank', isPinned: false, category: 'TEMPORARY', attachments: null, createdAt: at('2026-09-01T00:00:00Z'), updatedAt: at('2026-09-01T00:00:00Z') },
                    { id: 'q3', content: 'misc', isPinned: false, category: 'OLD', attachments: [], createdAt: at('2026-09-01T00:00:00Z'), updatedAt: at('2026-09-01T00:00:00Z') },
                ],
            }),
            target()
        );
        expect(plan.quickNotes.map((n) => [n.sourceId, n.data.category, n.data.attachments])).toEqual([
            ['q1', 'PRIMARY', [{ url: 'https://x/y.png', publicId: '', fileName: 'y.png', fileType: 'image/png' }]],
            ['q2', 'TEMPORARY', []],
            ['q3', 'PRIMARY', []],
        ]);
        expect(plan.quickNotes[0]!.data.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(plan.notes).toEqual(['1 quick note(s) had a category other than Vault or Scratch: they go to the Vault']);
    });

    it('leaves out empty quick notes and anything that looks like a key or a password (unless asked)', () => {
        const q = (id: string, content: string, attachments: unknown = []) => ({ id, content, isPinned: false, category: 'PRIMARY', attachments, createdAt: at('2026-09-01T00:00:00Z'), updatedAt: at('2026-09-01T00:00:00Z') });
        const data = source({
            captures: [capture({ id: 'n1', type: 'NOTE', title: 'token: sk-ant-api03-FAKEFAKEFAKEFAKE' }), capture({ id: 'n2', type: 'NOTE', title: 'Two pointers', content: '  ' })],
            quickNotes: [q('q1', ''), q('q2', '', [{ url: 'https://x/a.png', fileName: 'a.png', fileType: 'image/png' }]), q('q3', 'curl -H "x-api-key: abc" https://api'), q('q4', 'db password = hunter2!!'), q('q5', 'git log --oneline')],
        });
        const plan = planReviseImport(data, target());
        expect(plan.captures.map((c) => [c.sourceId, c.data.content])).toEqual([['n2', null]]);
        expect(plan.quickNotes.map((n) => n.sourceId)).toEqual(['q2', 'q5']);
        expect(plan.notes).toEqual([
            '1 quick note(s) are empty (no text, no file): left out',
            '3 item(s) look like they hold an API key, a token or a password: left out (keep those in a password manager; --keep-secrets brings them)',
        ]);
        const kept = planReviseImport(data, target(), { keepSecrets: true });
        expect(kept.captures.map((c) => c.sourceId)).toEqual(['n1', 'n2']);
        expect(kept.quickNotes.map((n) => n.sourceId)).toEqual(['q2', 'q3', 'q4', 'q5']);
    });

    it('a second run brings only what is new', () => {
        const data = source({
            captures: [capture({ id: 'n1', type: 'NOTE', title: 'old' }), capture({ id: 'n2', type: 'NOTE', title: 'new' }), capture({ id: 't1', type: 'TASK', title: 'task' })],
            quickNotes: [{ id: 'q1', content: 'x', isPinned: false, category: 'PRIMARY', attachments: [], createdAt: at('2026-09-01T00:00:00Z'), updatedAt: at('2026-09-01T00:00:00Z') }],
        });
        const plan = planReviseImport(data, target(['Capture:n1', 'Capture:t1', 'QuickNote:q1']));
        expect(plan.captures.map((c) => c.sourceId)).toEqual(['n2']);
        expect(plan.todos).toEqual([]);
        expect(plan.quickNotes).toEqual([]);
        expect(plan.already).toEqual({ captures: 1, todos: 1, quickNotes: 1 });
    });
});
