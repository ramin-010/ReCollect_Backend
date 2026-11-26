// The server's copies of the new editor's own blocks (src/services/docs/blocks/specs.ts) must match
// the browser's (recollect/lib/blocks/*/spec.ts): same type names, content kinds, props and
// defaults, or a block written by one side reads wrong on the other. Read as text: the frontend is
// another project (skipped where it isn't checked out, e.g. on a server).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultBlockSpecs } from '@blocknote/core';
import { CALLOUT_KINDS, calloutBlockConfig, canvasBlockConfig, diagramBlockConfig, pageBlockConfig } from '../../../src/services/docs/blocks/specs';

const FRONT = path.resolve(__dirname, '../../../../recollect/lib/blocks');
const has = fs.existsSync(FRONT);

function frontSpec(name: string): string {
    return fs.readFileSync(path.join(FRONT, name, 'spec.ts'), 'utf8');
}

/** `type`, `content` and each prop's default as written in a frontend spec. */
function parse(text: string) {
    const type = /type:\s*'([\w-]+)'/.exec(text)?.[1];
    const content = /content:\s*'(\w+)'/.exec(text)?.[1];
    const propBlock = /propSchema:\s*\{([\s\S]*?)\n\s{2}\},/.exec(text)?.[1] ?? '';
    const props: Record<string, string> = {};
    for (const m of propBlock.matchAll(/(\w+):\s*\{\s*default:\s*([^,}]+?)(?:\s+as\s+\w+)?\s*[,}]/g)) props[m[1]!] = m[2]!.trim().replace(/^'(.*)'$/, '$1');
    return { type, content, props };
}

const serverProps = (schema: Record<string, { default: unknown }>) => Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, String(v.default)]));

describe.skipIf(!has)('block specs: browser and server agree', () => {
    it('callout', () => {
        const front = parse(frontSpec('callout'));
        expect(front).toEqual({ type: calloutBlockConfig.type, content: calloutBlockConfig.content, props: serverProps(calloutBlockConfig.propSchema) });
        const kinds = /CALLOUT_KINDS\s*=\s*\[([^\]]+)\]/.exec(frontSpec('callout'))?.[1]?.match(/'(\w+)'/g)?.map((s) => s.slice(1, -1));
        expect(kinds).toEqual([...CALLOUT_KINDS]);
    });

    it('page (DOC_PAGES_PLAN §5)', () => {
        expect(parse(frontSpec('page'))).toEqual({ type: pageBlockConfig.type, content: pageBlockConfig.content, props: serverProps(pageBlockConfig.propSchema) });
    });

    it('diagram', () => {
        expect(parse(frontSpec('diagram'))).toEqual({ type: diagramBlockConfig.type, content: diagramBlockConfig.content, props: {} });
    });

    // The code block is BlockNote's own config with our view (recollect/lib/blocks/code/): the server keeps
    // BlockNote's built-in, so the two must stay the same block.
    it('code block', () => {
        const builtIn = defaultBlockSpecs.codeBlock.config;
        expect(parse(frontSpec('code'))).toEqual({ type: builtIn.type, content: builtIn.content, props: serverProps(builtIn.propSchema as Record<string, { default: unknown }>) });
    });

    it('canvas', () => {
        expect(parse(frontSpec('canvas'))).toEqual({ type: canvasBlockConfig.type, content: canvasBlockConfig.content, props: serverProps(canvasBlockConfig.propSchema) });
    });
});
