// Course numbers typed into titles ("01 · How the web works", "5b · Consistent hashing") read into
// a path's order (SYNC_SPINE_SPEC 1.1; scripts/order-numbered-topics.ts). Pure: no database.

export interface NumberedTitle {
    num: number;
    /** "02.1 · …" → 1; else 0. */
    sub: number;
    /** "5b · …" → "b"; else "". */
    letter: string;
    /** The title without its number. */
    rest: string;
}

/**
 * "01 · Title", "5b · Title", "02. Title", "3 - Title", "12) Title", "02.1 · Title": a number of
 * 1 to 3 digits, an optional .sub and letter, then a separator (· . : ) | - – —) and the title.
 * A number without a separator ("100 days of code") is not a course number.
 */
const PREFIX = /^\s*(\d{1,3})(?:\.(\d{1,2}))?([a-z])?\s*[·.:)|\-–—]\s*(\S.*)$/i;

export function parseNumberedTitle(title: string): NumberedTitle | null {
    const m = PREFIX.exec(title);
    if (!m) return null;
    const rest = m[4]!.trim();
    if (!rest) return null;
    return { num: Number(m[1]), sub: m[2] ? Number(m[2]) : 0, letter: (m[3] ?? '').toLowerCase(), rest };
}

export interface OrderedTopic<T> {
    topic: T;
    parsed: NumberedTitle | null;
}

/**
 * The path order the numbers say: numbered topics first, by number, sub-number and letter (ties
 * keep their current order), then the unnumbered ones in their current order. `topics` comes in
 * the current path order.
 */
export function numberedPathOrder<T extends { title: string }>(topics: readonly T[]): OrderedTopic<T>[] {
    const items = topics.map((topic, i) => ({ topic, parsed: parseNumberedTitle(topic.title), i }));
    const numbered = items.filter((x) => x.parsed).sort((a, b) => {
        const p = a.parsed!;
        const q = b.parsed!;
        return p.num - q.num || p.sub - q.sub || p.letter.localeCompare(q.letter) || a.i - b.i;
    });
    const rest = items.filter((x) => !x.parsed);
    return [...numbered, ...rest].map(({ topic, parsed }) => ({ topic, parsed }));
}
