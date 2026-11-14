// What a laid-out board must never get wrong, as a list of problems (empty = fine). Shared by the
// layout tests (fixtures) and the Markdown tests.
import { absoluteBoxes, type Board, type NodeRecord, type Rect } from '../../../../src/services/docs/canvas';
import { labelSize, zoneTitleBand } from '../../../../src/services/docs/diagram/measure';

const overlap = (r: Rect, s: Rect) => r.x < s.x + s.w && s.x < r.x + r.w && r.y < s.y + s.h && s.y < r.y + r.h;
const within = (outer: Rect, p: [number, number], slack = 0) =>
    p[0] >= outer.x - slack && p[0] <= outer.x + outer.w + slack && p[1] >= outer.y - slack && p[1] <= outer.y + outer.h + slack;
const onBorder = (r: Rect, [x, y]: [number, number]) =>
    ((x === r.x || x === r.x + r.w) && y >= r.y && y <= r.y + r.h) || ((y === r.y || y === r.y + r.h) && x >= r.x && x <= r.x + r.w);
/** Shapes whose outline is their box (arrows end on the box's border); the others end on the drawn curve, inside it. */
const BOXY = new Set<NodeRecord['shape']>(['rect', 'rounded', 'sticky', 'text', 'zone']);

export function boardProblems(board: Board): string[] {
    const problems: string[] = [];
    const boxes = absoluteBoxes(board.nodes);
    const byId = new Map(board.nodes.map((n) => [n.id, n]));
    const plain = board.nodes.filter((n) => n.shape !== 'zone');
    const inZone = (n: NodeRecord, zone: string) => {
        for (let at = n.parent; at; at = byId.get(at)?.parent) if (at === zone) return true;
        return false;
    };

    // Numbers: integers, the board from (0, 0), z in list order, zones before what they hold.
    const all = [...boxes.values()];
    if (all.length > 0 && (Math.min(...all.map((b) => b.x)) !== 0 || Math.min(...all.map((b) => b.y)) !== 0)) problems.push('the board does not start at (0, 0)');
    board.nodes.forEach((n, i) => {
        if (![n.x, n.y, n.w, n.h].every(Number.isInteger)) problems.push(`${n.id}: numbers are not integers`);
        if (n.z !== i) problems.push(`${n.id}: z ${n.z} is not its place ${i}`);
        if (n.parent && board.nodes.findIndex((m) => m.id === n.parent) > i) problems.push(`${n.id}: listed before its zone`);
    });

    // Overlaps.
    for (let i = 0; i < plain.length; i += 1) {
        for (let j = i + 1; j < plain.length; j += 1) {
            if (overlap(boxes.get(plain[i]!.id)!, boxes.get(plain[j]!.id)!)) problems.push(`boxes ${plain[i]!.id} and ${plain[j]!.id} overlap`);
        }
    }
    for (const zone of board.nodes.filter((n) => n.shape === 'zone')) {
        const rz = boxes.get(zone.id)!;
        const band = zoneTitleBand(zone.text).h;
        for (const n of board.nodes) {
            if (n === zone || inZone(zone, n.id)) continue;
            const r = boxes.get(n.id)!;
            if (inZone(n, zone.id)) {
                if (!(r.x >= rz.x && r.y >= rz.y && r.x + r.w <= rz.x + rz.w && r.y + r.h <= rz.y + rz.h)) problems.push(`${n.id} is not inside its zone ${zone.id}`);
                if (r.y < rz.y + band) problems.push(`${n.id} is on the title band of zone ${zone.id}`);
            } else if (overlap(r, rz)) problems.push(`${n.id} overlaps zone ${zone.id}, which it is not in`);
        }
    }

    // Routes: right angles, ends on their boxes, labels on their line and off every box.
    for (const e of board.edges) {
        const points = e.route?.points;
        if (!points) {
            problems.push(`${e.id} has no route`);
            continue;
        }
        if (points.length < 2) problems.push(`${e.id}: a route needs two points`);
        if (!points.flat().every(Number.isInteger)) problems.push(`${e.id}: route numbers are not integers`);
        for (let i = 0; i + 1 < points.length; i += 1) {
            const [a, b] = [points[i]!, points[i + 1]!];
            if (a[0] !== b[0] && a[1] !== b[1]) problems.push(`${e.id}: segment ${i} is not a right angle`);
        }
        for (const [end, id] of [
            [points[0]!, e.from],
            [points[points.length - 1]!, e.to],
        ] as const) {
            const node = byId.get(id)!;
            const box = boxes.get(id)!;
            const ok = BOXY.has(node.shape) ? onBorder(box, end) : within(box, end);
            if (!ok) problems.push(`${e.id}: end ${JSON.stringify(end)} is not on ${id}`);
        }
        if (e.label) {
            const centre = e.route?.label;
            if (!centre) problems.push(`${e.id}: a labelled arrow without a label position`);
            else {
                const size = labelSize(e.label);
                const rect = { x: centre[0] - size.w / 2, y: centre[1] - size.h / 2, w: size.w, h: size.h };
                for (const n of plain) if (overlap(rect, boxes.get(n.id)!)) problems.push(`${e.id}: label is on ${n.id}`);
            }
        }
    }
    return problems;
}
