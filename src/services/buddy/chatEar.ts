// The buddy's own chat is one of its ears (ECOSYSTEM_V2_PLAN §4.2, E2; stage 3): with the loop on, every
// message he writes there is queued for the buddy with what it said just before (its question, or its
// last answer) and the start of its reply, and read without the gate. A message written while he had
// paused the buddy is marked and never read. A chat that opened with one of the buddy's questions
// closes that question for the day with his first reply (§4.4).
import { prisma } from '../../db/prisma';
import { queueOwnWords } from './capture.service';
import { markReplied } from './asks';
import type { AssistantMessageJson } from '../assistant/threads.service';

/** The question a new chat opened with: his own, still waiting; it is kept on the chat and closed for the day. */
export async function openingAsk(userId: string, chatId: string, askId: string, now: Date = new Date()): Promise<{ id: string; text: string } | null> {
    const ask = await prisma.buddyAsk.findFirst({ where: { id: askId, userId, state: { in: ['open', 'replied'] } }, select: { id: true, text: true } });
    if (!ask) return null;
    await prisma.assistantThread.updateMany({ where: { id: chatId, userId }, data: { askId: ask.id } });
    await markReplied(userId, ask.id, now);
    return ask;
}

/** Queues one of his chat messages for the buddy (the loop on, the buddy on); marks it read or skipped. */
export async function hearChat(userId: string, chatId: string, mine: AssistantMessageJson, ctx: { before: string | null; reply: string; index: number; inDoc?: boolean }, now: Date = new Date()): Promise<void> {
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { enabled: true, paused: true, loop: true } });
    if (!state?.enabled || !state.loop) return;
    if (state.paused) {
        await prisma.assistantMessage.updateMany({ where: { id: mine._id }, data: { buddySkip: true } });
        return;
    }
    const r = await queueOwnWords(
        userId,
        // Asked inside a doc: mostly about the doc, so it goes through the gate like an agent's chat (only the buddy's own chat skips it).
        { key: `ask:${chatId}`, seq: ctx.index + 1, via: ctx.inDoc ? 'doc_ask' : 'ask_ai', messages: [{ at: new Date(mine.createdAt).toISOString(), text: mine.text, ...(ctx.before ? { before: ctx.before } : {}), reply: ctx.reply }] },
        now
    );
    await prisma.assistantMessage.updateMany({ where: { id: mine._id }, data: r.paused ? { buddySkip: true } : { buddyReadAt: now } });
}

/** A pocket note longer than this is a page kept for later, not a thought: the buddy does not read it. */
export const POCKET_HEAR_MAX = 2000;
const LINK_ONLY = /^(?:https?:\/\/|www\.)\S+$/i;

/**
 * His own pocket notes are an ear too (the week's simulation, issue 9: "idea: a CLI that turns my notes into
 * drills" never came back): with the loop on, a new note he jots in the app is read like his words to the
 * buddy, without the gate, so an idea or a plan can open a thread. Not read: a link alone, a note of only
 * attachments, a page pasted in (over POCKET_HEAR_MAX), a note an agent pinned for him (its chat reaches the
 * buddy by its own ear), anything while he has paused the buddy. Secrets are scrubbed as everywhere.
 */
export async function hearPocketNote(userId: string, note: { id: string; content: string }, now: Date = new Date()): Promise<{ queued: number }> {
    const text = note.content.trim();
    if (!text || text.length > POCKET_HEAR_MAX || LINK_ONLY.test(text)) return { queued: 0 };
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { enabled: true, loop: true } });
    if (!state?.enabled || !state.loop) return { queued: 0 };
    const r = await queueOwnWords(userId, { key: `pocket:${note.id}`, seq: 1, via: 'pocket', messages: [{ at: now.toISOString(), text }] }, now);
    return { queued: r.queued };
}
