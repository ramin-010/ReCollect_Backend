// Stored-doc repairs (src/services/docs/docRepair.ts): side-by-side columns are gone, so a stored
// columns row becomes its blocks; list items left outside a list (the drag bug) go back in one;
// and content that breaks the schema is refused before it is stored.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { JSONContent } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { docProblem, repairDoc, repairLegacyBlocks } from '../../../src/services/docs/docRepair';
import { docJsonToYjsState, getDocSchema, yjsStateToDocJson } from '../../../src/services/docs/docContent';
import { docJsonToMarkdown } from '../../../src/services/docs/markdown/docMarkdown';
import { transactCapturing, undoChangeOn } from '../../../src/services/agent/yjsChanges';
import ErrorResponse from '../../../src/utils/errorResponse';

type YBlock = Y.XmlElement | Y.XmlText;

const el = (name: string, attrs: Record<string, unknown> = {}, children: YBlock[] = []): Y.XmlElement => {
    const e = new Y.XmlElement(name);
    for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value as string);
    if (children.length > 0) e.insert(0, children);
    return e;
};
const txt = (value: string): Y.XmlText => {
    const t = new Y.XmlText();
    t.insert(0, value);
    return t;
};
const p = (value?: string): Y.XmlElement => el('paragraph', {}, value ? [txt(value)] : []);

function docWith(...blocks: YBlock[]): Y.Doc {
    const doc = new Y.Doc();
    doc.getXmlFragment('default').insert(0, blocks);
    return doc;
}

const json = (doc: Y.Doc): JSONContent => yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')) as JSONContent;
const types = (doc: Y.Doc): string[] => (json(doc).content ?? []).map((b) => b.type ?? '');
const valid = (doc: Y.Doc): boolean => {
    getDocSchema().nodeFromJSON(json(doc)).check();
    return true;
};
const state = (doc: Y.Doc): string => Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');

describe('the schema', () => {
    it('has no side-by-side columns any more', () => {
        expect(getDocSchema().nodes['columns']).toBeUndefined();
        expect(getDocSchema().nodes['column']).toBeUndefined();
    });
});

describe('repairLegacyBlocks: columns', () => {
    it('turns a columns row into its blocks, left to right, and drops a column that only held an empty line', () => {
        const doc = docWith(
            p('Before'),
            el('columns', {}, [
                el('column', { width: 1.4 }, [el('heading', { level: 2 }, [txt('Left')]), p('Left side')]),
                el('column', {}, [p()]),
                el('column', { width: 0.6 }, [p('Right side')]),
            ]),
            p('After')
        );
        expect(repairDoc(doc)).toBe(1);
        expect(json(doc)).toEqual({
            type: 'doc',
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Left' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Left side' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Right side' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
            ],
        });
        expect(valid(doc)).toBe(true);
    });

    it('keeps formatting, images and nested blocks inside a column', () => {
        const bold = new Y.XmlText();
        bold.insert(0, 'strong', { bold: {} });
        const doc = docWith(
            el('columns', {}, [
                el('column', {}, [el('paragraph', {}, [bold])]),
                el('column', {}, [el('resizableImage', { src: 'https://x.test/a.png', imageId: 'img_1' }), el('bulletList', {}, [el('listItem', {}, [p('one')])])]),
            ])
        );
        repairDoc(doc);
        expect(types(doc)).toEqual(['paragraph', 'resizableImage', 'bulletList']);
        expect(json(doc).content?.[0]?.content?.[0]).toEqual({ type: 'text', text: 'strong', marks: [{ type: 'bold', attrs: {} }] });
        expect(json(doc).content?.[1]?.attrs).toMatchObject({ src: 'https://x.test/a.png', imageId: 'img_1' });
        expect(valid(doc)).toBe(true);
    });

    it('flattens rows nested in a callout, and gives a callout left empty an empty line', () => {
        const doc = docWith(
            el('callout', { kind: 'tip' }, [el('columns', {}, [el('column', {}, [p('A')]), el('column', {}, [p('B')])])]),
            el('callout', { kind: 'note' }, [el('columns', {}, [el('column', {}, [p()]), el('column', {}, [p()])])])
        );
        expect(repairDoc(doc)).toBe(2);
        expect(json(doc).content?.[0]).toEqual({ type: 'callout', attrs: { kind: 'tip' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] });
        expect(json(doc).content?.[1]?.content).toEqual([{ type: 'paragraph' }]);
        expect(valid(doc)).toBe(true);
    });

    it('keeps a canvas that sat in a column (same id, its board untouched)', () => {
        const doc = docWith(el('columns', {}, [el('column', {}, [p('Text')]), el('column', {}, [el('canvas', { canvasId: 'cv_Ab3dE6gH9jK0', height: 300 })])]));
        doc.getMap('canvas:cv_Ab3dE6gH9jK0:nodes').set('n1', { id: 'n1', label: 'Box' });
        repairDoc(doc);
        expect(json(doc).content?.[1]).toMatchObject({ type: 'canvas', attrs: { canvasId: 'cv_Ab3dE6gH9jK0', height: 300 } });
        expect(doc.getMap('canvas:cv_Ab3dE6gH9jK0:nodes').get('n1')).toEqual({ id: 'n1', label: 'Box' });
    });

    it('changes nothing in a valid doc, and a second repair finds nothing', () => {
        const doc = docWith(p('Plain'), el('bulletList', {}, [el('listItem', {}, [p('item')])]));
        const before = state(doc);
        expect(repairDoc(doc)).toBe(0);
        expect(state(doc)).toBe(before);
        const broken = docWith(el('columns', {}, [el('column', {}, [p('a')]), el('column', {}, [p('b')])]));
        expect(repairDoc(broken)).toBe(1);
        expect(repairDoc(broken)).toBe(0);
    });
});

