// AGENT_DIAGRAMS_PLAN §8 "Tokens": what one diagram costs an agent to write as the text form versus
// the old JSON form (positions included, as add_canvas took it). Characters / 4 ≈ tokens.
//   npx ts-node --transpile-only scripts/diagram-token-cost.ts
import fs from 'node:fs';
import path from 'node:path';
import { printCanvasJsonFence } from '../src/services/docs/canvas';
import { layoutDiagram } from '../src/services/docs/diagram/layout';
import { parseDiagram } from '../src/services/docs/diagram/parse';

async function main(): Promise<void> {
    const dir = path.join(__dirname, '../tests/fixtures/diagrams');
    for (const name of ['url-shortener', 'chat-system', 'rate-limiter']) {
        const text = fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8').trim();
        // What an agent would write: the diagram lines without comments.
        const written = text.split(/\r?\n/).filter((l) => !l.trim().startsWith('%%')).join('\n');
        const { board } = await layoutDiagram(parseDiagram(text));
        const json = printCanvasJsonFence({ canvasId: null, data: board });
        // The v1 JSON an agent actually wrote: no positions (the old auto-layout placed boxes), defaults left out.
        const lean = JSON.stringify({
            nodes: board.nodes.map((n) => ({ id: n.id, text: n.text, ...(n.shape !== 'rect' ? { shape: n.shape } : {}), ...(n.color !== 'default' ? { color: n.color } : {}) })),
            edges: board.edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}), ...(e.line !== 'solid' ? { line: e.line } : {}) })),
        });
        const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
        console.log(`${name}: text ~${Math.round(written.length / 4)} tokens · v1 JSON without positions ~${Math.round(lean.length / 4)} (text = ${pct(written.length, lean.length)}) · v1 JSON with positions ~${Math.round(json.length / 4)} (text = ${pct(written.length, json.length)})`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
