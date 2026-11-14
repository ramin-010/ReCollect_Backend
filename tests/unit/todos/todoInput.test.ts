import { describe, expect, it } from 'vitest';
import {
    castCreateDate,
    normalizeRecurrence,
    normalizeReferences,
    normalizeSubtasks,
    normalizeTitle,
    parseAssigneeIds,
    parseJson,
    parseTodoPriority,
    parseTodoStatus,
    parseUpdateDate,
    resolveUploadedImages,
} from '../../../src/services/todos/todoInput';

function messageOf(fn: () => unknown): string | undefined {
    try {
        fn();
    } catch (err: any) {
        expect(err.statusCode).toBe(400);
        return err.message;
    }
    return undefined;
}

describe('parseJson (multipart fields are JSON strings)', () => {
    it('passes objects through, parses strings, falls back otherwise', () => {
        expect(parseJson([1], [])).toEqual([1]);
        expect(parseJson('["a"]', [])).toEqual(['a']);
        expect(parseJson('not json', 'fallback')).toBe('fallback');
        expect(parseJson(undefined, null)).toBeNull();
    });
});

describe('Mongoose validators, redone', () => {
    it('title: trimmed, required', () => {
        expect(normalizeTitle('  Hi  ')).toBe('Hi');
        expect(messageOf(() => normalizeTitle('   '))).toBe('Path `title` is required.');
    });

    it('status / priority enums use the Mongoose message', () => {
        expect(parseTodoStatus('in_progress')).toBe('in_progress');
        expect(parseTodoPriority('urgent')).toBe('urgent');
        expect(messageOf(() => parseTodoStatus('done'))).toBe('`done` is not a valid enum value for path `status`.');
        expect(messageOf(() => parseTodoPriority('critical'))).toBe('`critical` is not a valid enum value for path `priority`.');
    });

    it('subtasks: known keys only, isCompleted defaults to false, id/text required', () => {
        expect(normalizeSubtasks('[{"id":"a","text":"One","extra":1},{"id":"b","text":"Two","isCompleted":"true"}]')).toEqual([
            { id: 'a', text: 'One', isCompleted: false },
            { id: 'b', text: 'Two', isCompleted: true },
        ]);
        expect(normalizeSubtasks(null)).toEqual([]);
        expect(normalizeSubtasks({ not: 'an array' })).toEqual([]);
        expect(messageOf(() => normalizeSubtasks([{ text: 'no id' }]))).toBe('Path `id` is required.');
    });

    it('references: type enum, refId required (plain string), empty title dropped', () => {
        expect(normalizeReferences([{ type: 'doc', refId: 'cdoc1', title: '' }, { type: 'slide', refId: 7, title: 'Deck' }])).toEqual([
            { type: 'doc', refId: 'cdoc1' },
            { type: 'slide', refId: '7', title: 'Deck' },
        ]);
        expect(messageOf(() => normalizeReferences([{ type: 'video', refId: 'x' }]))).toBe('`video` is not a valid enum value for path `type`.');
        expect(messageOf(() => normalizeReferences([{ type: 'doc' }]))).toBe('Path `refId` is required.');
    });

    it('recurrence: pattern enum, interval defaults to 1, non-objects are null', () => {
        expect(normalizeRecurrence({ pattern: 'daily' })).toEqual({ pattern: 'daily', interval: 1 });
        expect(normalizeRecurrence('{"pattern":"monthly","interval":"3"}')).toEqual({ pattern: 'monthly', interval: 3 });
        expect(normalizeRecurrence(null)).toBeNull();
        expect(normalizeRecurrence('null')).toBeNull();
        expect(messageOf(() => normalizeRecurrence({ pattern: 'yearly' }))).toBe('`yearly` is not a valid enum value for path `pattern`.');
    });
});

describe('dates', () => {
    it('create: falsy → null, date-only → 18:00 IST that day, garbage → 400 cast message', () => {
        expect(castCreateDate(undefined, 'dueDate')).toBeNull();
        expect(castCreateDate('', 'dueDate')).toBeNull();
        expect(castCreateDate('2026-10-22', 'dueDate')?.toISOString()).toBe('2026-10-22T12:30:00.000Z');
        expect(castCreateDate('2026-10-22T03:00:00.000Z', 'dueDate')?.toISOString()).toBe('2026-10-22T03:00:00.000Z');
        expect(messageOf(() => castCreateDate('soon', 'reminderDate'))).toBe(
            'Cast to date failed for value "Invalid Date" (type Date) at path "reminderDate"'
        );
    });

    it("update: 'null'/falsy/garbage → null (the old PATCH handler)", () => {
        expect(parseUpdateDate('null')).toBeNull();
        expect(parseUpdateDate(null)).toBeNull();
        expect(parseUpdateDate('soon')).toBeNull();
        expect(parseUpdateDate('2026-10-22')?.toISOString()).toBe('2026-10-22T12:30:00.000Z');
    });
});

describe('parseAssigneeIds', () => {
    it('accepts ids, { _id } objects and JSON strings; null for non-arrays', () => {
        expect(parseAssigneeIds(['u1', { _id: 'u2' }, 'u1', '', 5])).toEqual(['u1', 'u2']);
        expect(parseAssigneeIds('["u3"]')).toEqual(['u3']);
        expect(parseAssigneeIds('u3')).toBeNull();
        expect(parseAssigneeIds(undefined)).toBeNull();
    });
});

describe('resolveUploadedImages', () => {
    const files = {
        image_abc: [{ cloudUrl: 'https://cdn.example.test/abc.webp', cloudPublicId: 'recollect-todos/abc' }],
        image_nourl: [{ cloudPublicId: 'x' }],
    };

    it('replaces the placeholders with the uploaded URLs and lists the images', () => {
        const out = resolveUploadedImages('<img src="__PENDING_UPLOAD_abc__"><img src="__PENDING_UPLOAD_abc__">', '["abc","nourl","missing"]', files);
        expect(out.description).toBe('<img src="https://cdn.example.test/abc.webp"><img src="https://cdn.example.test/abc.webp">');
        expect(out.cloudImages).toEqual([{ imageId: 'abc', cloudPublicId: 'recollect-todos/abc' }]);
    });

    it('does nothing without files, ids or a description', () => {
        expect(resolveUploadedImages('<p>x</p>', '["abc"]', undefined)).toEqual({ description: '<p>x</p>', cloudImages: [] });
        expect(resolveUploadedImages('<p>x</p>', [], files)).toEqual({ description: '<p>x</p>', cloudImages: [] });
        expect(resolveUploadedImages('', ['abc'], files)).toEqual({ description: '', cloudImages: [] });
    });

    it('treats the image id literally (no RegExp injection)', () => {
        const out = resolveUploadedImages('__PENDING_UPLOAD_a.c__ __PENDING_UPLOAD_abc__', ['a.c'], {
            'image_a.c': [{ cloudUrl: 'U', cloudPublicId: 'P' }],
        });
        expect(out.description).toBe('U __PENDING_UPLOAD_abc__');
    });
});