describe('repairLegacyBlocks: list items outside a list', () => {
    it('wraps a run of bare list items in one bullet list, and bare to-dos in a task list', () => {
        const doc = docWith(
            p('Alpha'),
            el('listItem', {}, [p('one')]),
            el('listItem', {}, [p('two')]),
            el('taskItem', { checked: true }, [p('done')]),
            p('Omega')
        );
        expect(repairDoc(doc)).toBe(2);
        expect(types(doc)).toEqual(['paragraph', 'bulletList', 'taskList', 'paragraph']);
        expect(json(doc).content?.[1]?.content).toHaveLength(2);
        expect(json(doc).content?.[2]?.content?.[0]).toMatchObject({ type: 'taskItem', attrs: { checked: true } });
        expect(valid(doc)).toBe(true);
    });

    it('repairs what the drag bug stored: a column holding a bare list item', () => {
        const doc = docWith(el('columns', {}, [el('column', {}, [p('Alpha paragraph here.')]), el('column', {}, [el('listItem', {}, [p('item two')])])]));
        expect(docProblem(doc)).toMatch(/Unknown node type: column|Invalid content/);
        repairDoc(doc);
        expect(types(doc)).toEqual(['paragraph', 'bulletList']);
        expect(docProblem(doc)).toBeNull();
    });

    it('leaves list items inside their lists alone (nested ones too)', () => {
        const doc = docWith(el('orderedList', {}, [el('listItem', {}, [p('a'), el('bulletList', {}, [el('listItem', {}, [p('b')])])])]));
        expect(repairLegacyBlocks(doc.getXmlFragment('default'))).toBe(0);
    });
});

describe('docProblem', () => {
    it('is null for a valid doc and for a new (empty) one', () => {
        expect(docProblem(docWith(p('ok')))).toBeNull();
        expect(docProblem(new Y.Doc())).toBeNull();
    });
});

describe('read paths and writes', () => {
    it('yjsStateToDocJson reads a stored columns row as its blocks (and Markdown prints them)', () => {
        const stored = state(docWith(p('Before'), el('columns', {}, [el('column', {}, [p('Left')]), el('column', {}, [p('Right')])])));
        const read = yjsStateToDocJson(stored) as JSONContent;
        expect(read.content?.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
        expect(docJsonToMarkdown(read)).toBe('Before\n\nLeft\n\nRight');
    });

    it('docJsonToYjsState refuses content that breaks the schema (400, with the reason)', () => {
        const bad = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'listItem', content: [{ type: 'paragraph' }] }] };
        expect(() => docJsonToYjsState(bad)).toThrow(ErrorResponse);
        expect(() => docJsonToYjsState(bad)).toThrow(/Invalid doc content/);
        const good = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] };
        expect(typeof docJsonToYjsState(good)).toBe('string');
    });

    it('an agent Undo that brings back a stored columns row brings it back flattened', () => {
        const doc = docWith(el('columns', {}, [el('column', {}, [p('Left')]), el('column', {}, [p('Right')])]));
        const before = Y.encodeStateAsUpdate(doc);
        // The doc was since replaced wholesale, so Undo restores the snapshot's content.
        doc.transact(() => {
            const fragment = doc.getXmlFragment('default');
            fragment.delete(0, fragment.length);
            fragment.insert(0, [p('Replaced')]);
        });
        undoChangeOn(doc, before, null, (mutate) => transactCapturing(doc, mutate));
        expect(types(doc)).toEqual(['paragraph', 'paragraph']);
        expect(valid(doc)).toBe(true);
    });
});
