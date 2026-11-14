// ```mermaid blocks checked on write (src/services/docs/mermaid, AGENT_DIAGRAMS_PLAN §5): Mermaid
// 11.17.2's own parser, in a worker thread, refuses a block it can't read with a 400 that names the
// block, its diagram type and the line (counted in the block), so an agent fixes it in one round.
import { describe, expect, it } from 'vitest';
import { markdownToDocJson } from '../../../../src/services/docs/markdown/docMarkdown';
import { resolveDiagrams } from '../../../../src/services/docs/diagram/resolve';
import { MERMAID_MAX_CHARS, checkMermaidBlocks, diagramType, mermaidSources } from '../../../../src/services/docs/mermaid/check';
import ErrorResponse from '../../../../src/utils/errorResponse';

const fence = (...lines: string[]) => ['```mermaid', ...lines, '```'].join('\n');

/** The 400's message for this Markdown, or null when every block passes. */
async function refusal(markdown: string): Promise<string | null> {
    try {
        await checkMermaidBlocks(markdownToDocJson(markdown));
        return null;
    } catch (err) {
        expect(err).toBeInstanceOf(ErrorResponse);
        expect((err as ErrorResponse).statusCode).toBe(400);
        return (err as ErrorResponse).message;
    }
}

const VALID: Record<string, string[]> = {
    flowchart: ['flowchart LR', '  user([User]) -->|HTTPS| api[API]', '  subgraph data [Data tier]', '    db[(Postgres)]', '  end', '  api --> db', '  api -.->|async| q[[Queue]]'],
    sequenceDiagram: ['sequenceDiagram', '  participant C as Client', '  C->>S: GET /items', '  alt cached', '    S-->>C: 200 (cache)', '  else miss', '    S-->>C: 200', '  end', '  Note over C,S: TLS throughout'],
    erDiagram: ['erDiagram', '  USER ||--o{ ORDER : places', '  ORDER ||--|{ LINE_ITEM : contains', '  USER {', '    uuid id PK', '    string email', '  }'],
    'stateDiagram-v2': ['stateDiagram-v2', '  [*] --> Idle', '  Idle --> Running : start', '  state Running {', '    [*] --> Warm', '    Warm --> Hot', '  }', '  Running --> [*]'],
    classDiagram: ['classDiagram', '  class Cache {', '    +get(key) Value', '    -evict()', '  }', '  Cache <|-- LruCache', '  Cache "1" --> "*" Entry : holds'],
    timeline: ['timeline', '  title Releases', '  2024 : v1 : beta', '  2025 : v2'],
    mindmap: ['mindmap', '  root((Consistent hashing))', '    Ring', '      Virtual nodes', '    Uses', '      Caches'],
    gantt: ['gantt', '  title Plan', '  dateFormat YYYY-MM-DD', '  section Build', '    Parser :a1, 2026-11-01, 3d', '    Layout :after a1, 2d'],
};

describe('valid blocks pass, unchanged', () => {
    it.each(Object.entries(VALID))('%s', async (_type, lines) => {
        const json = markdownToDocJson(`## Diagram\n\n${fence(...lines)}`);
        const before = structuredClone(json);
        await checkMermaidBlocks(json);
        expect(json).toEqual(before);
    });

    it('front matter, %% comments and an init directive are fine; an empty block passes (the editor shows a placeholder)', async () => {
        expect(await refusal(fence('---', 'title: Login', '---', '%%{init: {"theme": "dark"}}%%', 'sequenceDiagram', '  %% who talks', '  A->>B: hi'))).toBeNull();
        expect(await refusal('```mermaid\n```\n\n```mermaid\n   \n```')).toBeNull();
    });

    it('only ```mermaid blocks are read: other code and canvas fences are not Mermaid', async () => {
        expect(await refusal('```ts\nflowchart -> nope\n```\n\n```canvas\na --> b\n```')).toBeNull();
        expect(mermaidSources(markdownToDocJson('```ts\nx\n```\n\n' + fence('graph TD; A-->B')))).toEqual(['graph TD; A-->B']);
    });
});

