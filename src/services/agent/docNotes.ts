// Stage 14 (ECOSYSTEM_V2_PLAN, "Docs that keep what helped"): a note a chat adds inside one section of a doc, on the
// owner's yes. Pure rules here (no database, no editor): where it goes (after the paragraph it quotes, else at the
// section's end), whether it repeats what the section already holds (an earlier note, or its own text), and the quiet
// last line that says when and from which app. agentDocs.service.ts and agentBlocks.service.ts apply them under the
// doc's live connection, so two chats saving the same note at once write it once.
//
// STUDY_FLOW_PLAN §4.1 (11-23, the owner: "why there have to be limits, leave it natural"): no cap on how many a day;
// the length is a size guard only (a longer explanation belongs in several sections, or in a section's rewrite).
import { topicStems } from '../buddy/recordRules';
import { lineKey } from '../buddy/workRules';

/** A size guard, not a rule anyone meets: the point, the example that worked, what confused them. */
export const NOTE_MAX = 6000;
/** A note with fewer topic stems than this is compared as plain text (a short term's definition). */
export const NOTE_PLAIN_STEMS = 8;
/**
 * A repeat: this share of the note's topic stems is in one earlier note of the section, or in one of its blocks. The
 * labelled pairs (tests/unit/agent/docNotes.test.ts) set it: the different notes on the same topic shared at most 0.50,
 * so 0.6 refuses none of them (a refused new note loses what helped, the costlier miss); the same note again from a
 * retry or another app is caught, and a paraphrase that keeps under 0.6 of its words is the chat's to see (it reads the
 * section before it offers).
 */
export const NOTE_SAME = 0.6;
/** An earlier note is at most this many blocks before its last line (a note is usually one to three). */
const NOTE_BLOCKS = 3;

/** The quiet last line under a note: "Added 20 Nov from ChatGPT". */
export function noteFooter(day: string, app: string): string {
    return `Added ${day} from ${app.replace(/\s+/g, ' ').trim().slice(0, 60) || 'a chat'}`;
}

/** "20 Nov" in the person's zone. */
export function footerDay(at: Date, tz: string): string {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' }).format(at).replace('.', '');
}

const FOOTER_RE = /^added (\d{1,2} [a-z]{3,4}) from \S/i;

/** A block's text is a note's last line. */
export const isFooter = (text: string): boolean => FOOTER_RE.test(text.trim());

/** The 400 for a note over NOTE_MAX (said to the chat, never to the person). */
export const noteTooLong = (): string =>
    `A note is at most ${NOTE_MAX.toLocaleString('en')} characters: split it over the sections it belongs to, or rework the section with replace_section.`;

/**
 * The section's units for the repeat check: every block on its own (a note's last line is none), and each earlier note
 * as one: the blocks before its last line, back to the note before it, at most NOTE_BLOCKS.
 */
export function sectionUnits(blockTexts: readonly string[]): string[] {
    const units: string[] = [];
    let previous = -1;
    blockTexts.forEach((t, i) => {
        if (!isFooter(t)) {
            units.push(t);
            return;
        }
        const from = Math.max(previous + 1, i - NOTE_BLOCKS);
        if (i - from > 1) units.push(blockTexts.slice(from, i).join('\n'));
        previous = i;
    });
    return units.filter((u) => lineKey(u));
}

/** The share of the note's topic stems found in `other`. */
export function noteShare(note: string, other: string): number {
    const n = topicStems(note);
    if (!n.size) return 0;
    const o = topicStems(other);
    return [...n].filter((w) => o.has(w)).length / n.size;
}

/**
 * Whether the note is already in the section: its words as they are (a short note), or most of its topic in one
 * earlier note or one block (a longer one). The section as a whole is never the measure: a new explanation of the
 * section's topic reuses the section's words.
 */
export function noteRepeats(note: string, blockTexts: readonly string[]): boolean {
    const key = lineKey(note);
    if (!key) return true;
    const units = sectionUnits(blockTexts);
    if (units.some((u) => lineKey(u).includes(key))) return true;
    if (topicStems(note).size < NOTE_PLAIN_STEMS) return false;
    return units.some((u) => noteShare(note, u) >= NOTE_SAME);
}

/**
 * The block the note follows: the first of the section's blocks whose text holds the quoted words (case, punctuation
 * and spacing aside), else -1 (the section's end). An earlier note's own blocks count too.
 */
export function afterIndex(blockTexts: readonly string[], after: string | null | undefined): number {
    const want = lineKey(after ?? '');
    if (!want) return -1;
    return blockTexts.findIndex((t) => lineKey(t).includes(want));
}
