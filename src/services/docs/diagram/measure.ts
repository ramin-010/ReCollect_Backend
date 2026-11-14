// How big text is on the board, without a DOM: per-character widths (Arial-like metrics, which
// sit between Segoe UI and SF, plus a safety margin so the browser never wraps a line we didn't),
// and the sizes boxes, arrow labels and zone titles get from their text. The numbers follow the
// browser's canvas CSS (recollect/components/docs/editor/canvas/canvas.css):
//   box text      14px, line-height 1.4, padding 8px 12px (ellipse 18% sides, diamond 22%,
//                 cylinder 22%-of-width top, queue 9% / 16% sides); a kind icon adds 16 + 6 px
//   sticky        14px, line-height 1.45, padding 14px 16px
//   text          16px (s 14, l 20 semibold), padding 4px 6px
//   arrow label   12.5px, line-height 1.35, padding 2px 6px, at most 220 px wide
//   zone title    13px semibold, 8px from the top, 10px from the left
import { SHAPE_SIZES, type CanvasShape, type CanvasTextSize } from '../canvas';

/** Advance widths of ASCII 32–126 in 1/1000 em (Arial). */
const ASCII_WIDTHS = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space … /
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0–9
    278, 278, 584, 584, 584, 556, 1015, // : … @
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, // A–Z
    278, 278, 278, 469, 556, 333, // [ \ ] ^ _ `
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, // a–z
    334, 260, 334, 584, // { | } ~
];

/** The browser's text runs a little wider than Arial on some systems: never under-measure. */
const SAFETY = 1.06;
/** Semibold text (zone titles, large text) is wider still. */
const BOLD = 1.05;

/** Width of one character in em. */
function charEm(code: number): number {
    if (code >= 32 && code <= 126) return ASCII_WIDTHS[code - 32]! / 1000;
    if (code === 0x09) return 1.1;
    // CJK, Hangul, full-width forms and emoji take a full square (emoji a little more).
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) return 1;
    if (code >= 0x1f000 || (code >= 0x2600 && code <= 0x27bf)) return 1.2;
    if (code >= 0x2000 && code <= 0x206f) return 0.7; // dashes, quotes, … •
    return 0.6; // accented Latin and the rest
}

/** The width of one line of text, in px. */
export function textWidth(text: string, fontSize: number, bold = false): number {
    let em = 0;
    for (const ch of text) em += charEm(ch.codePointAt(0)!);
    return em * fontSize * SAFETY * (bold ? BOLD : 1);
}

/**
 * The lines text wraps into at `maxWidth` px, as the browser does (pre-wrap: line breaks kept,
 * breaks at spaces, a word too long for a line breaks anywhere).
 */
export function wrapText(text: string, fontSize: number, maxWidth: number, bold = false): string[] {
    const lines: string[] = [];
    const room = Math.max(maxWidth, 1);
    const fits = (s: string) => textWidth(s, fontSize, bold) <= room;
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (const word of paragraph.split(/(?<=\s)/)) {
            const candidate = line + word;
            if (line && !fits(candidate.trimEnd())) {
                lines.push(line.trimEnd());
                line = word;
            } else {
                line = candidate;
            }
            // A word longer than a whole line breaks anywhere (a character wider than a line stays whole).
            while (!fits(line.trimEnd())) {
                const cut = fittingPrefix(line, fontSize, room, bold);
                if (cut >= line.length) break;
                lines.push(line.slice(0, cut));
                line = line.slice(cut);
            }
        }
        lines.push(line.trimEnd());
    }
    return lines;
}

/** How many UTF-16 units of `text` fit in `maxWidth` (at least one character). */
function fittingPrefix(text: string, fontSize: number, maxWidth: number, bold: boolean): number {
    let width = 0;
    let at = 0;
    for (const ch of text) {
        width += charEm(ch.codePointAt(0)!) * fontSize * SAFETY * (bold ? BOLD : 1);
        if (width > maxWidth && at > 0) return at;
        at += ch.length;
    }
    return Math.max(at, 1);
}

/** The widest line, in px. */
const widest = (text: string, fontSize: number, bold = false): number => Math.max(0, ...text.split('\n').map((l) => textWidth(l, fontSize, bold)));

const MAX_BOX_WIDTH = 240;
const KIND_ICON = 16 + 6;
/** Sizes are rounded up to this grid, so boards line up. */
const GRID = 4;
const up = (n: number): number => Math.ceil(n / GRID) * GRID;

interface TextStyle {
    font: number;
    lineHeight: number;
    bold: boolean;
    /** Horizontal padding (both sides) for a box `w` wide. */
    padX: (w: number) => number;
    /** Vertical padding (both sides) for a box `w` wide. */
    padY: (w: number) => number;
    /** The share of the width text can use (padding that scales with the width). */
    share: number;
}

const BOX_TEXT = { font: 14, lineHeight: 14 * 1.4, bold: false };

