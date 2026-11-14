// Request-body parsing for todos: what the old controllers did by hand plus what the Mongoose
// schema did implicitly (trim, enum and required validators, casting, dropping unknown keys of the
// subtask/reference/recurrence subdocuments). Error messages are the Mongoose ones the old error
// handler sent ("Path `title` is required.", "`x` is not a valid enum value for path `status`.").
//
// The bodies arrive either as JSON or as multipart form fields (when the description has images),
// in which case arrays/objects are JSON strings: parseJson() accepts both, as before.
import type { GoalType, TodoPriority, TodoStatus, TodoVisibility } from '@prisma/client';
import ErrorResponse from '../../utils/errorResponse';
import { parseClientDate } from '../../utils/timezone';

export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'review', 'blocked', 'complete'];
export const TODO_PRIORITIES: readonly TodoPriority[] = ['low', 'normal', 'medium', 'high', 'urgent'];
export const TODO_VISIBILITIES: readonly TodoVisibility[] = ['private', 'shared', 'workspace'];
/** Revise weekly / monthly goals (learning Home). */
export const GOAL_TYPES: readonly GoalType[] = ['NONE', 'WEEKLY', 'MONTHLY'];
export const TASK_REFERENCE_TYPES = ['doc', 'content', 'slide'] as const;
export const RECURRENCE_PATTERNS = ['daily', 'weekly', 'monthly'] as const;

export type TaskReferenceType = (typeof TASK_REFERENCE_TYPES)[number];
export type RecurrencePattern = (typeof RECURRENCE_PATTERNS)[number];

// Type aliases (not interfaces) so they are assignable to Prisma.InputJsonValue.

/** Todo.subtasks[] element. */
export type SubtaskJson = {
    id: string;
    text: string;
    isCompleted: boolean;
};

/** Todo.references[] element. `title` is left out when empty (Mongoose dropped undefined). */
export type TaskReferenceJson = {
    type: TaskReferenceType;
    refId: string;
    title?: string;
};

/** Todo.recurrence. */
export type RecurrenceJson = {
    pattern: RecurrencePattern;
    interval: number;
};

/** Todo.cloudImages[] element. */
export type TodoCloudImageJson = {
    imageId: string;
    cloudPublicId: string;
};

/** The old controllers' parseJson: objects pass through, strings are JSON.parse'd, else fallback. */
export function parseJson<T>(data: unknown, fallback: T): T {
    try {
        if (typeof data === 'object' && data !== null) return data as T;
        if (typeof data === 'string') return JSON.parse(data) as T;
        return fallback;
    } catch {
        return fallback;
    }
}

function enumMessage(value: unknown, path: string): string {
    return `\`${String(value)}\` is not a valid enum value for path \`${path}\`.`;
}

function requiredMessage(path: string): string {
    return `Path \`${path}\` is required.`;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
    return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function asString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    return String(value);
}

/** Mongoose String cast + trim + required (create and update). */
export function normalizeTitle(value: unknown): string {
    const title = asString(value).trim();
    if (!title) throw new ErrorResponse(400, requiredMessage('title'));
    return title;
}

export function parseTodoStatus(value: unknown): TodoStatus {
    if (!isOneOf(TODO_STATUSES, value)) throw new ErrorResponse(400, enumMessage(value, 'status'));
    return value;
}

export function parseTodoPriority(value: unknown): TodoPriority {
    if (!isOneOf(TODO_PRIORITIES, value)) throw new ErrorResponse(400, enumMessage(value, 'priority'));
    return value;
}

/** goalType: NONE | WEEKLY | MONTHLY; empty / null → NONE. */
export function parseGoalType(value: unknown): GoalType {
    if (value === undefined || value === null || value === '') return 'NONE';
    if (!isOneOf(GOAL_TYPES, value)) throw new ErrorResponse(400, enumMessage(value, 'goalType'));
    return value;
}

export function parseTodoVisibility(value: unknown): TodoVisibility {
    if (!isOneOf(TODO_VISIBILITIES, value)) throw new ErrorResponse(400, enumMessage(value, 'visibility'));
    return value;
}

function looseBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
    return false;
}

/**
 * Subtasks: an array of { id, text, isCompleted } (anything else → []). id and text are required
 * (Mongoose validators), isCompleted defaults to false, unknown keys are dropped.
 */
export function normalizeSubtasks(value: unknown): SubtaskJson[] {
    const parsed = parseJson<unknown>(value, []);
    if (!Array.isArray(parsed)) return [];
    const errors: string[] = [];
    const out: SubtaskJson[] = [];
    for (const item of parsed) {
        const raw = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        const id = asString(raw.id);
        const text = asString(raw.text);
        if (!id) errors.push(requiredMessage('id'));
        if (!text) errors.push(requiredMessage('text'));
        out.push({ id, text, isCompleted: raw.isCompleted === undefined ? false : looseBoolean(raw.isCompleted) });
    }
    if (errors.length > 0) throw new ErrorResponse(400, errors.join(', '));
    return out;
}

/**
 * References: an array of { type, refId, title? } (anything else → []). type must be doc/content/slide,
 * refId is required and stored as a plain string; title is kept only when non-empty.
 */
