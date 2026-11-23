// STUDY_FLOW_PLAN §4.3 (11-23): notes and links on a lesson or a subject, for chats. They are the app's own notes
// (Capture: Ctrl K's "Note" and "Link"), attached to a lesson (its topic, and so its subject) or to a subject; the doc
// page shows a lesson's in its right sidebar. Chats add, read (some, a lesson's, a subject's, all of them), change,
// move, merge and remove them, each write logged with an Undo: the edit kind pocket_add with `undoData.note` (no new
// enum value: ECOSYSTEM_V2_PLAN §10.1). A note attached to nothing (Home's Inbox) stays the person's own: never listed,
// changed or removed by an agent, like the Pocket.
//
//   POST  /api/agent/notes { docId | subject, title, markdown?, url? }            learning:write
//   GET   /api/agent/notes ?docId= | subject= [&lessons=1] | ids=a,b [&cursor=n]   read
//   PATCH /api/agent/notes/:id { title?, markdown?, url?, docId? | subject? }      learning:write
//   POST  /api/agent/notes/:id/remove { into? }                                  learning:write
import type { Capture, CaptureType, Prisma, Revision } from '@prisma/client';
import { prisma } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { findAccessibleDoc } from '../docs/docs.service';
import { quoted, recordAgentEdit, type AgentActor } from './agentEditLog';

export const NOTE_TITLE_MAX = 120;
export const NOTE_TEXT_MAX = 8000;
/** One answer's text at most; the rest comes with `cursor`. */
export const NOTES_ANSWER_MAX = 60_000;

/** Where a note lives: a lesson (its topic and doc) or a subject alone. */
interface Place {
    subjectId: string;
    subjectName: string;
    topicId: string | null;
    docId: string | null;
    lessonTitle: string | null;
}

const placeName = (p: Place): string => quoted(p.lessonTitle ?? p.subjectName, 80);

/** A lesson by its doc, or a subject by its name (case aside). */
async function placeOf(userId: string, where: { docId?: string | undefined; subject?: string | undefined }): Promise<Place> {
    if (where.docId) {
        const topic = await prisma.topic.findFirst({
            where: { userId, docId: where.docId },
            select: { id: true, title: true, subjectId: true, subject: { select: { name: true } }, doc: { select: { title: true } } },
        });
        if (topic) return { subjectId: topic.subjectId, subjectName: topic.subject.name, topicId: topic.id, docId: where.docId, lessonTitle: topic.doc?.title || topic.title };
        if (!(await findAccessibleDoc(where.docId, userId))) throw new ErrorResponse(404, 'Doc not found');
        throw new ErrorResponse(409, "This doc isn't on a subject's path yet: file it under a subject first (update_doc), or save the note on the subject.");
    }
    const name = (where.subject ?? '').trim();
    if (!name) throw new ErrorResponse(400, 'Say where it goes: docId (a lesson) or subject (its name).');
    const subject = await prisma.subject.findFirst({ where: { userId, name: { equals: name, mode: 'insensitive' } }, select: { id: true, name: true } });
    if (!subject) {
        const all = await prisma.subject.findMany({ where: { userId }, select: { name: true }, orderBy: { name: 'asc' }, take: 30 });
        throw new ErrorResponse(404, `No subject named ${quoted(name, 80)}.${all.length ? ` Their subjects: ${all.map((s) => s.name).join(', ')}.` : ' They have no subjects yet.'}`);
    }
    return { subjectId: subject.id, subjectName: subject.name, topicId: null, docId: null, lessonTitle: null };
}

/** A note an agent may touch: theirs, and attached to a lesson or a subject. */
const attached = (userId: string): Prisma.CaptureWhereInput => ({ userId, OR: [{ subjectId: { not: null } }, { topicId: { not: null } }] });

const noteInclude = {
    subject: { select: { name: true } },
    topic: { select: { title: true, docId: true, doc: { select: { title: true } } } },
} satisfies Prisma.CaptureInclude;

type NoteRow = Prisma.CaptureGetPayload<{ include: typeof noteInclude }>;

async function attachedNote(userId: string, id: string, label = 'note'): Promise<NoteRow> {
    const row = await prisma.capture.findFirst({ where: { id, ...attached(userId) }, include: noteInclude });
    if (!row) throw new ErrorResponse(404, `No ${label} with the id ${id} on a lesson or a subject (list_notes shows them).`);
    return row;
}

const titleOf = (c: Pick<Capture, 'title' | 'content' | 'url'>): string =>
    c.title?.trim() || c.content?.trim().split('\n')[0]?.slice(0, 80).trim() || c.url?.trim() || 'Untitled note';

