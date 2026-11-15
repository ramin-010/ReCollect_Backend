// The Revise import's mapping (LOOP_COMPLETE_SPEC S3): Revise's rows in, what Recollect would make
// out. Pure: backend/scripts/import-revise.ts reads Revise (read-only), prints the plan, and writes
// it with --apply.
//
// Ramin's rulings (2026-11-14 night): read the live Revise database; Revise's topics (the canvases,
// their revisions, mentions and links) are not imported. What comes over:
//   Capture NOTE / LINK → Capture, with its revisions (the 1/3/7/21 schedule and what was done)
//   Capture TASK        → a personal Todo (done or not, the due day and time, weekly/monthly goal)
//   QuickNote           → QuickNote (Vault / Scratch kept)
//   Subject             → the subject of the same name (any case), made only when a row needs it
// Files stay where they are (their links are kept) but lose their Cloudinary ids: deleting the
// copy in Recollect must never delete a file Revise still shows. Reminders are not brought (old
// ones would fire at once). Empty quick notes are left out, and so is anything that looks like it
// holds a key, a token or a password (his Revise quick notes have some; keepSecrets brings them).
import { randomUUID } from 'node:crypto';
import { DEFAULT_TIMEZONE, dayFromReviseLabel, dayToUtcMidnight, isValidTime, startOfDay, timeToMinutes, type DayString } from '../learning/time';

export const IMPORT_SOURCE = 'revise';
/** A task without a time of day is due at 18:00 (as the task API reads a bare day). */
const DEFAULT_DUE_MINUTES = 18 * 60;
const TITLE_MAX = 300;

// ─── Revise's rows (as read with SELECT) ───────────────────────────────

export interface ReviseSubject {
    id: string;
    name: string;
    description: string | null;
    icon: string | null;
    color: string | null;
    createdAt: Date;
}

