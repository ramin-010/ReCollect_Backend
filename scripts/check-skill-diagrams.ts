// Checks the diagrams in a Markdown file the way an agent write would (parse, ELK, lint), so the
// examples in the note skill always work: every ```canvas fence and its report.
//
//   npx ts-node --transpile-only scripts/check-skill-diagrams.ts <file.md>
import fs from 'node:fs';
import { markdownToDocJson } from '../src/services/docs/markdown/docMarkdown';
import { resolveDiagrams } from '../src/services/docs/diagram/resolve';

async function main(): Promise<void> {
    const file = process.argv[2];
    if (!file) throw new Error('Give a Markdown file');
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    // The worked examples (fenced with ````markdown), else the whole file as one note.
    const examples = [...text.matchAll(/^````markdown\n([\s\S]*?)\n````$/gm)].map((m) => m[1]!);
    const sources = examples.length > 0 ? examples : [text];
    let i = 0;
    for (const md of sources) {
        i += 1;
        try {
            const reports = await resolveDiagrams(markdownToDocJson(md));
            if (reports.length === 0) console.log(`example ${i}: no canvas`);
            for (const r of reports) {
                console.log(`example ${i}: ${r.boxes} boxes, ${r.arrows} arrows, ${r.zones} zones, ${r.width}×${r.height}, ${Math.round(r.zoom * 100)}% · ${r.warnings.join(' | ') || 'no problems'}`);
            }
        } catch (err) {
            console.log(`example ${i}: REFUSED · ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