describe('a block Mermaid cannot parse: 400 with its number, type, line and Mermaid’s message', () => {
    it("a sequence message without its text (Mermaid's own lines, trimmed)", async () => {
        expect(await refusal(fence('sequenceDiagram', '  Alice->>Bob: Hello', '  Bob-->>Alice: Hi', '  Alice->>Bob', '  Bob-->>Alice: ok'))).toBe(
            [
                'Mermaid block 1 (sequenceDiagram), line 4: Parse error on line 4:',
                '...ce: Hi  Alice->>Bob  Bob-->>Alice: ok',
                '----------------------^',
                "Expecting 'TXT', got 'NEWLINE'",
            ].join('\n')
        );
    });

    it('a bad arrow', async () => {
        expect(await refusal(fence('flowchart LR', '  a --> b', '  b -> c'))).toBe(
            [
                'Mermaid block 1 (flowchart), line 3: Parse error on line 3:',
                '...rt LR  a --> b  b -> c',
                '---------------------^',
                "Expecting 'SEMI', 'NEWLINE', 'EOF', 'AMP', 'START_LINK', 'LINK', 'LINK_ID', got 'MINUS'",
            ].join('\n')
        );
        expect(await refusal(fence('sequenceDiagram', '  A->>B: hi', '  A=>B: bad'))).toMatch(/^Mermaid block 1 \(sequenceDiagram\), line 3: Parse error on line 3:\n/);
    });

    it('a missing end (subgraph, loop) or closing brace: the last line, and what is missing', async () => {
        const subgraph = await refusal(fence('flowchart LR', '  subgraph api [API]', '    a1 --> a2', '  b --> c'));
        expect(subgraph).toMatch(/^Mermaid block 1 \(flowchart\), line 4: Parse error on line 4:\n/);
        expect(subgraph).toMatch(/, … \(30 in all\), got the end of the block\nIs an "end" missing\?$/);
        expect(await refusal(fence('sequenceDiagram', '  loop every minute', '    A->>B: ping', '  B-->>A: pong'))).toMatch(/^Mermaid block 1 \(sequenceDiagram\), line 4: [^]*\nIs an "end" missing\?$/);
        expect(await refusal(fence('classDiagram', '  class Cache {', '    +get()', '  Cache <|-- Lru'))).toMatch(
            /^Mermaid block 1 \(classDiagram\), line 4: [^]*Expecting 'STRUCT_STOP', 'MEMBER', got the end of the block\nIs a closing "\}" missing\?$/
        );
    });

    it('a stray quote: the line it opens on, not the end Mermaid read on to', async () => {
        expect(await refusal(fence('flowchart LR', '  a["Start] --> b', '  b --> c', '  c --> d'))).toMatch(
            /^Mermaid block 1 \(flowchart\), line 2: Parse error on line 4:\n[^]*got the end of the block\nIs a quote opened on line 2 never closed\?$/
        );
        expect(await refusal(fence('flowchart LR', '  a --> b', '  b -->|"yes| c', '  c --> d'))).toMatch(/^Mermaid block 1 \(flowchart\), line 3: [^]*Is a quote opened on line 3 never closed\?$/);
        expect(await refusal(fence('erDiagram', '  A ||--o{ B : "has', '  B ||--|{ C : contains'))).toMatch(/^Mermaid block 1 \(erDiagram\), line 2: Parse error on line 2:\n/);
        // Below front matter, the quote's line is still the block's (Mermaid counts it as line 2).
        expect(await refusal(fence('---', 'title: x', '---', 'flowchart LR', '  a["Start] --> b', '  b --> c'))).toMatch(
            /^Mermaid block 1 \(flowchart\), line 5: Parse error on line 6:\n[^]*\nIs a quote opened on line 5 never closed\?$/
        );
    });

    it('an unknown diagram type: its line, and the types there are', async () => {
        expect(await refusal(fence('flowchar LR', '  a --> b'))).toBe(
            'Mermaid block 1 (flowchar), line 1: No diagram type detected matching given configuration for text: flowchar LR\n' +
                'The first line names the diagram type: flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, pie, journey, gitGraph, ' +
                'mindmap, timeline, quadrantChart, requirementDiagram, C4Context, sankey-beta, xychart-beta, block-beta, packet-beta, kanban, architecture-beta, radar-beta, treemap-beta.'
        );
        expect(await refusal(fence('%% only a comment'))).toMatch(/^Mermaid block 1 \(no diagram type\), line 1: No diagram type detected/);
    });

    it('lines count in the block, though Mermaid drops front matter, comments and leading blank lines before it counts', async () => {
        const expectLine = async (lines: string[], line: number) =>
            expect(await refusal(fence(...lines))).toMatch(new RegExp(`^Mermaid block 1 \\(flowchart\\), line ${line}: Parse error on line ${line}:\\n`));
        await expectLine(['---', 'title: Hello', '---', 'flowchart LR', '  A --> B', '  B -> C'], 6);
        await expectLine(['%% a comment', 'flowchart LR', '  A --> B', '', '%% another', '  B -> C'], 6);
        await expectLine(['', '', 'flowchart LR', '  A --> B', '  B -> C'], 5);
        await expectLine(['%%{init: {"theme": "dark"}}%%', 'flowchart LR', '  A --> B', '  B -> C'], 4);
        // A flowchart also drops the blank lines after a "}".
        await expectLine(['flowchart LR', '  A{Ok?} --> B', '  B --> C{Done}', '', '', '  C -> D'], 6);
    });

    it("the other parsers' messages (pie, a limit) keep their own words", async () => {
        expect(await refusal(fence('pie title Pets', '  "Dogs" : 386', '  "Cats" 85'))).toBe(
            "Mermaid block 1 (pie), line 3: Parse error on line 3, column 10: Expecting token of type ':' but found `85`."
        );
        const edges = Array.from({ length: 501 }, (_, i) => `  n${i} --> n${i + 1}`);
        expect(await refusal(fence('flowchart LR', ...edges))).toBe('Mermaid block 1 (flowchart): Edge limit exceeded. 500 edges found, but the limit is 500.');
    });
});

