// Small changes to a board (update_canvas without a whole new diagram): remove boxes or arrows,
// rename boxes, add lines of the text form. Made on the board as it is, then printed, so what
// follows is the same pipeline as an edited fence (parse, ELK, merge keeping positions).
import ErrorResponse from '../../../utils/errorResponse';
import { CANVAS_LIMITS, absoluteBoxes, type Board, type NodeRecord } from '../canvas';
import { cleanText, parseDiagram } from './parse';
import { printDiagram } from './print';

export interface CanvasEdits {
    /** Lines in the text form, added at the end (a box written again changes its label, shape, colour or kind). */
    add?: string | undefined;
    /** Box ids (their arrows go too; a zone's boxes stay, outside it), or arrows like `a --> b`. */
    remove?: readonly string[] | undefined;
    /** Box id → its new label (a zone's title, a note's text). */
    rename?: Readonly<Record<string, string>> | undefined;
}

const bad = (message: string) => new ErrorResponse(400, message);
const idList = (board: Board) => {
    const ids = board.nodes.map((n) => n.id);
    return `${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ', …' : ''}`;
};

/** The board without what `remove` names and with what `rename` says. 400 for an id that is no box. */
export function applyBoardEdits(board: Board, edits: CanvasEdits): Board {
    let nodes = board.nodes.map((n) => ({ ...n }));
    let edges = board.edges.map((e) => ({ ...e }));
    const has = (id: string) => nodes.some((n) => n.id === id);

    for (const [id, label] of Object.entries(edits.rename ?? {})) {
        const node = nodes.find((n) => n.id === id);
        if (!node) throw bad(`rename: there is no box "${id}". Boxes: ${idList(board)}`);
        const text = cleanText(label);
        if (text.length > CANVAS_LIMITS.text) throw bad(`rename: the label of "${id}" is ${text.length} characters; the most is ${CANVAS_LIMITS.text}`);
        node.text = text;
    }

    for (const item of edits.remove ?? []) {
        const spec = item.trim();
        if (has(spec)) {
            const gone = nodes.find((n) => n.id === spec)!;
            if (gone.shape === 'zone') {
                // The frame goes; what it held moves up a level, staying where it is on screen.
                const abs = absoluteBoxes(nodes);
                const zoneAbs = abs.get(gone.id)!;
                const parentAbs = gone.parent ? abs.get(gone.parent)! : { x: 0, y: 0 };
                nodes = nodes.map((n): NodeRecord => {
                    if (n.parent !== gone.id) return n;
                    const moved: NodeRecord = { ...n, x: n.x + zoneAbs.x - parentAbs.x, y: n.y + zoneAbs.y - parentAbs.y };
                    if (gone.parent) moved.parent = gone.parent;
                    else delete moved.parent;
                    return moved;
                });
            }
            nodes = nodes.filter((n) => n.id !== spec);
            edges = edges.filter((e) => e.from !== spec && e.to !== spec);
            continue;
        }
        // An arrow, as the text form writes one.
        let arrow: { from: string; to: string; label: string } | undefined;
        try {
            const graph = parseDiagram(spec);
            const only = graph.edges.length === 1 ? graph.edges[0] : undefined;
            if (only) arrow = { from: only.from, to: only.to, label: only.label };
        } catch {
            arrow = undefined;
        }
        if (!arrow) throw bad(`remove: "${spec}" is neither a box nor an arrow like a --> b. Boxes: ${idList(board)}`);
        const matches = edges.filter((e) => e.from === arrow!.from && e.to === arrow!.to && (!arrow!.label || e.label === arrow!.label));
        if (matches.length === 0) throw bad(`remove: there is no arrow from "${arrow.from}" to "${arrow.to}"${arrow.label ? ` labelled "${arrow.label}"` : ''}`);
        edges = edges.filter((e) => !matches.includes(e));
    }
    return { nodes, edges };
}

/**
 * The text for an update_canvas call: the board (after remove and rename) printed, then the
 * `add` lines. `addFrom` is the line the added lines start on (so their errors can be named).
 * No `%% height`: the agent asked for none, so the block keeps its height or grows to fit.
 */
export function editedDiagramText(board: Board, canvasId: string, edits: CanvasEdits): { text: string; addFrom: number } {
    const printed = printDiagram(applyBoardEdits(board, edits), { canvasId });
    const add = (edits.add ?? '').replace(/\r\n?/g, '\n').trim();
    const addFrom = printed.split('\n').length + 1;
    return { text: add ? `${printed}\n${add}` : printed, addFrom };
}

/** A parse error on an added line, renamed to that line of `add` ("add line 2: …"). */
export function renumberAddError(err: unknown, addFrom: number): unknown {
    if (!(err instanceof ErrorResponse)) return err;
    const m = /^line (\d+): ([\s\S]*)$/.exec(err.message);
    if (!m || Number(m[1]) < addFrom) return err;
    return new ErrorResponse(err.statusCode, `add line ${Number(m[1]) - addFrom + 1}: ${m[2]}`);
}