const kindOf = (url: string | null, content: string | null): CaptureType => (url && !content ? 'LINK' : 'NOTE');

/** A note as agents read it. */
export function noteJson(c: NoteRow) {
    return {
        id: c.id,
        kind: c.type === 'LINK' ? ('link' as const) : ('note' as const),
        title: titleOf(c),
        url: c.url,
        text: c.content ?? '',
        day: c.createdAt.toISOString(),
        by: c.createdBy === 'agent' ? c.agentName || 'an app' : 'the user',
        lesson: c.topic ? { docId: c.topic.docId, title: c.topic.doc?.title || c.topic.title } : null,
        subject: c.subject?.name ?? null,
    };
}

const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const normUrl = (s: string | null | undefined): string => norm(s).replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');

function cleanUrl(url: string | undefined): string | null {
    const u = url?.trim();
    if (!u) return null;
    if (!/^https?:\/\/\S+$/i.test(u) || u.length > 2048) throw new ErrorResponse(400, 'url must be a web address (http or https).');
    return u;
}

function cleanTitle(title: string): string {
    const t = title.replace(/\s+/g, ' ').trim();
    if (!t) throw new ErrorResponse(400, 'A note needs a title.');
    return t.slice(0, NOTE_TITLE_MAX);
}

function cleanText(markdown: string | undefined): string | null {
    if (markdown === undefined) return null;
    if (markdown.length > NOTE_TEXT_MAX) throw new ErrorResponse(400, `A note is at most ${NOTE_TEXT_MAX.toLocaleString('en')} characters: keep what is worth coming back to, or add it to the lesson itself.`);
    return markdown.trim() ? markdown.trim() : null;
}

export interface AddNoteInput {
    docId?: string | undefined;
    subject?: string | undefined;
    title: string;
    markdown?: string | undefined;
    url?: string | undefined;
}

/** POST /api/agent/notes → { id, kind, title, lesson, subject, already?, editId } */
export async function addNoteForAgent(actor: AgentActor, input: AddNoteInput) {
    const place = await placeOf(actor.userId, input);
    const title = cleanTitle(input.title);
    const content = cleanText(input.markdown);
    const url = cleanUrl(input.url);
    if (!content && !url) throw new ErrorResponse(400, 'Send the note (markdown) or a link (url).');

    // The same note (or the same link) in the same place is not added twice (a retry, two chats).
    const here = await prisma.capture.findMany({ where: { userId: actor.userId, subjectId: place.subjectId, topicId: place.topicId }, select: { id: true, title: true, content: true, url: true } });
    const same = here.find((c) => (url && c.url && normUrl(c.url) === normUrl(url)) || (norm(c.title) === norm(title) && norm(c.content) === norm(content) && normUrl(c.url) === normUrl(url)));
    const lesson = place.docId ? { docId: place.docId, title: place.lessonTitle } : null;
    if (same) return { id: same.id, kind: url && !content ? 'link' : 'note', title: titleOf(same), lesson, subject: place.subjectName, already: true as const, editId: null };

    const type = kindOf(url, content);
    const { id, editId } = await prisma.$transaction(async (tx) => {
        const row = await tx.capture.create({
            data: { userId: actor.userId, type, title, content, url, subjectId: place.subjectId, topicId: place.topicId, createdBy: 'agent', agentName: actor.agentName },
            select: { id: true },
        });
        const editId = await recordAgentEdit(
            actor,
            {
                kind: 'pocket_add',
                summary: type === 'LINK' ? `Saved a link on ${placeName(place)}: ${quoted(title, 60)}` : `Added a note to ${placeName(place)}: ${quoted(title, 60)}`,
                entityId: row.id,
                docId: place.docId,
                undoData: { note: { op: 'add' } },
            },
            tx
        );
        return { id: row.id, editId };
    });
    return { id, kind: type === 'LINK' ? 'link' : 'note', title, lesson, subject: place.subjectName, editId };
}

export interface ListNotesInput {
    docId?: string | undefined;
    subject?: string | undefined;
    /** With subject: its lessons' notes too, each with its lesson. */
    lessons?: boolean | undefined;
    ids?: readonly string[] | undefined;
    cursor?: number | undefined;
}

