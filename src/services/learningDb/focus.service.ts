// Focus lines (LOOP_V2_SPEC §3): up to 3 short lines per local day, no times. Owner only: another
// user's id is a 404 `Not found`. Writes that add a line lock the user row, so two quick adds can
// never make a 4th (409 FOCUS_LIMIT).
import type { FocusItem } from '@prisma/client';
import { prisma, type TxClient } from '../../db/prisma';
import { addDays, type DayString } from '../learning';
import { conflict, notFound } from '../learning/http';
import { serializeFocusItem, type FocusItemJson } from '../../db/serializers/learning';
import { fromDbDay, lockLearningContext, toDbDay } from './common';
import { poke } from '../scheduler/scheduler';

export const FOCUS_LIMIT = 3;
export const FOCUS_TEXT_MAX = 140;

const focusOrder = [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }];

/** Same line, ignoring case and spacing (so carrying over twice does not duplicate). */
const sameText = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

function focusLimitError() {
    return conflict(`Up to ${FOCUS_LIMIT} focus lines a day`, 'FOCUS_LIMIT');
}

async function dayItems(tx: TxClient, userId: string, day: DayString): Promise<FocusItem[]> {
    return tx.focusItem.findMany({ where: { userId, day: toDbDay(day) }, orderBy: focusOrder });
}

const nextSortOrder = (items: readonly FocusItem[]): number => items.reduce((max, i) => Math.max(max, i.sortOrder + 1), 0);

/** POST /api/focus {text} → a line for the user's today (201). */
export async function createFocusItem(userId: string, text: string, now: Date = new Date()): Promise<FocusItemJson> {
    const row = await prisma.$transaction(async (tx) => {
        const ctx = await lockLearningContext(tx, userId, now);
        const items = await dayItems(tx, userId, ctx.today);
        if (items.length >= FOCUS_LIMIT) throw focusLimitError();
        return tx.focusItem.create({ data: { userId, day: toDbDay(ctx.today), text: text.trim(), sortOrder: nextSortOrder(items) } });
    });
    return serializeFocusItem(row);
}

/** PATCH /api/focus/:id {text?, done?} */
export async function updateFocusItem(userId: string, id: string, input: { text?: string | undefined; done?: boolean | undefined }): Promise<FocusItemJson> {
    const { count } = await prisma.focusItem.updateMany({
        where: { id, userId },
        data: {
            ...(input.text !== undefined ? { text: input.text.trim() } : {}),
            // When it was ticked: the buddy's day reacts to it (11-22); unticked, it has no time.
            ...(input.done !== undefined ? { done: input.done, doneAt: input.done ? new Date() : null } : {}),
        },
    });
    if (count === 0) throw notFound();
    if (input.done) poke('buddy'); // 11-22: a ticked line wakes the buddy's day
    return serializeFocusItem(await prisma.focusItem.findUniqueOrThrow({ where: { id } }));
}

/** DELETE /api/focus/:id */
export async function deleteFocusItem(userId: string, id: string): Promise<{ deleted: true }> {
    const { count } = await prisma.focusItem.deleteMany({ where: { id, userId } });
    if (count === 0) throw notFound();
    return { deleted: true };
}

/**
 * POST /api/focus/carry-over {ids}: copies earlier days' unfinished lines (normally yesterday's,
 * as GET /api/today offers them) to today, in their order, within the limit. Lines that are done,
 * already today's, or already on today's list (same text) are skipped. Every id must be the
 * user's (404 otherwise). When today is full and something could be carried: 409 FOCUS_LIMIT.
 */
export async function carryOverFocus(userId: string, ids: readonly string[], now: Date = new Date()): Promise<{ items: FocusItemJson[]; carried: number }> {
    const unique = [...new Set(ids)];
    return prisma.$transaction(async (tx) => {
        const ctx = await lockLearningContext(tx, userId, now);
        const rows = await tx.focusItem.findMany({ where: { id: { in: unique }, userId } });
        if (rows.length !== unique.length) throw notFound();

        const todays = await dayItems(tx, userId, ctx.today);
        const seen = new Set(todays.map((i) => sameText(i.text)));
        const eligible: FocusItem[] = [];
        const sorted = [...rows].sort((a, b) => a.day.getTime() - b.day.getTime() || a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime());
        for (const r of sorted) {
            if (r.done || fromDbDay(r.day) >= ctx.today || seen.has(sameText(r.text))) continue;
            seen.add(sameText(r.text));
            eligible.push(r);
        }

        const room = FOCUS_LIMIT - todays.length;
        if (eligible.length > 0 && room <= 0) throw focusLimitError();
        const copies = eligible.slice(0, Math.max(0, room));
        let sortOrder = nextSortOrder(todays);
        for (const r of copies) {
            await tx.focusItem.create({ data: { userId, day: toDbDay(ctx.today), text: r.text, sortOrder: sortOrder++ }, select: { id: true } });
        }
        const after = copies.length > 0 ? await dayItems(tx, userId, ctx.today) : todays;
        return { items: after.map(serializeFocusItem), carried: copies.length };
    });
}

/**
 * GET /api/today `focus`, from the focus rows of the last days (any order): today's lines, and
 * yesterday's unfinished ones that are not on today's list yet (same text).
 */
export function focusForToday(rows: readonly FocusItem[], today: DayString): { items: FocusItemJson[]; carryOver: FocusItemJson[] } {
    const yesterday = addDays(today, -1);
    const ordered = [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
    const items = ordered.filter((r) => fromDbDay(r.day) === today);
    const onToday = new Set(items.map((i) => sameText(i.text)));
    const carryOver = ordered.filter((r) => fromDbDay(r.day) === yesterday && !r.done && !onToday.has(sameText(r.text)));
    return { items: items.map(serializeFocusItem), carryOver: carryOver.map(serializeFocusItem) };
}
