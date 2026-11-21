// update_memory on a thread (MCP_MEMORY_PLAN §4.3, stage 2): the event is added by code, with whose word it is and
// the time it was said, and no model call. It raises the thread's revision (a question or line written before it is
// withdrawn when it would show); said progress or an end answers the thread's open question. An inference is history
// and a marked note only (§4.4).
import { prisma } from '../../db/prisma';
import type { DayString } from '../learning';
import { toDbDay } from '../learningDb/common';
import type { Basis, SaidTime } from './recordRules';
import type { RecordWriter, UpdateInput, UpdateResult } from './record.service';
import { addThreadEvent, withPersonLock, type EventKind } from './threads';

/** Said updates that answer the thread's open question (as the digest's `answered` does). */
const ANSWERS = new Set(['done', 'skipped', 'progress', 'finished', 'dropped']);
const OPEN = new Set(['noticed', 'active', 'committed']);

export async function updateThreadRecord(w: RecordWriter, input: UpdateInput, said: SaidTime, basis: Basis, _ctx: { today: DayString; tz: string }, now: Date): Promise<UpdateResult & { thread?: { _id: string; title: string; stage: string } }> {
    const userId = w.actor.userId;
    return withPersonLock(userId, async (tx) => {
        const thread = await tx.buddyThread.findFirstOrThrow({ where: { id: input.on, userId } });
        const wasOpen = OPEN.has(thread.stage);
        // The record first: the note, dated and sourced (R1, R3), then the event that rests on it.
        const note = await tx.observation.create({
            data: {
                userId,
                text: input.text,
                kind: 'thread',
                sensitivity: thread.sensitive ? 'private' : 'open',
                source: w.source,
                agentName: w.actor.agentName,
                sessionKey: w.sessionKey ?? null,
                project: w.project ?? null,
                day: toDbDay(said.day),
                saidAt: said.at,
                dayOnly: said.dayOnly,
                via: w.via,
                basis,
                updateKind: input.update,
                memoryId: thread.memoryId ?? null,
            },
            select: { id: true },
        });
        const outcome = await addThreadEvent(
            tx,
            userId,
            thread,
            {
                kind: input.update as EventKind,
                text: input.text,
                saidAt: said.at,
                forDay: said.day,
                direct: false,
                via: (w.via ?? 'agent').slice(0, 20),
                originKey: `update:${note.id}`,
                observationId: note.id,
                basis,
                dayOnly: said.dayOnly,
                receivedAt: now,
            },
            now
        );
        const after = await tx.buddyThread.findUniqueOrThrow({ where: { id: thread.id }, select: { id: true, title: true, stage: true } });
        const shape = { _id: after.id, title: after.title, stage: after.stage };
        if (outcome !== 'added') return { paused: false, target: 'thread', outcome: 'repeat', thread: shape };
        if (basis === 'inferred') return { paused: false, target: 'thread', outcome: 'noted', thread: shape };
        // The question it answers: the thread's open one (§4.3), when the person said how it went.
        if (ANSWERS.has(input.update)) {
            await tx.buddyAsk.updateMany({ where: { userId, threadId: thread.id, state: { in: ['open', 'replied'] } }, data: { state: 'answered', answeredAt: now, answer: input.text.slice(0, 300) } });
        }
        const isOpenNow = OPEN.has(after.stage);
        const result = wasOpen && !isOpenNow ? 'closed' : !wasOpen && isOpenNow ? 'reopened' : 'seen';
        return { paused: false, target: 'thread', outcome: result, thread: shape };
    });
}

/** The thread an id names, if any (update_memory's `on` may name a thread). */
export const threadOf = (userId: string, id: string) => prisma.buddyThread.findFirst({ where: { id, userId }, select: { id: true } });
