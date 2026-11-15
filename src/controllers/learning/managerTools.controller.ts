// The manager's last tools (MANAGER_AND_DOCS_PLAN §3.3, stage 4 part 2): reminders, a topic's
// Recall results, and spreading the overdue reviews. Thin: validate, call the service.
import { z } from 'zod';
import { requireUser } from '../../middlwares/auth';
import { agentActor } from '../../services/agent/agentEditLog';
import { spreadBacklog } from '../../services/actions/actions.service';
import { recallResults } from '../../services/recall/recallResults.service';
import { revisionCalendar } from '../../services/learningDb/calendar.service';
import { assertDay } from '../../services/learning/time';
import { cancelReminder, listReminders, setReminder } from '../../services/tasks/taskReminders.service';
import { handler, ok, param, parse } from './common';

/** GET /api/reminders */
export const listRemindersHandler = handler(async (req, res) => {
    ok(res, await listReminders(requireUser(req).id));
});

/** POST /api/reminders { taskId?, title?, at } (201) */
export const setReminderHandler = handler(async (req, res) => {
    const input = parse(
        z
            .object({ taskId: z.string().trim().min(1).max(40).optional(), title: z.string().trim().min(1).max(200).optional(), at: z.string().trim().min(4).max(40) })
            .strict()
            .refine((b) => !!b.taskId !== !!b.title, 'Give a taskId (a reminder on that task) or a title (a new task), not both'),
        req.body
    );
    ok(res, await setReminder(requireUser(req).id, input), 201);
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