/** GET /api/agent/notes → { place, notes, more } (more: the cursor for the rest, or null). */
export async function listNotesForAgent(userId: string, input: ListNotesInput) {
    let where: Prisma.CaptureWhereInput;
    let place: { lesson: { docId: string; title: string | null } | null; subject: string | null } | null = null;
    if (input.ids?.length) {
        where = { id: { in: [...input.ids] }, ...attached(userId) };
    } else {
        let p: Place;
        try {
            p = await placeOf(userId, input);
        } catch (err) {
            // A lesson not on a path has no notes yet: say so, no error.
            if (err instanceof ErrorResponse && err.statusCode === 409) return { place: null, notes: [], more: null };
            throw err;
        }
        place = { lesson: p.docId ? { docId: p.docId, title: p.lessonTitle } : null, subject: p.subjectName };
        where = p.topicId ? { userId, topicId: p.topicId } : { userId, subjectId: p.subjectId, ...(input.lessons ? {} : { topicId: null }) };
    }
    const skip = Math.max(0, input.cursor ?? 0);
    const rows = await prisma.capture.findMany({ where, include: noteInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: 201 });
    const notes: ReturnType<typeof noteJson>[] = [];
    let used = 0;
    for (const row of rows.slice(0, 200)) {
        const n = noteJson(row);
        const size = n.text.length + n.title.length + (n.url?.length ?? 0);
        if (notes.length > 0 && used + size > NOTES_ANSWER_MAX) break;
        notes.push(n);
        used += size;
    }
    const more = rows.length > notes.length ? skip + notes.length : null;
    return { place, notes, more };
}

export interface UpdateNoteInput {
    title?: string | undefined;
    markdown?: string | undefined;
    url?: string | null | undefined;
    docId?: string | undefined;
    subject?: string | undefined;
}

/** The fields Undo puts back after a change. */
const beforeOf = (c: Capture) => ({ title: c.title, content: c.content, url: c.url, type: c.type, subjectId: c.subjectId, topicId: c.topicId });

/** PATCH /api/agent/notes/:id → the note as agents read it, with editId. */
export async function updateNoteForAgent(actor: AgentActor, id: string, input: UpdateNoteInput) {
    const row = await attachedNote(actor.userId, id);
    const move = input.docId || input.subject ? await placeOf(actor.userId, input) : null;
    const data: Prisma.CaptureUncheckedUpdateInput = {};
    if (input.title !== undefined) data.title = cleanTitle(input.title);
    if (input.markdown !== undefined) data.content = cleanText(input.markdown);
    if (input.url !== undefined) data.url = input.url === null ? null : cleanUrl(input.url);
    if (move) {
        data.subjectId = move.subjectId;
        data.topicId = move.topicId;
    }
    if (!Object.keys(data).length) throw new ErrorResponse(400, 'Nothing to change: send title, markdown, url, or where it goes (docId or subject).');
    const content = data.content !== undefined ? (data.content as string | null) : row.content;
    const url = data.url !== undefined ? (data.url as string | null) : row.url;
    if (!content && !url) throw new ErrorResponse(400, 'A note keeps its text or its link: remove it instead (remove_note).');
    data.type = kindOf(url, content);

    const name = quoted(titleOf(row), 60);
    const summary = move && (move.topicId !== row.topicId || move.subjectId !== row.subjectId) ? `Moved the note ${name} to ${placeName(move)}` : `Changed the note ${name}`;
    const editId = await prisma.$transaction(async (tx) => {
        await tx.capture.update({ where: { id }, data, select: { id: true } });
        return recordAgentEdit(actor, { kind: 'pocket_add', summary, entityId: id, docId: move?.docId ?? row.topic?.docId ?? null, undoData: { note: { op: 'update', before: beforeOf(row) } } }, tx);
    });
    return { ...noteJson(await attachedNote(actor.userId, id)), editId };
}

/** POST /api/agent/notes/:id/remove { into? } → { id, removed: true, into, editId } */
export async function removeNoteForAgent(actor: AgentActor, id: string, input: { into?: string | undefined }) {
    const row = await attachedNote(actor.userId, id);
    let into: NoteRow | null = null;
    if (input.into) {
        if (input.into === id) throw new ErrorResponse(400, 'into names the note that stays: another note.');
        into = await attachedNote(actor.userId, input.into, 'note to merge into');
    }
    const revisions = await prisma.revision.findMany({ where: { captureId: id } });
    // Everything Undo needs to bring it back with its id, its place and its reviews (its files stay in storage).
    const { subject: _s, topic: _t, ...plain } = row;
    const before = { ...plain, revisions } as unknown as Prisma.InputJsonValue;
    const summary = into ? `Merged the note ${quoted(titleOf(row), 60)} into ${quoted(titleOf(into), 60)}` : `Removed the note ${quoted(titleOf(row), 60)}`;
    const editId = await prisma.$transaction(async (tx) => {
        await tx.capture.deleteMany({ where: { id, userId: actor.userId } });
        return recordAgentEdit(actor, { kind: 'pocket_add', summary, entityId: id, docId: row.topic?.docId ?? into?.topic?.docId ?? null, undoData: { note: { op: 'remove', before } } }, tx);
    });
    return { id, removed: true as const, into: into?.id ?? null, editId };
}

