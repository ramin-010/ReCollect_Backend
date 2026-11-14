// Server-side doc schema and TipTap JSON ⇄ Yjs conversion (src/services/docs/docContent.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import {
    docJsonToYjsState,
    extractImageIdsFromYDoc,
    extractImageIdsFromYjsState,
    getDocSchema,
    replaceImageSrcs,
    yjsStateToDocJson,
} from '../../../src/services/docs/docContent';
import ErrorResponse from '../../../src/utils/errorResponse';

const text = (value: string, marks?: unknown[]) => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });

/**
 * What the frontend editor's getJSON() produces for a doc that uses every node and mark it has
 * (attributes as the editor writes them, defaults included).
 */
const everyFeatureDoc = {
    type: 'doc',
    content: [
        { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
        para(
            text('red ', [{ type: 'textStyle', attrs: { color: '#ff0000' } }]),
            text('marked', [{ type: 'highlight', attrs: { color: '#fef08a' } }, { type: 'bold' }]),
            text(' under', [{ type: 'underline' }, { type: 'italic' }, { type: 'strike' }]),
            text(' code', [{ type: 'code' }]),
            text(' link', [
                {
                    type: 'link',
                    attrs: {
                        href: 'https://example.test',
                        target: '_blank',
                        rel: 'noopener noreferrer nofollow',
                        class: 'text-blue-400 underline cursor-pointer hover:text-blue-300',
                    },
                },
            ]),
            { type: 'hardBreak' },
            text('after break')
        ),
        {
            type: 'taskList',
            content: [
                { type: 'taskItem', attrs: { checked: true }, content: [para(text('done'))] },
                {
                    type: 'taskItem',
                    attrs: { checked: false },
                    content: [
                        para(text('todo')),
                        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [para(text('nested'))] }] },
                    ],
                },
            ],
        },
        { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('bullet'))] }] },
        { type: 'orderedList', attrs: { start: 3, type: null }, content: [{ type: 'listItem', content: [para(text('third'))] }] },
        { type: 'blockquote', content: [para(text('quote'))] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;')] },
        { type: 'horizontalRule' },
        {
            type: 'resizableImage',
            attrs: {
                src: 'https://cdn.example.test/a.webp',
                alt: null,
                title: null,
                width: '50%',
                height: 'auto',
                imageId: 'img_1',
                cloudPublicId: 'recollect-docs/a',
                cloudProvider: 'cloudinary',
            },
        },
        { type: 'embed', attrs: { url: 'https://youtu.be/x', embedType: 'youtube', width: '100%' } },
        { type: 'inlineAi' },
        {
            type: 'mediaRow',
            attrs: { gap: 12 },
            content: [
                { type: 'mediaItem', attrs: { itemType: 'image', src: 'https://cdn.example.test/b.webp', url: null, embedType: 'link', width: 'auto', imageId: 'img_2' } },
                { type: 'mediaItem', attrs: { itemType: 'link', src: null, url: 'https://example.test', embedType: 'link', width: '200px', imageId: null } },
            ],
        },
    ],
};

/** Every non-null attribute in a JSON tree, as "nodeOrMarkType.attr=value" (order-free). */
function attributeFacts(json: unknown): string[] {
    const facts: string[] = [];
    const visit = (value: any) => {
        if (!value || typeof value !== 'object') return;
        for (const [k, v] of Object.entries(value.attrs ?? {})) if (v !== null) facts.push(`${value.type}.${k}=${JSON.stringify(v)}`);
        for (const mark of value.marks ?? []) {
            facts.push(`mark:${mark.type}`);
            for (const [k, v] of Object.entries(mark.attrs ?? {})) if (v !== null) facts.push(`${mark.type}.${k}=${JSON.stringify(v)}`);
        }
        if (value.type === 'text') facts.push(`text=${value.text}`);
        (value.content ?? []).forEach(visit);
    };
    visit(json);
    return facts.sort();
}

