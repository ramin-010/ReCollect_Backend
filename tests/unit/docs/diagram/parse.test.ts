// The text form of a canvas (src/services/docs/diagram/parse.ts): every construct of the Mermaid
// flowchart subset, and errors that name their line and say what to write instead.
import { describe, expect, it } from 'vitest';
import { parseDiagram, type DiagramGraph } from '../../../../src/services/docs/diagram/parse';
import ErrorResponse from '../../../../src/utils/errorResponse';

const parse = (...lines: string[]): DiagramGraph => parseDiagram(lines.join('\n'));
const node = (graph: DiagramGraph, id: string) => graph.nodes.find((n) => n.id === id);
const arrows = (graph: DiagramGraph) => graph.edges.map((e) => `${e.from}${e.line === 'dashed' ? '~' : '-'}${e.arrow}${e.label ? `[${e.label}]` : ''}>${e.to}`);

/** The 400 message for some text. */
function error(...lines: string[]): string {
    try {
        parseDiagram(lines.join('\n'));
    } catch (err) {
        expect(err).toBeInstanceOf(ErrorResponse);
        expect((err as ErrorResponse).statusCode).toBe(400);
        return (err as ErrorResponse).message;
    }
    throw new Error('expected a 400');
}

describe('header and direction', () => {
    it.each([
        ['flowchart LR', 'LR'],
        ['graph TD', 'TB'],
        ['flowchart TB', 'TB'],
        ['flowchart RL', 'RL'],
        ['graph BT;', 'BT'],
        ['flowchart lr', 'LR'],
        ['flowchart', null],
    ])('%s → %s', (header, direction) => {
        expect(parse(header, 'a --> b').direction).toBe(direction);
    });

    it('without a header the layout picks; a top-level direction line sets it', () => {
        expect(parse('a --> b').direction).toBeNull();
        expect(parse('direction TB', 'a --> b').direction).toBe('TB');
    });

    it('direction inside a subgraph is accepted with a note (one direction per board)', () => {
        const graph = parse('flowchart LR', 'subgraph s [S]', '  direction TB', '  a', 'end');
        expect(graph.direction).toBe('LR');
        expect(graph.notes).toEqual(['"direction TB" in subgraph "s" is ignored: a board has one direction.']);
    });

    it('a header after the first statement, or an unknown direction, is an error naming the line', () => {
        expect(error('a --> b', 'flowchart LR')).toMatch(/^line 2: "flowchart" must be the first line/);
        expect(error('flowchart sideways')).toMatch(/^line 1: "sideways" is not a direction: write flowchart LR/);
    });

    it('another diagram type points at a ```mermaid fence', () => {
        expect(error('sequenceDiagram', '  A->>B: hi')).toBe('line 1: a canvas holds a flowchart (boxes and arrows); for a sequenceDiagram use a ```mermaid fence instead');
        expect(error('%% comment', 'erDiagram')).toMatch(/^line 2: .*erDiagram use a ```mermaid fence/);
    });
});

describe('boxes', () => {
    it.each([
        ['a[Box]', 'rect', 'Box'],
        ['a(Rounded)', 'rounded', 'Rounded'],
        ['a([Pill])', 'pill', 'Pill'],
        ['a[(Database)]', 'cylinder', 'Database'],
        ['a((Circle))', 'ellipse', 'Circle'],
        ['a(((Double)))', 'ellipse', 'Double'],
        ['a{Decision?}', 'diamond', 'Decision?'],
        ['a[[Queue]]', 'queue', 'Queue'],
    ])('%s → %s', (text, shape, label) => {
        expect(parse(text).nodes).toEqual([{ id: 'a', shape, text: label, color: 'default' }]);
    });

    it.each([['a{{Hex}}', '{{…}}'], ['a[/Lean/]', '[/…/]'], ['a[\\Lean\\]', '[\\…\\]'], ['a[/Trap\\]', '[/…/]'], ['a>Flag]', '>…]']])(
        '%s is drawn as a box, with a note',
        (text, written) => {
            const graph = parse(text);
            expect(node(graph, 'a')!.shape).toBe('rect');
            expect(graph.notes[0]).toContain(`"a" (${written})`);
        }
    );

    it('a box without text shows its id; quoted text may hold brackets; <br> and \\n are line breaks', () => {
        const graph = parse('plain --> q["Load balancer (L7) [eu]"]', 'b["Line one<br>line two"] --> c[Two<br/>lines]', 'd["x\\ny"]');
        expect(node(graph, 'plain')!.text).toBe('plain');
        expect(node(graph, 'q')!.text).toBe('Load balancer (L7) [eu]');
        expect(node(graph, 'b')!.text).toBe('Line one\nline two');
        expect(node(graph, 'c')!.text).toBe('Two\nlines');
        expect(node(graph, 'd')!.text).toBe('x\ny');
    });

    it('[(…] and [/…] that never close as a cylinder or a slant are plain boxes (a path, a note in brackets)', () => {
        const graph = parse('a[/v1/shorten] --> b[(L7) LB]');
        expect(node(graph, 'a')).toMatchObject({ shape: 'rect', text: '/v1/shorten' });
        expect(node(graph, 'b')).toMatchObject({ shape: 'rect', text: '(L7) LB' });
    });

    it('ids may hold single dashes (orders-db) and still read a-->b as an arrow', () => {
        expect(arrows(parse('orders-db-->cache_1'))).toEqual(['orders-db-end>cache_1']);
        expect(arrows(parse('a-->b'))).toEqual(['a-end>b']);
    });

    it('a box declared twice keeps its first label unless the later one gives one; a later bracket changes the shape', () => {
        expect(node(parse('a[First] --> b', 'a --> c'), 'a')).toMatchObject({ text: 'First', shape: 'rect' });
        expect(node(parse('a[First]', 'a((Second))'), 'a')).toMatchObject({ text: 'Second', shape: 'ellipse' });
        expect(node(parse('a((Round))', 'a --> b'), 'a')!.shape).toBe('ellipse');
    });

    it(':::colours, with aliases; a colour we do not draw comes with a note', () => {
        const graph = parse('a[A]:::blue --> b:::grey', 'c:::orange', 'd:::purple');
        expect(graph.nodes.map((n) => [n.id, n.color])).toEqual([
            ['a', 'blue'],
            ['b', 'gray'],
            ['c', 'yellow'],
            ['d', 'default'],
        ]);
        expect(graph.notes).toEqual([':::purple on "d" is drawn without a colour (colours: :::gray, :::blue, :::green, :::yellow, :::red).']);
        expect(error('a:::teal')).toBe('line 1: :::teal is not a colour (on "a"): use :::gray, :::blue, :::green, :::yellow, :::red');
    });
});

describe('@{ … } (Mermaid 11 keys plus kind, color, size)', () => {
    it('kind sets the shape when the bracket names none ([text] is a plain box); its aliases work', () => {
        const graph = parse('db[Postgres]@{ kind: database }', 'q@{ kind: mq, label: "Jobs" }', 'w([Web])@{ kind: browser }', 'lb@{kind: "load balancer"}[LB]');
        expect(graph.nodes).toEqual([
            { id: 'db', shape: 'cylinder', text: 'Postgres', color: 'default', kind: 'database' },
            { id: 'q', shape: 'queue', text: 'Jobs', color: 'default', kind: 'queue' },
            { id: 'w', shape: 'pill', text: 'Web', color: 'default', kind: 'client' },
            { id: 'lb', shape: 'rect', text: 'LB', color: 'default', kind: 'lb' },
        ]);
    });

    it('shape and label win over the bracket, before or after it; color and size', () => {
        const graph = parse('a[Old]@{ shape: cyl, label: "New" }', 'b@{ shape: stadium }[B]', 'c@{ shape: h-cyl, color: red, size: large }', 'd@{ shape: hex }', 't@{ shape: text, label: "Title" }');
        expect(node(graph, 'a')).toMatchObject({ shape: 'cylinder', text: 'New' });
        expect(node(graph, 'b')).toMatchObject({ shape: 'pill', text: 'B' });
        expect(node(graph, 'c')).toMatchObject({ shape: 'queue', color: 'red', size: 'l' });
        expect(node(graph, 'd')!.shape).toBe('rect');
        expect(graph.notes[0]).toContain('"d" (shape: hex)');
        expect(node(graph, 't')).toMatchObject({ shape: 'text', text: 'Title' });
    });

    it('an unknown kind lists the kinds; an unknown key, shape or colour says what is allowed', () => {
        expect(error('flowchart LR', 'x@{ kind: blockchain }')).toBe(
            'line 2: "x": "blockchain" is not a kind. Kinds: client, user, mobile, service, worker, function, database, cache, queue, stream, storage, search, cdn, dns, gateway, lb, auth, external, monitor, scheduler, notify, model'
        );
        expect(error('x@{ icon: aws }')).toMatch(/^line 1: "icon" is not a key of @\{ … \} \(kind sets the icon/);
        expect(error('x@{ shape: blob }')).toMatch(/^line 1: "blob" is not a shape \(on "x"\)\. Shapes: rect, rounded/);
        expect(error('x@{ color: teal }')).toMatch(/^line 1: "teal" is not a colour/);
        expect(error('x@{ kind: cache')).toMatch(/^line 1: @\{ … \} on "x" is not closed: expected "\}"/);
    });
});

describe('arrows', () => {
    it.each([
        ['a --> b', ['a-end>b']],
        ['a ---> b', ['a-end>b']],
        ['a --- b', ['a-none>b']],
        ['a ---- b', ['a-none>b']],
        ['a -.-> b', ['a~end>b']],
        ['a -..-> b', ['a~end>b']],
        ['a -.- b', ['a~none>b']],
        ['a ==> b', ['a-end>b']],
        ['a === b', ['a-none>b']],
        ['a <--> b', ['a-both>b']],
        ['a <-.-> b', ['a~both>b']],
        ['a -->|HTTPS| b', ['a-end[HTTPS]>b']],
        ['a -->|"x | y"| b', ['a-end[x | y]>b']],
        ['a --> |spaced| b', ['a-end[spaced]>b']],
        ['a -- calls --> b', ['a-end[calls]>b']],
        ['a -- calls --- b', ['a-none[calls]>b']],
        ['a -. async .-> b', ['a~end[async]>b']],
        ['a == hot ==> b', ['a-end[hot]>b']],
        ['a-->b-->c', ['a-end>b', 'b-end>c']],
        ['a --> b & c', ['a-end>b', 'a-end>c']],
        ['a & b -->|r| c & d', ['a-end[r]>c', 'a-end[r]>d', 'b-end[r]>c', 'b-end[r]>d']],
        ['a --> a', ['a-end>a']],
    ])('%s', (text, expected) => {
        expect(arrows(parse(text))).toEqual(expected);
    });

    it('ids e1, e2, … in order; thick and --o / --x arrows come with a note', () => {
        const graph = parse('a ==> b --o c', 'c --x d');
        expect(graph.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
        expect(graph.notes).toEqual(['Thick arrows (==>) are drawn as normal arrows.', '--o and --x arrows end in a normal arrowhead.']);
    });

    it.each([
        [['a -> b'], /^line 1: "->" is not an arrow\. Arrows: --> \(or --->\), ---/],
        [['a --> '], /^line 1: expected a box id after the arrow/],
        [['a b'], /^line 1: expected an arrow \(-->\) or & after "a", found "b"\. Put one statement on each line/],
        [['a -- label b'], /^line 1: an arrow label written as -- text --> needs its closing arrow/],
        [['a <--- b'], /^line 1: an arrow that starts with "<" needs a head at the end too/],
        [['a <-- b'], /^line 1: an arrow that starts with "<" needs a head at the end too: <--> or <-\.->\. For an arrow the other way, swap the boxes/],
        [['a -- x -->|y| b'], /^line 1: an arrow has two labels/],
        [['a -->|open b'], /^line 1: an arrow label \|… is not closed: expected "\|"/],
        [['a & --> b'], /^line 1: expected a box id \(letters, digits, _\), found "--> b"/],
    ])('%j → a 400 naming the line', (lines, message) => {
        expect(error(...lines)).toMatch(message);
    });
});

describe('zones (subgraph … end)', () => {
    it('the four ways to name one; a zone may be an arrow end; zones nest and take :::colour', () => {
        const graph = parse(
            'subgraph api [API tier]:::blue',
            '  a1',
            '  subgraph inner["Inner (hot)"]',
            '    a2',
            '  end',
            'end',
            'subgraph "Data stores"',
            '  db[(PG)]',
            'end',
            'subgraph Async jobs',
            '  w',
            'end',
            'subgraph solo',
            'end',
            'api --> db'
        );
        expect(graph.nodes.filter((n) => n.shape === 'zone')).toEqual([
            { id: 'api', shape: 'zone', text: 'API tier', color: 'blue' },
            { id: 'inner', shape: 'zone', text: 'Inner (hot)', color: 'default', parent: 'api' },
            { id: 'data_stores', shape: 'zone', text: 'Data stores', color: 'default' },
            { id: 'async_jobs', shape: 'zone', text: 'Async jobs', color: 'default' },
            { id: 'solo', shape: 'zone', text: 'solo', color: 'default' },
        ]);
        expect(graph.nodes.filter((n) => n.shape !== 'zone').map((n) => [n.id, n.parent])).toEqual([
            ['a1', 'api'],
            ['a2', 'inner'],
            ['db', 'data_stores'],
            ['w', 'async_jobs'],
        ]);
        expect(arrows(graph)).toEqual(['api-end>db']);
    });

    it('as in Mermaid, a box belongs to the innermost subgraph whose lines name it; lines outside move nothing', () => {
        const graph = parse('lb --> a1', 'subgraph api [API]', '  a1 & a2', '  a2 --> cache', 'end', 'cache --> db');
        expect(graph.nodes.map((n) => [n.id, n.parent ?? null])).toEqual([
            ['lb', null],
            ['a1', 'api'],
            ['api', null],
            ['a2', 'api'],
            ['cache', 'api'],
            ['db', null],
        ]);
    });

    it.each([
        [['subgraph api [API]', '  a'], /^line 1: subgraph "api" is not closed: expected "end"/],
        [['a', 'end'], /^line 2: "end" without a subgraph to close/],
        [['subgraph'], /^line 1: a subgraph needs a name/],
        [['subgraph api (API)', 'end'], /^line 1: a subgraph title goes in square brackets: subgraph api \[Title\]/],
        [['api[API]', 'subgraph api [API]', 'end'], /^line 2: "api" is already a box \(line 1\): give the subgraph another id/],
        [['subgraph api [API]', 'end', 'api[Box]'], /^line 3: "api" is a zone \(subgraph on line 1\)/],
        [['subgraph api [API]', '  a', 'end', 'api --> a'], /^line 4: an arrow can't join zone "api" to "a", which is inside it/],
        [['subgraph api [API]', 'end', 'api --> api'], /^line 3: an arrow can't join zone "api" to itself/],
    ])('%j → a 400 naming the line', (lines, message) => {
        expect(error(...lines)).toMatch(message);
    });
});

describe('notes', () => {
    it('the four forms; "for" adds a dashed, arrowless line from the box; ids note1, note2, … never clash', () => {
        const graph = parse('db[(PG)]', 'note: Free note; with a semicolon %% and percent', 'note n2: Named', 'note for db: Primary + replicas', 'note n4 for db: Both', 'note1[Taken]');
        expect(graph.nodes.filter((n) => n.shape === 'sticky')).toEqual([
            { id: 'note2', shape: 'sticky', text: 'Free note; with a semicolon %% and percent', color: 'default' },
            { id: 'n2', shape: 'sticky', text: 'Named', color: 'default' },
            { id: 'note3', shape: 'sticky', text: 'Primary + replicas', color: 'default' },
            { id: 'n4', shape: 'sticky', text: 'Both', color: 'default' },
        ]);
        expect(arrows(graph)).toEqual(['db~none>note3', 'db~none>n4']);
    });

    it('a note inside a subgraph sits in its zone; a note may name a box written later', () => {
        const graph = parse('subgraph z [Z]', '  note n1 for later: hi', 'end', 'later[Later]');
        expect(node(graph, 'n1')).toMatchObject({ shape: 'sticky', parent: 'z' });
        expect(node(graph, 'later')!.parent).toBeUndefined();
    });

    it.each([
        [['note right of db: x'], /^line 1: that is sequence-diagram syntax: write note for db: text/],
        [['note without colon'], /^line 1: write a note as note: text, note id: text, or note for box: text/],
        [['a', 'note for dbb: x'], /^line 2: note for "dbb": there is no box "dbb"\. Boxes: a/],
        [['db[DB]', 'note db: x'], /^line 2: "db" is already a box \(line 1\): give the note its own id/],
        [['subgraph z [Z]', '  note for z: x', 'end'], /^line 2: a note inside zone "z" can't be "for" that zone/],
    ])('%j → a 400 naming the line', (lines, message) => {
        expect(error(...lines)).toMatch(message);
    });
});

describe('comments, directives and statements', () => {
    it('%% id and %% height are kept; other %% lines and trailing %% are comments; ; separates statements', () => {
        const graph = parse('%% id: cv_Ab3dE6gH9jK0', '%% height: 9000', '%%{init: {"theme": "dark"}}%%', 'a --> b; b --> c %% trailing', 'd["semi;colon"] -->|x;y| e');
        expect(graph.canvasId).toBe('cv_Ab3dE6gH9jK0');
        expect(graph.height).toBe(1400);
        expect(arrows(graph)).toEqual(['a-end>b', 'b-end>c', 'd-end[x;y]>e']);
        expect(node(graph, 'd')!.text).toBe('semi;colon');
    });

    it('front matter (---) is skipped with a note; a box may be called "note", "class" or "end" when an arrow follows', () => {
        const graph = parse('---', 'title: X', '---', 'flowchart LR', 'note --> class', 'class --> end');
        expect(graph.direction).toBe('LR');
        expect(arrows(graph)).toEqual(['note-end>class', 'class-end>end']);
        expect(graph.notes).toEqual(['The --- front matter is ignored.']);
    });

    it.each([
        [['a', 'classDef hot fill:#f00'], 'line 2: classDef is not supported on a canvas: colour a box with :::gray, :::blue, :::green, :::yellow, :::red, e.g. db[(Postgres)]:::blue'],
        [['class a hot'], 'line 1: class is not supported on a canvas: colour a box with :::gray, :::blue, :::green, :::yellow, :::red, e.g. db[(Postgres)]:::blue'],
        [['style a fill:#f00'], 'line 1: style is not supported on a canvas: colour a box with :::gray, :::blue, :::green, :::yellow, :::red, e.g. db[(Postgres)]:::blue'],
        [['linkStyle 0 stroke:red'], 'line 1: linkStyle is not supported: arrows are drawn plain; use -.-> for a dashed (async) arrow, and |label| for words on it'],
        [['click a "https://x.test"'], 'line 1: click is not supported on a canvas (boxes have no links): leave the line out'],
        [['%% id: cv_123'], 'line 1: "cv_123" is not a canvas id (cv_ and 12 letters, digits, - or _): copy it from read_doc, or leave the line out'],
        [['%% height: tall'], 'line 1: %% height needs a number of pixels (240–1400), e.g. %% height: 600'],
    ])('%j → %s', (lines, message) => {
        expect(error(...lines)).toBe(message);
    });

    it('text errors: an unclosed bracket, a stray bracket, a missing id; limits', () => {
        expect(error('a[Text')).toMatch(/^line 1: the text of "a" is not closed: expected "\]"\. Text with brackets goes in quotes: a\["…"\]/);
        expect(error('a(f(x)) --> b')).toMatch(/^line 1: the text of "a" has a "\)" in it, or a bracket too many: put the text in quotes/);
        expect(error('[Text] --> b')).toMatch(/^line 1: a box needs an id before its text, e.g. api\[…: found "\[Text\] --> b"/);
        expect(error(`a[${'x'.repeat(1001)}]`)).toBe('line 1: the text of "a" is 1001 characters; the most is 1000');
        expect(error(`a -->|${'y'.repeat(201)}| b`)).toBe('line 1: an arrow label is 201 characters; the most is 200');
        expect(error(`${'x'.repeat(41)} --> b`)).toMatch(/^line 1: the id "x{39}…" is 41 characters; the most is 40/);
        const boxes = Array.from({ length: 301 }, (_, i) => `b${i}`).join('\n');
        expect(error(boxes)).toBe('line 301: a canvas holds at most 300 boxes (zones and notes count)');
    });

    it('an empty text is an empty diagram', () => {
        expect(parse('flowchart LR', '%% nothing')).toEqual({ direction: 'LR', canvasId: null, height: null, nodes: [], edges: [], notes: [] });
    });
});

describe('the plan’s example (AGENT_DIAGRAMS_PLAN §4.1)', () => {
    it('parses to 9 boxes, a zone, a note and 9 arrows', () => {
        const graph = parse(
            'flowchart LR',
            '  user([User]) -->|HTTPS| cdn[CDN] --> lb[Load balancer]',
            '  subgraph api [API tier]',
            '    a1[API server 1]',
            '    a2[API server 2]',
            '  end',
            '  lb --> a1 & a2',
            '  a1 & a2 -->|read| cache[(Redis)]:::red',
            '  a1 & a2 -->|write| db[(Postgres primary)]:::blue',
            '  db -.->|CDC| q[[Outbox queue]]:::yellow',
            '  note: Writes go to the primary; reads try the cache first.'
        );
        expect(graph.nodes.map((n) => `${n.id}:${n.shape}${n.parent ? `@${n.parent}` : ''}`)).toEqual([
            'user:pill', 'cdn:rect', 'lb:rect', 'api:zone', 'a1:rect@api', 'a2:rect@api', 'cache:cylinder', 'db:cylinder', 'q:queue', 'note1:sticky',
        ]);
        expect(arrows(graph)).toEqual([
            'user-end[HTTPS]>cdn', 'cdn-end>lb', 'lb-end>a1', 'lb-end>a2', 'a1-end[read]>cache', 'a2-end[read]>cache', 'a1-end[write]>db', 'a2-end[write]>db', 'db~end[CDC]>q',
        ]);
        expect(graph.notes).toEqual([]);
    });
});