// ─── Undo (agentEdits.service.ts, pocket_add with undoData.note) ─────────

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const date = (v: unknown): Date | undefined => (typeof v === 'string' ? new Date(v) : undefined);
/** `{ createdAt }` when the stored row had one (exact optional types: never `undefined`). */
const createdAtOf = (v: unknown): { createdAt: Date } | Record<string, never> => (typeof v === 'string' ? { createdAt: new Date(v) } : {});

async function placeStillThere(userId: string, subjectId: string | null, topicId: string | null) {
    const [subject, topic] = await Promise.all([
        subjectId ? prisma.subject.findFirst({ where: { id: subjectId, userId }, select: { id: true } }) : null,
        topicId ? prisma.topic.findFirst({ where: { id: topicId, userId }, select: { id: true } }) : null,
    ]);
    return { subjectId: subject?.id ?? null, topicId: topic?.id ?? null };
}

/** Takes one agent's note edit back: an added note goes, a change goes back, a removed note comes back with its reviews. */
export async function undoNoteEdit(userId: string, id: string, note: Json): Promise<void> {
    const op = note['op'];
    if (op === 'add') {
        await prisma.capture.deleteMany({ where: { id, userId } });
        return;
    }
    const b = (note['before'] ?? {}) as Json;
    if (op === 'update') {
        const place = await placeStillThere(userId, str(b['subjectId']), str(b['topicId']));
        await prisma.capture.updateMany({
            where: { id, userId },
            data: {
                title: str(b['title']),
                content: str(b['content']),
                url: str(b['url']),
                ...(b['type'] === 'LINK' || b['type'] === 'NOTE' ? { type: b['type'] } : {}),
                // A lesson or subject deleted since: the note stays where it is now.
                ...(place.subjectId || !b['subjectId'] ? { subjectId: place.subjectId } : {}),
                ...(place.topicId || !b['topicId'] ? { topicId: place.topicId } : {}),
            },
        });
        return;
    }
    if (op !== 'remove') throw new ErrorResponse(409, 'This edit cannot be undone');
    if (await prisma.capture.findUnique({ where: { id }, select: { id: true } })) return; // back already
    const place = await placeStillThere(userId, str(b['subjectId']), str(b['topicId']));
    const revisions = (Array.isArray(b['revisions']) ? b['revisions'] : []) as Json[];
    await prisma.$transaction(async (tx) => {
        await tx.capture.create({
            data: {
                id,
                userId,
                type: b['type'] === 'LINK' ? 'LINK' : 'NOTE',
                title: str(b['title']),
                content: str(b['content']),
                url: str(b['url']),
                cloudPublicId: str(b['cloudPublicId']),
                fileType: str(b['fileType']),
                category: str(b['category']),
                isPinned: b['isPinned'] === true,
                subjectId: place.subjectId,
                topicId: place.topicId,
                attachments: (Array.isArray(b['attachments']) ? b['attachments'] : []) as Prisma.InputJsonValue,
                createdBy: b['createdBy'] === 'agent' ? 'agent' : 'user',
                agentName: str(b['agentName']),
                ...createdAtOf(b['createdAt']),
            },
            select: { id: true },
        });
        const back = revisions.filter((r) => typeof r['id'] === 'string' && typeof r['cycleNumber'] === 'number' && typeof r['scheduledFor'] === 'string');
        if (back.length) {
            await tx.revision.createMany({
                data: back.map((r) => ({
                    id: r['id'] as string,
                    userId,
                    captureId: id,
                    cycleNumber: r['cycleNumber'] as number,
                    intervalDays: typeof r['intervalDays'] === 'number' ? r['intervalDays'] : 1,
                    scheduledFor: new Date(r['scheduledFor'] as string),
                    completedAt: date(r['completedAt']) ?? null,
                    status: (r['status'] === 'done' || r['status'] === 'missed' ? r['status'] : 'pending') as Revision['status'],
                    ...(r['undo'] !== undefined && r['undo'] !== null ? { undo: r['undo'] as Prisma.InputJsonValue } : {}),
                    ...createdAtOf(r['createdAt']),
                })),
                skipDuplicates: true,
            });
        }
    });
}