describe('server doc schema', () => {
    it('has every node and mark the frontend editor can produce', () => {
        const schema = getDocSchema();
        for (const node of [
            'doc', 'paragraph', 'text', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem',
            'codeBlock', 'hardBreak', 'horizontalRule', 'taskList', 'taskItem', 'resizableImage', 'image',
            'embed', 'inlineAi', 'mediaRow', 'mediaItem', 'callout', 'details', 'detailsSummary', 'detailsContent',
        ]) {
            expect(schema.nodes[node], `node ${node}`).toBeDefined();
        }
        for (const mark of ['bold', 'italic', 'strike', 'code', 'link', 'underline', 'highlight', 'textStyle']) {
            expect(schema.marks[mark], `mark ${mark}`).toBeDefined();
        }
    });

    it('declares the attributes the editor writes', () => {
        const schema = getDocSchema();
        const attrs = (type: { spec: { attrs?: Record<string, unknown> | undefined } }) => Object.keys(type.spec.attrs ?? {}).sort();
        expect(attrs(schema.marks.textStyle!)).toEqual(['color']);
        expect(attrs(schema.marks.highlight!)).toEqual(['color']);
        expect(attrs(schema.marks.link!)).toEqual(expect.arrayContaining(['href', 'target', 'rel', 'class']));
        expect(attrs(schema.nodes.taskItem!)).toEqual(['checked']);
        expect(attrs(schema.nodes.resizableImage!)).toEqual(
            ['alt', 'cloudProvider', 'cloudPublicId', 'height', 'imageId', 'src', 'title', 'width'].sort()
        );
        expect(attrs(schema.nodes.mediaItem!)).toEqual(['embedType', 'imageId', 'itemType', 'src', 'url', 'width']);
        expect(attrs(schema.nodes.embed!)).toEqual(['embedType', 'url', 'width']);
        expect(attrs(schema.nodes.mediaRow!)).toEqual(['gap']);
        expect(attrs(schema.nodes.orderedList!)).toEqual(['start', 'type']);
    });
});

