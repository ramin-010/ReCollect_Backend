// STUDY_FLOW_PLAN (11-23): a lesson's notes and links, and its revision card, for agents. Thin: validate with zod, call
// agentNotes.service.ts / docCard.ts. The card's read for the app (cookie) is here too.
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { agentActor } from '../services/agent/agentEditLog';
import { NOTE_TEXT_MAX, NOTE_TITLE_MAX, addNoteForAgent, listNotesForAgent, removeNoteForAgent, updateNoteForAgent } from '../services/agent/agentNotes.service';
import { CARD_MAX, readRevisionCard, setRevisionCard } from '../services/agent/docCard';
import { handler, ok, param, parse, zId } from './learning/common';

const title = z.string().trim().min(1, 'A note needs a title').max(NOTE_TITLE_MAX * 2);
const markdown = z.string().max(NOTE_TEXT_MAX * 2);
const url = z.string().trim().max(2048);
const subject = z.string().trim().min(1).max(100);

const addSchema = z
    .object({ docId: zId.optional(), subject: subject.optional(), title, markdown: markdown.optional(), url: url.optional() })
    .refine((v) => !!v.docId !== !!v.subject, 'Give docId (a lesson) or subject (its name), one of them');

/** POST /api/agent/notes { docId | subject, title, markdown?, url? } */
export const addNote = handler(async (req, res) => {
    ok(res, await addNoteForAgent(agentActor(req), parse(addSchema, req.body)), 201);
});

const listSchema = z.object({
    docId: zId.optional(),
    subject: subject.optional(),
    lessons: z.enum(['1', '0', 'true', 'false']).optional(),
    ids: z.string().max(4000).optional(),
    cursor: z.coerce.number().int().min(0).max(100_000).optional(),
});

/** GET /api/agent/notes ?docId= | subject= [&lessons=1] | ids=a,b [&cursor=n] */
export const listNotes = handler(async (req, res) => {
    const q = parse(listSchema, req.query);
    const ids = q.ids
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 100);
    if (!ids?.length && !q.docId && !q.subject) {
        ok(res, { place: null, notes: [], more: null, message: 'Say which notes: docId (a lesson), subject, or ids.' });
        return;
    }
    ok(res, await listNotesForAgent(requireUser(req).id, { docId: q.docId, subject: q.subject, lessons: q.lessons === '1' || q.lessons === 'true', ids, cursor: q.cursor }));
});

const updateSchema = z
    .object({ title: title.optional(), markdown: markdown.optional(), url: url.nullable().optional(), docId: zId.optional(), subject: subject.optional() })
    .refine((v) => !(v.docId && v.subject), 'Move it to a lesson (docId) or a subject, not both');

/** PATCH /api/agent/notes/:id { title?, markdown?, url?, docId? | subject? } */
export const updateNote = handler(async (req, res) => {
    ok(res, await updateNoteForAgent(agentActor(req), param(req, 'id'), parse(updateSchema, req.body)));
});

const removeSchema = z.object({ into: zId.optional() });

/** POST /api/agent/notes/:id/remove { into? } */
export const removeNote = handler(async (req, res) => {
    ok(res, await removeNoteForAgent(agentActor(req), param(req, 'id'), parse(removeSchema, req.body ?? {})));
});

const cardSchema = z.object({ markdown: z.string().min(1, 'The card is empty').max(CARD_MAX * 2) });

/** PUT /api/agent/docs/:id/card { markdown } */
export const putCard = handler(async (req, res) => {
    ok(res, await setRevisionCard(agentActor(req), param(req, 'id'), parse(cardSchema, req.body).markdown));
});

/** GET /api/docs/:id/card (the app): the card to draw read-only, and its review. */
export const getCard = handler(async (req, res) => {
    ok(res, await readRevisionCard(requireUser(req).id, param(req, 'id')));
});