export function normalizeReferences(value: unknown): TaskReferenceJson[] {
    const parsed = parseJson<unknown>(value, []);
    if (!Array.isArray(parsed)) return [];
    const errors: string[] = [];
    const out: TaskReferenceJson[] = [];
    for (const item of parsed) {
        const raw = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        const refId = asString(raw.refId);
        if (raw.type === undefined || raw.type === null || raw.type === '') {
            errors.push(requiredMessage('type'));
        } else if (!isOneOf(TASK_REFERENCE_TYPES, raw.type)) {
            errors.push(enumMessage(raw.type, 'type'));
        }
        if (!refId) errors.push(requiredMessage('refId'));
        if (errors.length > 0) continue;
        const ref: TaskReferenceJson = { type: raw.type as TaskReferenceType, refId };
        if (raw.title) ref.title = asString(raw.title);
        out.push(ref);
    }
    if (errors.length > 0) throw new ErrorResponse(400, errors.join(', '));
    return out;
}

/** Recurrence: { pattern, interval = 1 } or null. Non-objects (and null) → null. */
export function normalizeRecurrence(value: unknown): RecurrenceJson | null {
    const parsed = parseJson<unknown>(value, null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    if (raw.pattern === undefined || raw.pattern === null || raw.pattern === '') {
        throw new ErrorResponse(400, requiredMessage('pattern'));
    }
    if (!isOneOf(RECURRENCE_PATTERNS, raw.pattern)) throw new ErrorResponse(400, enumMessage(raw.pattern, 'pattern'));
    let interval = 1;
    if (raw.interval !== undefined && raw.interval !== null && raw.interval !== '') {
        interval = Number(raw.interval);
        if (!Number.isFinite(interval)) {
            throw new ErrorResponse(400, `Cast to Number failed for value "${asString(raw.interval)}" (type ${typeof raw.interval}) at path "interval"`);
        }
    }
    return { pattern: raw.pattern, interval };
}

/** A string list from a JSON array (or a JSON string of one); anything else → []. */
export function parseStringList(value: unknown): unknown[] {
    const parsed = parseJson<unknown>(value, []);
    return Array.isArray(parsed) ? parsed : [];
}

/**
 * Assignee ids from a body value: an array (or JSON string of one) of ids or of `{ _id }` objects.
 * Returns null when the value is not an array (callers decide what that means).
 */
export function parseAssigneeIds(value: unknown): string[] | null {
    const parsed = parseJson<unknown>(value, null);
    if (!Array.isArray(parsed)) return null;
    const ids: string[] = [];
    for (const item of parsed) {
        const id = item && typeof item === 'object' ? (item as Record<string, unknown>)._id : item;
        if (typeof id === 'string' && id.trim()) ids.push(id.trim());
    }
    return [...new Set(ids)];
}

/**
 * Create semantics (old `dueDate ? new Date(dueDate) : null`): falsy → null; a date-only string is
 * the user's local day (see utils/timezone); an unparsable value is a 400 with Mongoose's cast message.
 */
export function castCreateDate(value: unknown, path: 'dueDate' | 'reminderDate'): Date | null {
    if (!value) return null;
    const date = parseClientDate(value);
    if (Number.isNaN(date.getTime())) {
        throw new ErrorResponse(400, `Cast to date failed for value "Invalid Date" (type Date) at path "${path}"`);
    }
    return date;
}

/** Update semantics (old PATCH handlers): falsy or 'null' → null; an unparsable value → null. */
export function parseUpdateDate(value: unknown): Date | null {
    if (value === 'null' || !value) return null;
    const date = parseClientDate(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

// ─── Images (upfly multipart uploads) ───────────────────────────────────

/** What upfly puts on each uploaded file. */
interface CloudFile {
    cloudUrl?: string;
    cloudPublicId?: string;
}

export interface ResolvedImages {
    description: string;
    cloudImages: TodoCloudImageJson[];
}

/**
 * Replace `__PENDING_UPLOAD_<imageId>__` placeholders in the description with the uploaded URLs
 * (fields `image_<imageId>`), and list the uploaded images for later deletion. Same rules as the
 * old controllers: only when there are files, image ids and a description.
 */
export function resolveUploadedImages(description: string, imageNodeIds: unknown, files: unknown): ResolvedImages {
    const ids = parseStringList(imageNodeIds).map((id) => asString(id)).filter(Boolean);
    const cloudImages: TodoCloudImageJson[] = [];
    if (!files || typeof files !== 'object' || ids.length === 0 || !description) {
        return { description, cloudImages };
    }
    let result = description;
    for (const imageId of ids) {
        const fileArray = (files as Record<string, CloudFile[] | undefined>)[`image_${imageId}`];
        const file = Array.isArray(fileArray) ? fileArray[0] : undefined;
        if (file?.cloudUrl && file.cloudPublicId) {
            cloudImages.push({ imageId, cloudPublicId: file.cloudPublicId });
            result = result.split(`__PENDING_UPLOAD_${imageId}__`).join(file.cloudUrl);
        }
    }
    return { description: result, cloudImages };
}