describe('block numbers, limits', () => {
    it('blocks are numbered among the Mermaid blocks, at any depth, in document order; each broken one is described', async () => {
        const markdown = [
            '## Flows',
            fence('flowchart LR', '  a -> b'),
            '```ts\nconst notMermaid = 1;\n```',
            '> [!NOTE]\n> ' + fence('sequenceDiagram', '  A->>B: fine').replace(/\n/g, '\n> '),
            '- item\n\n  ' + fence('erDiagram', '  A ||--o{ B places').replace(/\n/g, '\n  '),
        ].join('\n\n');
        const message = await refusal(markdown);
        const paragraphs = message!.split('\n\n');
        expect(paragraphs).toHaveLength(2);
        expect(paragraphs[0]).toMatch(/^Mermaid block 1 \(flowchart\), line 2: /);
        expect(paragraphs[1]).toMatch(/^Mermaid block 3 \(erDiagram\), line 2: Parse error on line 2:\n/);
    });

    it(`a block over ${MERMAID_MAX_CHARS} characters is refused unread`, async () => {
        const body = ['flowchart LR', ...Array.from({ length: 2000 }, (_, i) => `  n${i} --> m${i}`)];
        const length = body.join('\n').length;
        expect(length).toBeGreaterThan(MERMAID_MAX_CHARS);
        expect(await refusal(fence(...body))).toBe(`Mermaid block 1 (flowchart) is ${length} characters; the limit is 20000. Split it into smaller diagrams.`);
    });

    it('a parse that runs past 3 s is a 400 too, and the next check works (a fresh worker)', { timeout: 30_000 }, async () => {
        // A long run of spaces makes Mermaid's flowchart lexer backtrack for many seconds.
        const slow = fence('flowchart LR', `  A --> B${' '.repeat(19_000)}x -`);
        expect(await refusal(slow)).toBe('Mermaid block 1 (flowchart) is too complex to check in 3 s; simplify it.');
        expect(await refusal(fence(...VALID.sequenceDiagram!))).toBeNull();
        expect(await refusal(fence('flowchart LR', '  a --> b', '  b -> c'))).toMatch(/^Mermaid block 1 \(flowchart\), line 3: /);
    });
});

describe('diagramType', () => {
    it('is the first word Mermaid reads: after front matter, %% lines, a directive and blank lines', () => {
        expect(diagramType('graph TD; A-->B')).toEqual({ type: 'graph', line: 1 });
        expect(diagramType('---\ntitle: x\n---\n\n%% hi\nstateDiagram-v2\n  [*] --> A')).toEqual({ type: 'stateDiagram-v2', line: 6 });
        expect(diagramType('%%{init: {"theme": "dark"}}%% pie title Pets')).toEqual({ type: 'pie', line: 1 });
    });
});

describe('resolveDiagrams (every agent write path) checks the Mermaid blocks first', () => {
    it('a broken block rejects with the 400; a valid one is left as written', async () => {
        const broken = markdownToDocJson(`${fence('sequenceDiagram', '  A->>B')}\n\n\`\`\`canvas\na --> b\n\`\`\``);
        await expect(resolveDiagrams(broken)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/^Mermaid block 1 \(sequenceDiagram\), line 2: /) });

        const json = markdownToDocJson(`Intro\n\n${fence(...VALID.erDiagram!)}`);
        const before = structuredClone(json);
        expect(await resolveDiagrams(json)).toEqual([]);
        expect(json).toEqual(before);
    });
});
