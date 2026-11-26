// POST /api/learning/uploads (LEARNING_SPEC §2 #21): one file (field `file`) kept in memory by multer, then sent to
// Cloudinary with resource_type 'auto'. Returns the attachment shape stored on captures and quick notes.
// TOOL_ACCESS_PLAN §11.2 (11-27): the one rule every upload door uses (the composer, the pocket, the note's edit
// dialog, the notes panel, the agent route): any file except videos (a link is the way to keep a video), at most
// 10 MB a file (Cloudinary's limit for files that are not images), 20 a note. The attachment keeps its size and the
// storage's resource type (a file that is not an image is stored as `raw`, and is deleted as one).
import multer from 'multer';
import type { RequestHandler } from 'express';
import cloudinary, { batchDeleteFromCloud } from '../../utils/cloudinary';
import { LearningHttpError } from '../learning/http';

export const LEARNING_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const NOTE_FILES_MAX = 20;
export const LEARNING_UPLOAD_FOLDER = 'recollect-learning';
export const VIDEO_REFUSED = "Videos can't be attached. Save the link instead.";
export const TOO_LARGE = 'Files can be at most 10 MB';

export interface UploadedAttachment {
    url: string;
    publicId: string;
    fileName: string;
    fileType: string;
    /** Bytes (attachments from before 11-27 have none). */
    size?: number;
    /** Cloudinary's resource type: image, raw, video (older attachments: none; see resourceTypeOf). */
    resourceType?: string;
}

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|wmv|m4v|flv|mpg|mpeg|3gp)$/i;

