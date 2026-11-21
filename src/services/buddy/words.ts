// Small word helpers the buddy's writing and reading share (kept apart so voice.ts and think.ts can
// both use them without importing each other).

/**
 * A label in front ("From your notes: …", "Reminder - …", "Tip: …") comes off: the buddy talks, it doesn't
 * file things (the owner, 11-16). The words after it stay, their first letter raised. Applied where a line or
 * note is written and again where one is read (B8: lines saved before the voice fix still had labels).
 */
export function unlabel(text: string): string {
    const t = text.replace(/^\s*(?:from (?:your |his |their )?(?:saved )?notes?|from your buddy|reminder|quick reminder|note|quick note|tip|today|tonight|heads[ -]?up|fyi|psst|ps)\s*[:\-–—]\s+/i, '');
    return t === text ? text : t.charAt(0).toUpperCase() + t.slice(1);
}

/** `unlabel` for a value that may be missing (a note or follow-up). */
export const unlabelOr = (text: string | null | undefined): string | null => (text ? unlabel(text) : (text ?? null));