describe('docJsonToYjsState', () => {
    afterEach(() => vi.restoreAllMocks());

    it('converts textStyle, highlight and task lists (the old "no mark type textStyle" 500)', () => {
        const doc = {
            type: 'doc',
            content: [
                para(text('red', [{ type: 'textStyle', attrs: { color: '#ff0000' } }]), text(' hl', [{ type: 'highlight', attrs: { color: '#00ff00' } }])),
                { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [para(text('done'))] }] },
            ],
        };
        const back = yjsStateToDocJson(docJsonToYjsState(doc)) as any;
        expect(back.content[0].content[0].marks).toEqual([{ type: 'textStyle', attrs: { color: '#ff0000' } }]);
        expect(back.content[0].content[1].marks).toEqual([{ type: 'highlight', attrs: { color: '#00ff00' } }]);
        expect(back.content[1]).toMatchObject({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true } }] });
    });

    it('keeps every node, mark and attribute of a doc using all editor features', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const back = yjsStateToDocJson(docJsonToYjsState(everyFeatureDoc));

        expect(attributeFacts(back)).toEqual(attributeFacts(everyFeatureDoc));
        const schema = getDocSchema();
        expect(schema.nodeFromJSON(back).eq(schema.nodeFromJSON(everyFeatureDoc))).toBe(true);
        expect(warn).not.toHaveBeenCalled(); // nothing needed the safety net
    });

    it('produces the same Yjs content as the browser converter for the same JSON', () => {
        // The browser encodes with prosemirrorJSONToYDoc + its own schema; the result must decode identically.
        const fromServer = yjsStateToDocJson(docJsonToYjsState(everyFeatureDoc));
        const browserDoc = prosemirrorJSONToYDoc(getDocSchema(), everyFeatureDoc, 'default');
        const fromBrowser = yjsStateToDocJson(Buffer.from(Y.encodeStateAsUpdate(browserDoc)).toString('base64'));
        expect(fromServer).toEqual(fromBrowser);
    });

    it('keeps node types, mark types and attributes the server schema does not know (and warns)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const doc = {
            type: 'doc',
            content: [
                { type: 'paragraph', attrs: { textAlign: 'center' }, content: [text('x', [{ type: 'comment', attrs: { threadId: 't1' } }])] },
                // A node the editor may get later (Phase E columns); `callout` is a real node now.
                { type: 'columnList', attrs: { tone: 'warning' }, content: [para(text('inside'))] },
                para(text('y', [{ type: 'textStyle', attrs: { color: '#123456', fontSize: '18px' } }])),
            ],
        };
        const back = yjsStateToDocJson(docJsonToYjsState(doc)) as any;

        expect(back.content[0]).toMatchObject({ type: 'paragraph', attrs: { textAlign: 'center' } });
        expect(back.content[0].content[0].marks).toEqual([{ type: 'comment', attrs: { threadId: 't1' } }]);
        expect(back.content[1]).toMatchObject({ type: 'columnList', attrs: { tone: 'warning' }, content: [{ type: 'paragraph' }] });
        expect(back.content[2].content[0].marks).toEqual([{ type: 'textStyle', attrs: { color: '#123456', fontSize: '18px' } }]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/columnList/);
        // The shared schema itself is not modified.
        expect(getDocSchema().nodes.columnList).toBeUndefined();
    });

    it('converts an empty doc', () => {
        expect(yjsStateToDocJson(docJsonToYjsState({ type: 'doc', content: [] }))).toEqual({ type: 'doc', content: [] });
    });

    it('rejects malformed content with a 400 ErrorResponse', () => {
        for (const bad of [{}, { type: 'doc', content: [{ type: 'text', text: '' }] }, { type: 'doc', content: 'nope' }]) {
            let caught: unknown;
            try {
                docJsonToYjsState(bad);
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(ErrorResponse);
            expect((caught as ErrorResponse).statusCode).toBe(400);
            expect((caught as ErrorResponse).message).toMatch(/^Invalid doc content: /);
        }
    });
});

describe('image helpers', () => {
    it('replaceImageSrcs points uploaded image nodes at their cloud URL', () => {
        const doc: any = {
            type: 'doc',
            content: [
                { type: 'resizableImage', attrs: { src: 'blob:1', imageId: 'a' } },
                { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'blob:2', imageId: 'b' } }] },
                { type: 'resizableImage', attrs: { src: 'blob:3', imageId: 'not-uploaded' } },
                { type: 'mediaItem', attrs: { src: 'blob:4', imageId: 'a' } },
                { type: 'resizableImage', attrs: { src: 'blob:5', imageId: '__proto__' } },
            ],
        };
        replaceImageSrcs(doc, { a: { url: 'https://cdn/a' }, b: { url: 'https://cdn/b' } });
        expect(doc.content[0].attrs.src).toBe('https://cdn/a');
        expect(doc.content[1].content[0].attrs.src).toBe('https://cdn/b');
        expect(doc.content[2].attrs.src).toBe('blob:3');
        expect(doc.content[3].attrs.src).toBe('blob:4'); // only image nodes are tracked, as before
        expect(doc.content[4].attrs.src).toBe('blob:5');
    });

    it('extracts the image ids a Yjs state still uses', () => {
        const state = docJsonToYjsState(everyFeatureDoc);
        expect(extractImageIdsFromYjsState(state)).toEqual(['img_1']);

        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, Buffer.from(state, 'base64'));
        expect(extractImageIdsFromYDoc(ydoc)).toEqual(['img_1']);
        ydoc.destroy();
    });

    it('returns null (not "no images") for a state it cannot read', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(extractImageIdsFromYjsState(Buffer.from([0xff, 0xff, 0xff, 0x01]).toString('base64'))).toBeNull();
        vi.restoreAllMocks();
    });
});