/** Any file but a video: by its type, or by its name whatever type it claims. */
export function assertAttachable(name: string, type: string): void {
    if (/^video\//i.test(type) || VIDEO_EXT.test(name.trim())) throw new LearningHttpError(400, 'VIDEO_NOT_ALLOWED', VIDEO_REFUSED);
}

const extOf = (name: string): string => /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? '';

/** Files read as text (the agents' read_note_file answers their text). */
const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sql', 'log', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'cs', 'sh', 'ps1', 'toml', 'ini', 'env', 'conf']);
const TYPES: Readonly<Record<string, string>> = {
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    json: 'application/json',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    xml: 'application/xml',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    zip: 'application/zip',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** A file's type from its name (a small table; anything else is octet-stream, text-like names text/plain). */
export function typeFromName(name: string): string {
    const ext = extOf(name);
    return TYPES[ext] ?? (TEXT_EXT.has(ext) ? 'text/plain' : 'application/octet-stream');
}

/** Read as text: a text type, JSON, YAML or XML itself (not an Office file, whose type names "openxml"), or a text name. */
export const isTextFile = (name: string, type: string): boolean =>
    /^text\//i.test(type) || /^application\/(json|x-?yaml|yaml|xml)$/i.test(type) || /\+(json|xml)$/i.test(type) || TEXT_EXT.has(extOf(name));

const parseFile = multer({ storage: multer.memoryStorage(), limits: { fileSize: LEARNING_UPLOAD_MAX_BYTES, files: 1 } }).single('file');

/** multer, with its errors turned into 413 (too large) / 400 (anything else); a video is refused here too. */
export const learningUploadMiddleware: RequestHandler = (req, res, next) => {
    parseFile(req, res, (err: unknown) => {
        if (err) {
            const code = (err as { code?: string }).code;
            if (code === 'LIMIT_FILE_SIZE') return next(new LearningHttpError(413, 'FILE_TOO_LARGE', TOO_LARGE));
            return next(new LearningHttpError(400, 'INVALID_UPLOAD', (err as Error).message || 'Upload failed'));
        }
        const file = (req as { file?: { originalname: string; mimetype: string } }).file;
        try {
            if (file) assertAttachable(file.originalname, file.mimetype);
        } catch (refused) {
            return next(refused);
        }
        return next();
    });
};

export const NOT_SERVED = "PDF and ZIP files can't be attached yet: the file store doesn't serve them. Other files work.";
const PDF_ZIP = (name: string, type: string) => /\.(pdf|zip)$/i.test(name.trim()) || /^application\/(pdf|zip|x-zip-compressed)$/i.test(type);
/** Whether the store serves PDF and ZIP files (a Cloudinary account setting, off on new accounts): checked, then kept an hour. */
let pdfZipServed: { ok: boolean; at: number } | null = null;

/**
 * TOOL_ACCESS_PLAN §11.6 (11-27): a file the store won't serve is refused at upload with a plain message, never stored
 * unreadable. Cloudinary holds back PDF and ZIP delivery until its owner allows it (Settings › Security, "Allow
 * delivery of PDF and ZIP files"): such a file is checked once it is stored, and taken out again when it answers 401.
 */
async function assertServed(stored: UploadedAttachment, name: string, type: string, fetcher: typeof fetch = fetch): Promise<void> {
    if (!PDF_ZIP(name, type)) return;
    if (pdfZipServed && Date.now() - pdfZipServed.at < 3600_000) {
        if (pdfZipServed.ok) return;
    } else {
        const res = await fetcher(stored.url, { method: 'HEAD' }).catch(() => null);
        pdfZipServed = { ok: !!res && res.status !== 401 && res.status !== 403, at: Date.now() };
        if (pdfZipServed.ok) return;
        console.warn('[uploads] the file store refuses PDF and ZIP delivery: allow it in Cloudinary (Settings › Security) to attach them');
    }
    deleteStoredFiles([stored]);
    throw new LearningHttpError(415, 'TYPE_NOT_SERVED', NOT_SERVED);
}

/** Streams the buffer to Cloudinary; the stored name keeps the file's own (and a non-image its extension). */
export async function uploadToCloud(file: { buffer: Buffer; originalname: string; mimetype: string }): Promise<UploadedAttachment> {
    const stored = await storeInCloud(file);
    await assertServed(stored, file.originalname, file.mimetype);
    return stored;
}

function storeInCloud(file: { buffer: Buffer; originalname: string; mimetype: string }): Promise<UploadedAttachment> {
    assertAttachable(file.originalname, file.mimetype);
    if (file.buffer.length > LEARNING_UPLOAD_MAX_BYTES) return Promise.reject(new LearningHttpError(413, 'FILE_TOO_LARGE', TOO_LARGE));
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { resource_type: 'auto', folder: LEARNING_UPLOAD_FOLDER, use_filename: true, unique_filename: true, filename_override: file.originalname },
            (err: unknown, result: { secure_url?: string; url?: string; public_id?: string; resource_type?: string; bytes?: number } | undefined) => {
                if (err || !result?.public_id) return reject(err ?? new Error('Cloudinary returned no file'));
                resolve({
                    url: result.secure_url ?? result.url ?? '',
                    publicId: result.public_id,
                    fileName: file.originalname,
                    fileType: file.mimetype,
                    size: result.bytes ?? file.buffer.length,
                    ...(result.resource_type ? { resourceType: result.resource_type } : {}),
                });
            }
        );
        stream.end(file.buffer);
    });
}

type StoredFile = { publicId?: unknown; resourceType?: unknown; fileType?: unknown };

/** The storage's resource type of a file (older attachments: a public id with an extension is raw, else an image). */
export function resourceTypeOf(f: StoredFile): string {
    if (typeof f.resourceType === 'string' && f.resourceType) return f.resourceType;
    if (typeof f.fileType === 'string' && /^video\//i.test(f.fileType)) return 'video';
    return /\.[a-z0-9]{1,8}$/i.test(String(f.publicId ?? '')) ? 'raw' : 'image';
}

/** Deletes stored files, each as its own resource type; failures are logged, never thrown. */
export function deleteStoredFiles(files: readonly StoredFile[]): void {
    const byType = new Map<string, string[]>();
    for (const f of files) {
        if (typeof f.publicId !== 'string' || !f.publicId) continue;
        const t = resourceTypeOf(f);
        byType.set(t, [...(byType.get(t) ?? []), f.publicId]);
    }
    for (const [type, ids] of byType) {
        const run = type === 'image' ? batchDeleteFromCloud(ids) : Promise.all(ids.map((id) => new Promise<void>((resolve) => cloudinary.uploader.destroy(id, { resource_type: type, invalidate: true }, () => resolve()))));
        void Promise.resolve(run).catch((err) => console.error('[uploads] Cloudinary cleanup failed:', err));
    }
}
