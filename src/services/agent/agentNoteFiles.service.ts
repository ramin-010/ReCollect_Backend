// TOOL_ACCESS_PLAN §11 (11-27): files on a note (a note on a lesson or a subject), for chats. Any file but a video, at
// most 10 MB, 20 a note (uploads.service.ts holds the rule). Each attach and removal is an agent edit with an Undo:
// an attach's Undo takes the file off the note and out of storage; a removal keeps the stored file, so its Undo puts
// it back where it was.
//
//   POST /api/agent/notes/:id/files                 learning:write   multipart (field `file`), or JSON { name, text }
//                                                                     (≤ 1,000,000 characters) or { name, base64 } (≤ 1 MB)
//   POST /api/agent/notes/:id/files/remove          learning:write   { name } | { publicId } | { n }
//   GET  /api/agent/notes/:id/files/:n              read             a text file's text (≤ 60,000 characters), else its link
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { LearningHttpError } from '../learning/http';
import { NOTE_FILES_MAX, LEARNING_UPLOAD_MAX_BYTES, TOO_LARGE, assertAttachable, deleteStoredFiles, isTextFile, typeFromName, uploadToCloud, type UploadedAttachment } from '../learningDb/uploads.service';
import { attachedNote } from './agentNotes.service';
import { quoted, recordAgentEdit, type AgentActor } from './agentEditLog';

export const FILE_TEXT_MAX = 1_000_000;
export const FILE_BASE64_MAX = 1024 * 1024;
/** A text file's text in one answer at most. */
export const FILE_READ_MAX = 60_000;

type Json = Record<string, unknown>;
interface StoredFile {
    url: string;
    publicId: string;
    fileName: string;
    fileType: string;
    size?: number;
    resourceType?: string;
}

export const filesOf = (v: unknown): StoredFile[] => (Array.isArray(v) ? (v as StoredFile[]).filter((f) => f && typeof f === 'object' && typeof f.url === 'string') : []);

/** A note's files as agents read them: number (1-based), name, type, size. */
export const fileList = (v: unknown) => filesOf(v).map((f, i) => ({ n: i + 1, name: f.fileName, type: f.fileType, size: f.size ?? null }));

const cleanName = (name: string): string => name.replace(/[\\/]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200) || 'file';

/** What an agent sends: a file from disk (multipart), or the file's text, or its bytes as base64. */
export type FileInput = { buffer: Buffer; name: string; type: string } | { name: string; text: string } | { name: string; base64: string };

function toBuffer(input: FileInput): { buffer: Buffer; name: string; type: string } {
    if ('buffer' in input) return { buffer: input.buffer, name: cleanName(input.name), type: input.type || typeFromName(input.name) };
    const name = cleanName(input.name);
    if ('text' in input) {
        if (input.text.length > FILE_TEXT_MAX) throw new LearningHttpError(413, 'FILE_TOO_LARGE', `A file sent as text can be at most ${FILE_TEXT_MAX.toLocaleString('en')} characters.`);
        return { buffer: Buffer.from(input.text, 'utf8'), name, type: typeFromName(name) };
    }
    const buffer = Buffer.from(input.base64.replace(/^data:[^,]*,/, ''), 'base64');
    if (buffer.length > FILE_BASE64_MAX) throw new LearningHttpError(413, 'FILE_TOO_LARGE', 'A file sent as base64 can be at most 1 MB: attach a bigger one from the app.');
    if (!buffer.length) throw new LearningHttpError(400, 'EMPTY', 'The file is empty.');
    return { buffer, name, type: typeFromName(name) };
}

/** POST /api/agent/notes/:id/files → the note's files, the new one, editId. */
export async function attachFileForAgent(actor: AgentActor, noteId: string, input: FileInput) {
    const note = await attachedNote(actor.userId, noteId);
    const files = filesOf(note.attachments);
    if (files.length >= NOTE_FILES_MAX) throw new LearningHttpError(409, 'FILE_LIMIT', `A note holds at most ${NOTE_FILES_MAX} files: remove one first (remove_file).`);
    const f = toBuffer(input);
    assertAttachable(f.name, f.type);
    if (f.buffer.length > LEARNING_UPLOAD_MAX_BYTES) throw new LearningHttpError(413, 'FILE_TOO_LARGE', TOO_LARGE);
    const stored: UploadedAttachment = await uploadToCloud({ buffer: f.buffer, originalname: f.name, mimetype: f.type });
    const next = [...files, stored];
    const editId = await prisma.$transaction(async (tx) => {
        await tx.capture.update({ where: { id: noteId }, data: { attachments: next as unknown as Prisma.InputJsonValue }, select: { id: true } });
        return recordAgentEdit(actor, { kind: 'note_file_add', summary: `Attached ${quoted(f.name, 60)} to the note ${quoted(note.title ?? 'Untitled', 60)}`, entityId: noteId, docId: note.topic?.docId ?? null, undoData: { publicId: stored.publicId, resourceType: stored.resourceType ?? null } }, tx);
    });
    return { noteId, file: { n: next.length, name: stored.fileName, type: stored.fileType, size: stored.size ?? f.buffer.length }, files: fileList(next), editId };
}

