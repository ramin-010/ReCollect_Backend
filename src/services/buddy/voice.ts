// The buddy's voice (BUDDY_MEMORY_PLAN §3.4): which line and note are current. The night step (B3)
// writes them; until then there is nothing to say.

export interface BuddyNoteJson {
    id: string;
    text: string;
    kind: 'note' | 'followUp';
    day: string;
}

/** The newest note or follow-up not yet given to this caller (`after` = the last id it showed), or null. */
export async function nextNoteFor(_userId: string, _after?: string | undefined): Promise<BuddyNoteJson | null> {
    return null;
}
