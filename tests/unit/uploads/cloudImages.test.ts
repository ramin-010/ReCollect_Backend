import { describe, expect, it } from 'vitest';
import { collectUploadedImages, partitionCloudImages, publicIdsByType, readCloudImages } from '../../../src/services/uploads/cloudImages';
import { parseJsonField, readOptionalBoolean, readOptionalString, readStringList } from '../../../src/utils/requestFields';

describe('readCloudImages', () => {
    it('reads valid entries and skips the rest', () => {
        expect(
            readCloudImages([
                { imageId: 'a', cloudUrl: 'https://cdn/a', cloudPublicId: 'p/a', _id: 'legacy-subdoc-id' },
                { imageId: 'b', cloudPublicId: 'p/b' },
                { imageId: 3, cloudUrl: 'x', cloudPublicId: 'p/c' },
                null,
                'junk',
            ])
        ).toEqual([
            { imageId: 'a', cloudUrl: 'https://cdn/a', cloudPublicId: 'p/a' },
            { imageId: 'b', cloudUrl: '', cloudPublicId: 'p/b' },
        ]);
        expect(readCloudImages(null)).toEqual([]);
        expect(readCloudImages({ imageId: 'a' })).toEqual([]);
    });
});

describe('collectUploadedImages', () => {
    it('maps image ids to the files upfly uploaded as image_<id>', () => {
        const files = {
            image_a: [{ cloudUrl: 'https://cdn/a', cloudPublicId: 'p/a' }],
            image_b: [{ cloudUrl: undefined, cloudPublicId: 'p/b' }], // failed upload
            other: [{ cloudUrl: 'https://cdn/x', cloudPublicId: 'p/x' }],
        };
        expect(collectUploadedImages(files, ['a', 'b', 'missing', 'a'])).toEqual({
            imageUrlMap: { a: { url: 'https://cdn/a', publicId: 'p/a' } },
            uploaded: [{ imageId: 'a', cloudUrl: 'https://cdn/a', cloudPublicId: 'p/a' }],
        });
        expect(collectUploadedImages(undefined, ['a'])).toEqual({ imageUrlMap: {}, uploaded: [] });
    });
});

describe('partitionCloudImages', () => {
    it('keeps the images still in use and returns the orphans', () => {
        const a = { imageId: 'a', cloudUrl: '', cloudPublicId: 'p/a' };
        const b = { imageId: 'b', cloudUrl: '', cloudPublicId: 'p/b' };
        expect(partitionCloudImages([a, b], ['b', 'zzz'])).toEqual({ retain: [b], orphaned: [a] });
        expect(partitionCloudImages([a, b], new Set<string>())).toEqual({ retain: [], orphaned: [a, b] });
    });

    it('keeps an image the new editor uses by its URL (its blocks carry no imageId)', () => {
        const a = { imageId: 'img_a', cloudUrl: 'https://cdn/a.webp', cloudPublicId: 'p/a' };
        const b = { imageId: 'img_b', cloudUrl: '', cloudPublicId: 'p/b' };
        expect(partitionCloudImages([a, b], ['https://cdn/a.webp'])).toEqual({ retain: [a], orphaned: [b] });
        // An empty URL never matches an empty key.
        expect(partitionCloudImages([b], [''])).toEqual({ retain: [], orphaned: [b] });
    });

    it("11-27: a file's URL counts however it is encoded (a Markdown link writes spaces and parentheses encoded)", () => {
        const f = { imageId: 'p/f', cloudUrl: 'https://cdn/raw/rate limits (q3).xlsx', cloudPublicId: 'p/f', resourceType: 'raw' };
        expect(partitionCloudImages([f], ['https://cdn/raw/rate%20limits%20(q3).xlsx'])).toEqual({ retain: [f], orphaned: [] });
        // The Markdown printer's form (linkUrl encodes the parentheses too).
        expect(partitionCloudImages([f], ['https://cdn/raw/rate%20limits%20%28q3%29.xlsx']).retain).toEqual([f]);
        expect(partitionCloudImages([f], ['https://cdn/raw/other.xlsx']).orphaned).toEqual([f]);
        // A malformed escape is compared as it is (never throws).
        expect(partitionCloudImages([{ ...f, cloudUrl: 'https://cdn/raw/100%.csv' }], ['https://cdn/raw/100%.csv']).retain).toHaveLength(1);
    });
});

describe('readCloudImages / publicIdsByType (11-27: files in docs)', () => {
    it("keeps an entry's kind, and groups the public ids by it: images first, one call each", () => {
        expect(readCloudImages([{ imageId: 'p/f', cloudUrl: 'u', cloudPublicId: 'p/f', resourceType: 'raw' }, { imageId: 'x', cloudPublicId: 'p/x', resourceType: 5 }])).toEqual([
            { imageId: 'p/f', cloudUrl: 'u', cloudPublicId: 'p/f', resourceType: 'raw' },
            { imageId: 'x', cloudUrl: '', cloudPublicId: 'p/x' },
        ]);
        const img = (id: string) => ({ imageId: id, cloudUrl: '', cloudPublicId: `p/${id}` });
        expect(publicIdsByType([{ ...img('f'), resourceType: 'raw' }, img('a'), { ...img('v'), resourceType: 'video' }, img('b'), { ...img('g'), resourceType: 'raw' }])).toEqual([
            ['image', ['p/a', 'p/b']],
            ['raw', ['p/f', 'p/g']],
            ['video', ['p/v']],
        ]);
        expect(publicIdsByType([])).toEqual([]);
    });
});

describe('request field readers', () => {
    it('parseJsonField / readStringList accept JSON values and multipart strings', () => {
        expect(parseJsonField('{"type":"doc"}', null)).toEqual({ type: 'doc' });
        expect(parseJsonField({ type: 'doc' }, null)).toEqual({ type: 'doc' });
        expect(parseJsonField('not json', null)).toBeNull();
        expect(parseJsonField(5, null)).toBeNull();
        expect(readStringList('["a","b",3]')).toEqual(['a', 'b']);
        expect(readStringList(['x'])).toEqual(['x']);
        expect(readStringList(undefined)).toEqual([]);
        expect(readStringList('{"a":1}')).toEqual([]);
    });

    it('readOptionalString casts like Mongoose and rejects objects', () => {
        expect(readOptionalString(undefined, 'title')).toBeUndefined();
        expect(readOptionalString(null, 'title')).toBeNull();
        expect(readOptionalString('x', 'title')).toBe('x');
        expect(readOptionalString(12, 'title')).toBe('12');
        expect(() => readOptionalString({ a: 1 }, 'title')).toThrow('Cast to string failed for value "{"a":1}" at path "title"');
    });

    it('readOptionalBoolean casts like Mongoose', () => {
        expect(readOptionalBoolean(undefined, 'isPinned')).toBeUndefined();
        expect(readOptionalBoolean(true, 'isPinned')).toBe(true);
        expect(readOptionalBoolean('false', 'isPinned')).toBe(false);
        expect(readOptionalBoolean(1, 'isPinned')).toBe(true);
        expect(() => readOptionalBoolean('maybe', 'isPinned')).toThrow('Cast to Boolean failed');
        expect(() => readOptionalBoolean(null, 'isPinned')).toThrow('Cast to Boolean failed');
    });
});