/** The file a call names: its number (1-based), its name (any case), or its storage id. */
function pick(files: StoredFile[], which: { n?: number | undefined; name?: string | undefined; publicId?: string | undefined }): number {
    if (which.n !== undefined) return which.n >= 1 && which.n <= files.length ? which.n - 1 : -1;
    if (which.publicId) return files.findIndex((f) => f.publicId === which.publicId);
    const name = (which.name ?? '').trim().toLowerCase();
    return files.findIndex((f) => f.fileName.toLowerCase() === name);
}

const noSuchFile = (files: StoredFile[]) => new LearningHttpError(404, 'NOT_FOUND', files.length ? `No such file on this note. Its files: ${files.map((f, i) => `${i + 1}. ${f.fileName}`).join(', ')}.` : 'This note has no files.');

/** POST /api/agent/notes/:id/files/remove → the note's files, editId. The stored file stays while Undo can bring it back. */
export async function removeFileForAgent(actor: AgentActor, noteId: string, which: { n?: number | undefined; name?: string | undefined; publicId?: string | undefined }) {
    const note = await attachedNote(actor.userId, noteId);
    const files = filesOf(note.attachments);
    const at = pick(files, which);
    if (at < 0) throw noSuchFile(files);
    const [file] = files.splice(at, 1);
    const editId = await prisma.$transaction(async (tx) => {
        await tx.capture.update({ where: { id: noteId }, data: { attachments: files as unknown as Prisma.InputJsonValue }, select: { id: true } });
        return recordAgentEdit(actor, { kind: 'note_file_remove', summary: `Took ${quoted(file!.fileName, 60)} off the note ${quoted(note.title ?? 'Untitled', 60)}`, entityId: noteId, docId: note.topic?.docId ?? null, undoData: { file, index: at } as unknown as Prisma.InputJsonValue }, tx);
    });
    return { noteId, removed: file!.fileName, files: fileList(files), editId };
}

/** GET /api/agent/notes/:id/files/:n → a text file's text, else its name, type, size and link. */
export async function readFileForAgent(userId: string, noteId: string, which: string, fetcher: typeof fetch = fetch) {
    const note = await attachedNote(userId, noteId);
    const files = filesOf(note.attachments);
    const n = /^\d+$/.test(which) ? Number(which) : undefined;
    const at = pick(files, n !== undefined ? { n } : { name: which });
    if (at < 0) throw noSuchFile(files);
    const f = files[at]!;
    const base = { noteId, n: at + 1, name: f.fileName, type: f.fileType, size: f.size ?? null, url: f.url };
    if (!isTextFile(f.fileName, f.fileType)) return { ...base, text: null, cut: false };
    const res = await fetcher(f.url);
    if (!res.ok) throw new LearningHttpError(502, 'FILE_UNREADABLE', `The stored file did not answer (HTTP ${res.status}); its link: ${f.url}`);
    const text = await res.text();
    return { ...base, text: text.slice(0, FILE_READ_MAX), cut: text.length > FILE_READ_MAX };
}

// ─── Undo (agentEdits.service.ts) ────────────────────────────────────

/** Undo of an attach: the file comes off the note, and out of storage. */
export async function undoNoteFileAdd(userId: string, noteId: string, data: Json): Promise<void> {
    const publicId = typeof data['publicId'] === 'string' ? data['publicId'] : null;
    if (!publicId) throw new LearningHttpError(409, 'CANNOT_UNDO', 'This edit cannot be undone');
    const note = await prisma.capture.findFirst({ where: { id: noteId, userId }, select: { attachments: true } });
    const files = filesOf(note?.attachments);
    const gone = files.find((f) => f.publicId === publicId);
    if (note) await prisma.capture.update({ where: { id: noteId }, data: { attachments: files.filter((f) => f.publicId !== publicId) as unknown as Prisma.InputJsonValue } });
    deleteStoredFiles([gone ?? { publicId, resourceType: typeof data['resourceType'] === 'string' ? data['resourceType'] : undefined }]);
}

/** Undo of a removal: the file goes back on the note, where it was. */
export async function undoNoteFileRemove(userId: string, noteId: string, data: Json): Promise<void> {
    const file = data['file'] as StoredFile | undefined;
    if (!file || typeof file.url !== 'string') throw new LearningHttpError(409, 'CANNOT_UNDO', 'This edit cannot be undone');
    const note = await prisma.capture.findFirst({ where: { id: noteId, userId }, select: { attachments: true } });
    if (!note) throw new LearningHttpError(409, 'CANNOT_UNDO', 'The note is gone, so its file cannot come back');
    const files = filesOf(note.attachments);
    if (files.some((f) => f.publicId === file.publicId)) return;
    const at = typeof data['index'] === 'number' ? Math.min(Math.max(0, data['index']), files.length) : files.length;
    files.splice(at, 0, file);
    await prisma.capture.update({ where: { id: noteId }, data: { attachments: files as unknown as Prisma.InputJsonValue } });
}