/** How each shape holds its text (the CSS above). */
const STYLES: Readonly<Record<Exclude<CanvasShape, 'zone'>, TextStyle>> = {
    rect: { ...BOX_TEXT, padX: () => 24, padY: () => 16, share: 1 },
    rounded: { ...BOX_TEXT, padX: () => 28, padY: () => 16, share: 1 },
    pill: { ...BOX_TEXT, padX: () => 36, padY: () => 16, share: 1 },
    ellipse: { ...BOX_TEXT, padX: () => 0, padY: () => 28, share: 0.64 },
    diamond: { ...BOX_TEXT, padX: () => 0, padY: () => 32, share: 0.56 },
    cylinder: { ...BOX_TEXT, padX: () => 20, padY: (w) => 0.22 * w + 12, share: 1 },
    queue: { ...BOX_TEXT, padX: () => 0, padY: () => 16, share: 0.75 },
    sticky: { font: 14, lineHeight: 14 * 1.45, bold: false, padX: () => 32, padY: () => 28, share: 1 },
    text: { font: 16, lineHeight: 16 * 1.4, bold: false, padX: () => 12, padY: () => 8, share: 1 },
};

/** Diagram stickies hug their text (a 140 px tall note for one line is mostly empty). */
const STICKY_MIN_HEIGHT = 72;

function styleOf(shape: Exclude<CanvasShape, 'zone'>, size: CanvasTextSize | undefined): TextStyle {
    const style = STYLES[shape];
    if (shape !== 'text' || !size || size === 'm') return style;
    return size === 's' ? { ...style, font: 14, lineHeight: 14 * 1.4 } : { ...style, font: 20, lineHeight: 20 * 1.3, bold: true };
}

type Sized = { shape: Exclude<CanvasShape, 'zone'>; text: string; kind?: string | undefined; size?: CanvasTextSize | undefined };

/** The height a box's text and padding take at `width` (no minimum: what the browser grows a box to). */
export function contentHeight(node: Sized, width: number): number {
    const style = styleOf(node.shape, node.size);
    const icon = node.kind ? KIND_ICON : 0;
    const room = Math.max(width * style.share - style.padX(width) - icon, 8);
    const lines = node.text ? wrapText(node.text, style.font, room, style.bold).length : 1;
    return Math.ceil(lines * style.lineHeight + style.padY(width));
}

/**
 * A box's size from its text: as wide as its longest line needs, at least the shape's default and
 * at most 240 px (longer text wraps, and the box grows taller), on a 4 px grid.
 */
export function boxSize(node: Sized): { w: number; h: number } {
    const style = styleOf(node.shape, node.size);
    const base = SHAPE_SIZES[node.shape];
    const minH = node.shape === 'sticky' ? STICKY_MIN_HEIGHT : base.h;
    const icon = node.kind ? KIND_ICON : 0;
    const contentFor = (w: number) => w * style.share - style.padX(w) - icon;
    // The width the text asks for: content = w·share − padX − icon.
    const want = (widest(node.text, style.font, style.bold) + icon + style.padX(base.w)) / style.share;
    const w = up(Math.min(Math.max(want, base.w), MAX_BOX_WIDTH));
    const lines = node.text ? wrapText(node.text, style.font, Math.max(contentFor(w), 8), style.bold).length : 1;
    const h = up(Math.max(minH, lines * style.lineHeight + style.padY(w)));
    return { w, h };
}

const LABEL = { font: 12.5, lineHeight: 12.5 * 1.35, padX: 12, padY: 4, maxContent: 220 - 12 };

/** An arrow label's box (the browser draws it on the line, on the board's colour). */
export function labelSize(text: string): { w: number; h: number } {
    const lines = wrapText(text, LABEL.font, LABEL.maxContent);
    const w = Math.max(...lines.map((l) => textWidth(l, LABEL.font)));
    return { w: Math.ceil(Math.min(w, LABEL.maxContent) + LABEL.padX), h: Math.ceil(lines.length * LABEL.lineHeight + LABEL.padY) };
}

/** Zone frames: the title band at the top, and the inner margin around what the zone holds. */
export const ZONE = { titleTop: 8, titleLeft: 10, titlePad: 4, font: 13, lineHeight: 13 * 1.35, side: 20, bottom: 20, gap: 12 } as const;

/** The title band's height (children start below it), for a title `width` px wide at most. */
export function zoneTitleBand(title: string): { w: number; h: number } {
    if (!title) return { w: 0, h: ZONE.titleTop + 2 };
    const w = widest(title, ZONE.font, true) + 2 * ZONE.titlePad;
    const lines = title.split('\n').length;
    return { w: Math.ceil(w), h: Math.ceil(ZONE.titleTop + 2 + lines * ZONE.lineHeight) };
}

/** The narrowest a zone can be so its title fits on its line(s). */
export function zoneMinWidth(title: string): number {
    const band = zoneTitleBand(title);
    return up(band.w + 2 * ZONE.titleLeft);
}
