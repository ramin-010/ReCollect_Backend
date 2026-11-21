// The manager's last tools (MANAGER_AND_DOCS_PLAN §3.3, stage 4 part 2): reminders, a topic's
// Recall results, and spreading the overdue reviews. Thin: validate, call the service.
import { z } from 'zod';
import { requireUser } from '../../middlwares/auth';
import { agentActor } from '../../services/agent/agentEditLog';
import { ASK_AI_AGENT, spreadBacklog } from '../../services/actions/actions.service';
import { recallResults } from '../../services/recall/recallResults.service';
import { revisionCalendar } from '../../services/learningDb/calendar.service';
import { assertDay } from '../../services/learning/time';
import { cancelReminder, listReminders, setReminder } from '../../services/tasks/taskReminders.service';
import { clearLockPins, listLockPins, setLockPin } from '../../services/reminders/lockPins.service';
import { homeReminders } from '../../services/ambient/ambient.service';
import { handler, ok, param, parse } from './common';

/** GET /api/reminders */
export const listRemindersHandler = handler(async (req, res) => {
    ok(res, await listReminders(requireUser(req).id));
});

/** GET /api/reminders/today (the app's Home, stage 7): today's reminders as his home screens show them (a silent one until 2 hours past its time; the buddy's own too) */
export const todayRemindersHandler = handler(async (req, res) => {
    ok(res, await homeReminders(requireUser(req).id));
});

/** POST /api/reminders { taskId?, title?, at } (201) */
export const setReminderHandler = handler(async (req, res) => {
    const input = parse(
        z
            .object({
                taskId: z.string().trim().min(1).max(40).optional(),
                title: z.string().trim().min(1).max(200).optional(),
                at: z.string().trim().min(4).max(40),
                // Stage 7: true rings (his alarm); otherwise silent. A repeat makes a series until cancelled:
                // daily, weekdays, weekly or chosen days ("mon,wed,fri"; the service reads and checks it).
                ring: z.boolean().optional(),
                repeat: z.string().trim().min(2).max(60).optional(),
            })
            .strict()
            .refine((b) => !!b.taskId !== !!b.title, 'Give a taskId (a reminder on that task) or a title (a new task), not both'),
        req.body
    );
    // The chat and agents (a token, the in-app Ask AI's too) set silent ones unless he said alarm or ring; his own call rings.
    ok(res, await setReminder(requireUser(req).id, { ...input, ring: input.ring ?? req.auth?.via !== 'token' }), 201);
});

/** GET /api/lock-pins (stage 7): his pins not cleared, newest first, each saying whether it shows now. */
export const listLockPinsHandler = handler(async (req, res) => {
    ok(res, await listLockPins(requireUser(req).id));
});

/** POST /api/lock-pins {text, from?, to?, days?, until?} (stage 7): his words on the lock screen for a window. */
export const setLockPinHandler = handler(async (req, res) => {
    const input = parse(
        z
            .object({
                text: z.string().trim().min(1).max(120),
                from: z.string().trim().max(5).optional(),
                to: z.string().trim().max(5).optional(),
                days: z.union([z.enum(['weekdays', 'weekends']), z.array(z.number().int().min(0).max(6)).max(7)]).optional(),
                until: z.string().trim().max(10).optional(),
            })
            .strict(),
        req.body
    );
    // Who set it: an agent's token, the in-app chat (Ask AI), or he himself.
    const actor = agentActor(req);
    const by = req.auth?.via !== 'token' ? { setBy: 'you' as const } : { setBy: actor.agentName === ASK_AI_AGENT ? ('ask_ai' as const) : ('agent' as const), agentName: actor.agentName };
    ok(res, await setLockPin(requireUser(req).id, input, by), 201);
});

/** POST /api/lock-pins/clear {id?, all?} (stage 7): the pin showing now, one by id, or all of them. */
export const clearLockPinsHandler = handler(async (req, res) => {
    const input = parse(z.object({ id: z.string().trim().min(1).max(40).optional(), all: z.boolean().optional() }).strict(), req.body ?? {});
    ok(res, await clearLockPins(requireUser(req).id, input));
});

/** POST /api/reminders/:id/cancel */
export const cancelReminderHandler = handler(async (req, res) => {
    ok(res, await cancelReminder(requireUser(req).id, param(req, 'id')));
});

/** GET /api/topics/:id/recall (?by=doc: the id is the topic's doc) */
export const recallResultsHandler = handler(async (req, res) => {
    const by = z.enum(['topic', 'doc']).optional().parse(req.query['by'] || undefined);
    ok(res, await recallResults(requireUser(req).id, param(req, 'id'), by));
});

/** POST /api/revisions/spread { reason? } → { moved, spreadDays, changes, asked, card } */
export const spreadBacklogHandler = handler(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().max(200).nullable().optional() }).strict(), req.body ?? {});
    const user = requireUser(req);
    ok(res, await spreadBacklog(user.id, agentActor(req).agentName, reason));
});

/** GET /api/revisions/calendar?from=YYYY-MM-DD&days=42: each day's reviews and tasks against the budget. */
export const revisionCalendarHandler = handler(async (req, res) => {
    const from = req.query['from'] ? assertDay(String(req.query['from'])) : undefined;
    const days = req.query['days'] ? Number(req.query['days']) : undefined;
    ok(res, await revisionCalendar(requireUser(req).id, { from, days }));
});
