// The weekly coach's JSON (GET / POST /api/ai/coach): a CoachNote row → the API.
import type { CoachNote } from '@prisma/client';
import { dayFromUtcMidnight } from '../../services/learning';
import { parseStoredCoach, type CoachLines } from '../../services/coach/output';

export interface CoachNoteJson {
    id: string;
    /** 'YYYY-MM-DD': the first and last local days of the week it is about. */
    weekStart: string;
    weekEnd: string;
    lines: CoachLines;
    /** Exactly 3 suggested focus lines (each ≤ 140 characters). */
    focus: string[];
    createdAt: Date;
}

export function serializeCoachNote(row: Pick<CoachNote, 'id' | 'weekStart' | 'weekEnd' | 'lines' | 'focus' | 'createdAt'>): CoachNoteJson {
    const { lines, focus } = parseStoredCoach(row.lines, row.focus);
    return {
        id: row.id,
        weekStart: dayFromUtcMidnight(row.weekStart),
        weekEnd: dayFromUtcMidnight(row.weekEnd),
        lines,
        focus,
        createdAt: row.createdAt,
    };
}
