// The new editor's own blocks, schema-only, for the server (DOCS_EDITOR_V2_PLAN §4.1): the same
// type names, props and content kinds as the browser's blocks in recollect/lib/blocks/*/spec.ts
// (tests/unit/docs/blockSpecs.test.ts keeps the two in step), with plain-DOM renders instead of
// React. The server never shows them; the renders only serve BlockNote's HTML export.
import { BlockNoteSchema, createBlockSpec, defaultBlockSpecs } from '@blocknote/core';

export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export const calloutBlockConfig = {
    type: 'callout' as const,
    propSchema: {
        kind: { default: 'note' as CalloutKind, values: CALLOUT_KINDS },
    },
    content: 'inline' as const,
};

export const diagramBlockConfig = {
    type: 'diagram' as const,
    propSchema: {},
    content: 'plain' as const,
};

export const canvasBlockConfig = {
    type: 'canvas' as const,
    propSchema: {
        canvasId: { default: '' },
        height: { default: 440 },
    },
    content: 'none' as const,
};

const make = (tag: string): HTMLElement => (globalThis as unknown as { document: Document }).document.createElement(tag);

const calloutBlock = createBlockSpec(calloutBlockConfig, {
    render: (block) => {
        const dom = make('div');
        dom.setAttribute('data-callout', String(block.props.kind));
        const contentDOM = make('p');
        dom.appendChild(contentDOM);
        return { dom, contentDOM };
    },
});

const diagramBlock = createBlockSpec(diagramBlockConfig, {
    meta: { code: true, defining: true, isolating: false },
    render: () => {
        const dom = make('pre');
        const contentDOM = make('code');
        contentDOM.className = 'language-mermaid';
        dom.appendChild(contentDOM);
        return { dom, contentDOM };
    },
});

const canvasBlock = createBlockSpec(canvasBlockConfig, {
    render: (block) => {
        const dom = make('div');
        dom.setAttribute('data-canvas-id', String(block.props.canvasId));
        return { dom };
    },
});

/**
 * The block registry on the server: BlockNote's built-ins plus ours (the browser's order: the
 * diagram first). Cast: BlockNote's types don't accept this project's exactOptionalPropertyTypes.
 */
export const serverDocSchema = BlockNoteSchema.create({
    blockSpecs: {
        diagram: diagramBlock(),
        ...defaultBlockSpecs,
        canvas: canvasBlock(),
        callout: calloutBlock(),
    } as never,
});