export interface ReviseCapture {
    id: string;
    type: 'NOTE' | 'TASK' | 'LINK';
    goalType: 'NONE' | 'WEEKLY' | 'MONTHLY';
    title: string | null;
    isPinned: boolean;
    subjectId: string | null;
    topicId: string | null;
    categoryId: string | null;
    content: string | null;
    url: string | null;
    cloudPublicId: string | null;
    fileType: string | null;
    isDone: boolean;
    completedAt: Date | null;
    dueDate: Date | null;
    time: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface ReviseAttachment {
    captureId: string;
    url: string;
    fileType: string | null;
    fileName: string | null;
}

export interface ReviseRevision {
    id: string;
    captureId: string;
    cycleNumber: number;
    intervalDays: number;
    scheduledFor: Date;
    completedAt: Date | null;
    status: string;
    createdAt: Date;
}

export interface ReviseQuickNote {
    id: string;
    content: string;
    isPinned: boolean;
    category: string;
    attachments: unknown;
    createdAt: Date;
    updatedAt: Date;
}

export interface ReviseData {
    subjects: ReviseSubject[];
    /** NoteCategory id → name. */
    categories: Map<string, string>;
    captures: ReviseCapture[];
    attachments: ReviseAttachment[];
    /** Revisions of captures (a topic's revisions are not read). */
    revisions: ReviseRevision[];
    quickNotes: ReviseQuickNote[];
    /** Reminders on captures: how many, and how many still ahead. */
    reminders: { total: number; ahead: number };
    /** What is never imported, counted: topics (by Ramin's ruling) and what has no place here. */
    left: Record<string, number>;
}

// ─── The plan ──────────────────────────────────────────────────────────

/** Where an imported row goes: a Recollect subject id, or a Revise subject to make first. */
export type SubjectRef = { existing: string } | { make: string } | null;

/** As the app stores a file (items.service AttachmentJson); a type, so it is a Prisma JSON value. */
export type AttachmentOut = {
    url: string;
    publicId: string;
    fileName: string;
    fileType: string;
};

export interface PlannedCapture {
    sourceId: string;
    subject: SubjectRef;
    data: {
        type: 'NOTE' | 'LINK';
        title: string | null;
        content: string | null;
        url: string | null;
        fileType: string | null;
        category: string | null;
        isPinned: boolean;
        attachments: AttachmentOut[];
        createdAt: Date;
        updatedAt: Date;
    };
    revisions: Array<{
        sourceId: string;
        data: { cycleNumber: number; intervalDays: number; scheduledFor: Date; completedAt: Date | null; status: 'pending' | 'done' | 'missed'; createdAt: Date };
    }>;
}

export interface PlannedTodo {
    sourceId: string;
    data: {
        title: string;
        description: string | null;
        status: 'pending' | 'complete';
        completedAt: Date | null;
        dueDate: Date | null;
        goalType: 'NONE' | 'WEEKLY' | 'MONTHLY';
        createdAt: Date;
        updatedAt: Date;
    };
}

export interface PlannedQuickNote {
    sourceId: string;
    data: { id: string; content: string; isPinned: boolean; category: 'PRIMARY' | 'TEMPORARY'; attachments: AttachmentOut[]; createdAt: Date; updatedAt: Date };
}

export interface ImportPlan {
    /** Revise subjects to make here (no subject of that name yet), by Revise id. */
    subjectsToMake: Array<{ sourceId: string; data: { name: string; description: string | null; icon: string | null; color: string | null; createdAt: Date } }>;
    captures: PlannedCapture[];
    todos: PlannedTodo[];
    quickNotes: PlannedQuickNote[];
    /** Rows a run before already brought, by kind. */
    already: { captures: number; todos: number; quickNotes: number };
    /** What can't come over as it was, said plainly. */
    notes: string[];
    left: Record<string, number>;
}

export interface ImportTarget {
    timezone: string;
    /** lower(name) → id of the target user's subjects. */
    subjectsByName: Map<string, string>;
    /** `${sourceTable}:${sourceId}` of every row brought before. */
    imported: ReadonlySet<string>;
}

const key = (table: string, id: string) => `${table}:${id}`;
const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** A plain line of text as the editor's HTML (the task description is HTML). */
function paragraphsHtml(text: string): string {
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`)
        .join('');
}

/** The first line of a text, cut to a title's length. */
function firstLine(text: string | null): string | null {
    const line = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean);
    return line ? line.slice(0, TITLE_MAX) : null;
}

/** A file's link without its Cloudinary id (so deleting the copy never deletes Revise's file). */
function attachmentOf(value: unknown): AttachmentOut | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (typeof v['url'] !== 'string' || !v['url']) return null;
    return {
        url: v['url'],
        publicId: '',
        fileName: typeof v['fileName'] === 'string' ? v['fileName'] : '',
        fileType: typeof v['fileType'] === 'string' ? v['fileType'] : '',
    };
}

/** A task's due moment: Revise's day label at its time of day (else 18:00) in the user's zone. */
export function dueOfTask(dueDate: Date | null, time: string | null, timezone: string = DEFAULT_TIMEZONE): Date | null {
    if (!dueDate) return null;
    const day: DayString = dayFromReviseLabel(dueDate);
    const minutes = time && isValidTime(time) ? timeToMinutes(time) : DEFAULT_DUE_MINUTES;
    return new Date(startOfDay(day, timezone).getTime() + minutes * 60_000);
}

const REVISION_STATUSES = new Set(['pending', 'done', 'missed']);

/** Text that looks like it holds a key, a token or a password (left out unless asked for). */
const SECRET_PATTERNS: readonly RegExp[] = [
    /\bsk-ant-[A-Za-z0-9_-]{10,}/,
    /\bsk-[A-Za-z0-9]{20,}/,
    /x-api-key/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
    /\b(password|passwd|pwd|secret|api[_-]?key)\s*[:=]\s*\S{6,}/i,
];

export const looksSecret = (...texts: Array<string | null | undefined>): boolean => texts.some((t) => !!t && SECRET_PATTERNS.some((re) => re.test(t)));

const blankToNull = (text: string | null): string | null => (text && text.trim() ? text : null);

/** What the import would make for the target, from Revise's rows. */
export function planReviseImport(source: ReviseData, target: ImportTarget, options: { keepSecrets?: boolean } = {}): ImportPlan {
    const notes: string[] = [];
    let secrets = 0;
    const subjectById = new Map(source.subjects.map((s) => [s.id, s]));
    const toMake = new Map<string, ImportPlan['subjectsToMake'][number]>();
    const subjectFor = (reviseSubjectId: string | null): SubjectRef => {
        const s = reviseSubjectId ? subjectById.get(reviseSubjectId) : undefined;
        if (!s) return null;
        const existing = target.subjectsByName.get(nameKey(s.name));
        if (existing) return { existing };
        if (!toMake.has(s.id)) toMake.set(s.id, { sourceId: s.id, data: { name: s.name.trim(), description: s.description, icon: s.icon, color: s.color, createdAt: s.createdAt } });
        return { make: s.id };
    };

    const filesOf = new Map<string, AttachmentOut[]>();
    for (const a of source.attachments) {
        const out = attachmentOf({ url: a.url, fileName: a.fileName, fileType: a.fileType });
        if (out) filesOf.set(a.captureId, [...(filesOf.get(a.captureId) ?? []), out]);
    }

    // One revision per cycle (Recollect keeps a cycle once): the newest wins.
    const revisionsOf = new Map<string, Map<number, ReviseRevision>>();
    let duplicateCycles = 0;
    let odd = 0;
    for (const r of source.revisions) {
        if (!REVISION_STATUSES.has(r.status)) {
            odd += 1;
            continue;
        }
        const cycles = revisionsOf.get(r.captureId) ?? new Map<number, ReviseRevision>();
        const had = cycles.get(r.cycleNumber);
        if (had) duplicateCycles += 1;
        if (!had || had.createdAt < r.createdAt) cycles.set(r.cycleNumber, r);
        revisionsOf.set(r.captureId, cycles);
    }
    if (duplicateCycles > 0) notes.push(`${duplicateCycles} revision(s) repeat a cycle of the same note: the newest of each cycle comes over`);
    if (odd > 0) notes.push(`${odd} revision(s) have a status Recollect doesn't know: left out`);

    const already = { captures: 0, todos: 0, quickNotes: 0 };
    const captures: PlannedCapture[] = [];
    const todos: PlannedTodo[] = [];
    let onTopics = 0;
    let taskRevisions = 0;
    let filesKeptAsLinks = 0;
    for (const c of source.captures) {
        if (!options.keepSecrets && looksSecret(c.title, c.content, c.url)) {
            if (!target.imported.has(key('Capture', c.id))) secrets += 1;
            continue;
        }
        if (c.topicId) onTopics += 1;
        if (c.type === 'TASK') {
            if (target.imported.has(key('Capture', c.id))) {
                already.todos += 1;
                continue;
            }
            taskRevisions += revisionsOf.get(c.id)?.size ?? 0;
            const title = (c.title?.trim() || firstLine(c.content) || 'Untitled task').slice(0, TITLE_MAX);
            const body = c.content?.trim() && c.content.trim() !== title ? c.content.trim() : null;
            todos.push({
                sourceId: c.id,
                data: {
                    title,
                    description: body ? paragraphsHtml(body) : null,
                    status: c.isDone ? 'complete' : 'pending',
                    completedAt: c.isDone ? c.completedAt ?? c.updatedAt : null,
                    dueDate: dueOfTask(c.dueDate, c.time, target.timezone),
                    goalType: c.goalType,
                    createdAt: c.createdAt,
                    updatedAt: c.updatedAt,
                },
            });
            continue;
        }
        if (target.imported.has(key('Capture', c.id))) {
            already.captures += 1;
            continue;
        }
        const files = filesOf.get(c.id) ?? [];
        if (c.cloudPublicId || files.length > 0) filesKeptAsLinks += 1;
        const cycles = [...(revisionsOf.get(c.id)?.values() ?? [])].sort((a, b) => a.cycleNumber - b.cycleNumber);
        captures.push({
            sourceId: c.id,
            subject: subjectFor(c.subjectId),
            data: {
                type: c.type,
                title: c.title?.trim() || null,
                content: blankToNull(c.content),
                url: c.url,
                fileType: c.fileType,
                category: c.categoryId ? source.categories.get(c.categoryId) ?? null : null,
                isPinned: c.isPinned,
                attachments: files,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
            },
            revisions: cycles.map((r) => ({
                sourceId: r.id,
                data: {
                    cycleNumber: r.cycleNumber,
                    intervalDays: r.intervalDays,
                    scheduledFor: dayToUtcMidnight(dayFromReviseLabel(r.scheduledFor)),
                    completedAt: r.completedAt,
                    status: r.status as 'pending' | 'done' | 'missed',
                    createdAt: r.createdAt,
                },
            })),
        });
    }
    if (onTopics > 0) notes.push(`${onTopics} note(s), link(s) or task(s) were filed under a topic: they come over without it (topics stay in Revise)`);
    if (taskRevisions > 0) notes.push(`${taskRevisions} revision(s) belong to tasks: a task here has no revision schedule, so they are left out`);
    if (filesKeptAsLinks > 0) notes.push(`${filesKeptAsLinks} item(s) carry uploaded files: they come over as links to the same files (deleting them here never deletes Revise's files)`);
    if (source.reminders.total > 0) notes.push(`${source.reminders.total} reminder(s) are not brought (${source.reminders.ahead} still ahead): set them again here`);

    const quickNotes: PlannedQuickNote[] = [];
    let oddCategories = 0;
    let empty = 0;
    for (const q of source.quickNotes) {
        if (target.imported.has(key('QuickNote', q.id))) {
            already.quickNotes += 1;
            continue;
        }
        const files = (Array.isArray(q.attachments) ? q.attachments : []).map(attachmentOf).filter((a): a is AttachmentOut => !!a);
        if (!q.content.trim() && files.length === 0) {
            empty += 1;
            continue;
        }
        if (!options.keepSecrets && looksSecret(q.content)) {
            secrets += 1;
            continue;
        }
        const category = q.category === 'TEMPORARY' ? 'TEMPORARY' : 'PRIMARY';
        if (q.category !== 'TEMPORARY' && q.category !== 'PRIMARY') oddCategories += 1;
        quickNotes.push({ sourceId: q.id, data: { id: randomUUID(), content: q.content, isPinned: q.isPinned, category, attachments: files, createdAt: q.createdAt, updatedAt: q.updatedAt } });
    }
    if (oddCategories > 0) notes.push(`${oddCategories} quick note(s) had a category other than Vault or Scratch: they go to the Vault`);
    if (empty > 0) notes.push(`${empty} quick note(s) are empty (no text, no file): left out`);
    if (secrets > 0) notes.push(`${secrets} item(s) look like they hold an API key, a token or a password: left out (keep those in a password manager; --keep-secrets brings them)`);

    return { subjectsToMake: [...toMake.values()], captures, todos, quickNotes, already, notes, left: source.left };
}
