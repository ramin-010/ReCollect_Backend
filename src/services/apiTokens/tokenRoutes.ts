// What a personal access token (an agent) may call, and the scope each call needs. Pure: no
// Express, no database. authMiddleware checks every token request against this list BEFORE the
// route runs, so it doesn't matter which router (or which mount order) handles the path:
// anything not listed answers 403, which is how account, auth, token, user, todo, workspace,
// notification and sharing routes refuse tokens.
//
// Rules of thumb (HOME_DOCS_AGENT_PLAN §3, v1):
//   - GETs need `read`; doc writes `docs:write`; learning writes `learning:write`.
//   - Agents write docs only through /api/agent/docs (live through Hocuspocus, snapshot + Undo):
//     the REST doc writes (editor saves, sharing, collaborators) are cookie-only.
//   - Nothing permanent: no deletes for good (deleting a doc moves it to the 30-day trash, Undo
//     takes it out; emptying the trash is an action that needs his tap, POST /api/actions). Since
//     stage 4 (the manager, MANAGER_AND_DOCS_PLAN §3.2) agents may complete and move revisions,
//     change a few learning settings and projects, each logged with an Undo. Never the daily
//     rollover. Pocket (quick) notes can be added, never read.
//   - Home's Undo / "seen" for agent edits are cookie-only: an agent can't silence its own work.
// A cookie session has every scope and is never checked against this list.
import type { AgentEditKind } from '@prisma/client';
import type { ApiScope } from '../../types/auth';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface TokenRoute {
    method: Method;
    /** Matched against the whole path (no query string), with an optional trailing slash. */
    path: RegExp;
    scope: ApiScope;
    /** A second scope that also opens it (the phone app's `ambient` on the day's picture). */
    also?: ApiScope;
    /** Shown in docs/tests. */
    pattern: string;
}

const SEGMENT = '[^/]+';
/** Doc ids are cuids or old ObjectIds: `/api/docs/shared-by-me` etc. never match. */
const DOC_ID = '[A-Za-z0-9]+';

function route(method: Method, pattern: string, scope: ApiScope, also?: ApiScope): TokenRoute {
    const source = pattern.replace(/:docId\b/g, DOC_ID).replace(/:\w+/g, SEGMENT);
    return { method, path: new RegExp(`^${source}/?$`), scope, pattern, ...(also ? { also } : {}) };
}

export const TOKEN_ROUTES: readonly TokenRoute[] = [
    // Agent API (src/routers/agent.routes.ts)
    route('GET', '/api/agent/docs', 'read'),
    route('GET', '/api/agent/docs/:id', 'read'),
    route('POST', '/api/agent/docs', 'docs:write'),
    route('PATCH', '/api/agent/docs/:id', 'docs:write'),
    route('POST', '/api/agent/docs/:id/append', 'docs:write'),
    route('POST', '/api/agent/docs/:id/replace-section', 'docs:write'),
    route('GET', '/api/agent/docs/:id/outline', 'read'),
    route('GET', '/api/agent/docs/:id/blocks', 'read'),
    route('POST', '/api/agent/docs/:id/blocks', 'docs:write'),
    route('POST', '/api/agent/docs/:id/blocks/move', 'docs:write'),
    route('POST', '/api/agent/docs/:id/blocks/delete', 'docs:write'),
    route('PATCH', '/api/agent/docs/:id/blocks/:blockId', 'docs:write'),
    route('POST', '/api/agent/docs/:id/trash', 'docs:write'),
    route('POST', '/api/agent/docs/:id/restore', 'docs:write'),
    route('POST', '/api/agent/docs/:id/canvas/:canvasId', 'docs:write'),
    route('GET', '/api/agent/docs/:id/preview', 'read'),
    route('GET', '/api/agent/edits', 'read'),

    // Canvas tools: stateless layout and drawing of a board (src/routers/canvas.routes.ts)
    route('POST', '/api/canvas/layout', 'read'),
    route('POST', '/api/canvas/render', 'read'),

    // Docs: read only (src/routers/doc.routes.ts)
    route('GET', '/api/docs', 'read'),
    route('GET', '/api/docs/:docId', 'read'),

    // Learning (src/routers/learning.routes.ts)
    route('GET', '/api/today', 'read'), // without quickNotes for tokens
    route('GET', '/api/learning/settings', 'read'),
    route('GET', '/api/subjects', 'read'),
    route('POST', '/api/subjects', 'learning:write'),
    route('GET', '/api/topics/by-doc/:docId', 'read'),
    route('GET', '/api/topics/statuses', 'read'), // the library's status column: what is due, waiting, mastered
    route('POST', '/api/topics', 'learning:write'),
    route('POST', '/api/revisions/start', 'learning:write'),
    route('GET', '/api/goals', 'read'),
    route('POST', '/api/goals', 'learning:write'),
    route('PATCH', '/api/goals/:id', 'learning:write'),
    route('POST', '/api/goals/:id/milestones', 'learning:write'),
    route('PATCH', '/api/goal-milestones/:id', 'learning:write'),
    route('DELETE', '/api/goal-milestones/:id', 'learning:write'),
    route('GET', '/api/subjects/:id/path', 'read'),
    route('POST', '/api/subjects/:id/path', 'learning:write'),
    route('PATCH', '/api/topics/:id/path', 'learning:write'),
    route('POST', '/api/focus', 'learning:write'),
    route('PATCH', '/api/focus/:id', 'learning:write'),
    route('DELETE', '/api/focus/:id', 'learning:write'),
    route('PUT', '/api/quick-notes/:id', 'learning:write'), // create only, for tokens

    // The record (SYNC_SPINE_SPEC 1.2): a session by its key; reading sessions and projects.
    route('PUT', '/api/sessions/by-key/:key', 'sessions:write'),
    route('GET', '/api/sessions', 'read'),
    route('GET', '/api/projects', 'read'),
    route('GET', '/api/brief', 'read'), // the brief: where the user stands (SYNC_SPINE_SPEC 1.3)

    // The week and suggestions (LOOP_COMPLETE_SPEC 1.6): agents read and set targets, and propose;
    // only the user accepts (the accept / dismiss / decide routes are not listed).
    route('GET', '/api/week', 'read'),
    route('GET', '/api/mirror', 'read'), // where the user stands, per goal and subject (1.7)
    // Personal tasks (4.1): never workspace tasks, attachments or a delete.
    route('GET', '/api/tasks', 'read'),
    route('POST', '/api/tasks', 'tasks:write'),
    route('PATCH', '/api/tasks/:id', 'tasks:write'),
    // The decision journal (4.2).
    route('GET', '/api/decisions', 'read'),
    route('POST', '/api/decisions', 'learning:write'),
    route('PATCH', '/api/decisions/:id', 'learning:write'),
    route('POST', '/api/week/targets', 'learning:write'),
    route('PATCH', '/api/week/targets/:id', 'learning:write'),
    route('GET', '/api/suggestions', 'read'),
    route('POST', '/api/suggestions', 'learning:write'),
    // The manager's tools (stage 4): revisions done or moved, a few settings, projects; actions
    // that need his tap (level 3) are only asked for.
    route('POST', '/api/revisions/:id/complete', 'learning:write'),
    route('POST', '/api/revisions/:id/reschedule', 'learning:write'),
    route('PATCH', '/api/learning/settings', 'learning:write'),
    route('PATCH', '/api/projects/:id', 'sessions:write'),
    route('POST', '/api/actions', 'learning:write'),
    // Stage 4 part 2: reminders, a topic's Recall results, a doc's sharing (read), the spread.
    route('GET', '/api/reminders', 'read'),
    route('POST', '/api/reminders', 'tasks:write'),
    route('POST', '/api/reminders/:id/cancel', 'tasks:write'),
    route('GET', '/api/lock-pins', 'read'),
    route('POST', '/api/lock-pins', 'tasks:write'),
    route('POST', '/api/lock-pins/clear', 'tasks:write'),
    route('GET', '/api/topics/:id/recall', 'read'),
    route('GET', '/api/agent/docs/:id/sharing', 'read'),
    route('POST', '/api/revisions/spread', 'learning:write'),
    // Stage 6: the phone's wallpaper and widget (an automation app fetches them with a read token).
    route('GET', '/api/ambient/widget', 'read', 'ambient'),
    route('GET', '/api/ambient/wallpaper.png', 'read', 'ambient'),
    route('GET', '/api/ambient/styles', 'read', 'ambient'),
    route('POST', '/api/ambient/disconnect', 'ambient'),
    route('POST', '/api/ambient/reminders/scheduled', 'ambient'),
    route('POST', '/api/ambient/later', 'ambient'),
    // The buddy (BUDDY_MEMORY_PLAN §7): a note about the user, his memories, an agent's forget.
    route('POST', '/api/buddy/remember', 'sessions:write'),
    // MCP_MEMORY_PLAN §4.2: progress on, a change to, or the end of something known (update_memory).
    route('POST', '/api/buddy/update', 'sessions:write'),
    route('GET', '/api/buddy/memories', 'read'),
    route('POST', '/api/buddy/memories/:id/close', 'sessions:write'),
    // B2: the hooks send his typed words and fetch the buddy's note for the session.
    route('POST', '/api/buddy/words', 'sessions:write'),
    route('GET', '/api/buddy/note', 'read'),
    // B4: the phone app's "Tell your buddy" and thumbs (its ambient token; nothing else).
    route('POST', '/api/buddy/tell', 'ambient'),
    route('POST', '/api/buddy/asks/:id/answer', 'ambient'),
    route('POST', '/api/buddy/feedback', 'ambient'),
    // Stage 11: the phone app's "Send feedback" and "Send diagnostics" (to the owner's People page).
    route('POST', '/api/feedback', 'ambient'),
    route('POST', '/api/phone/diagnostics', 'ambient'),
    // B7: his months, for recall_memory.
    route('GET', '/api/buddy/chapters', 'read'),
    // Stage 3 of the loop: what is going on in his life (threads), for recall_memory.
    route('GET', '/api/buddy/threads', 'read'),
    // B9: his work log, for get_work_log and Ask AI (removing a line is the app's alone).
    route('GET', '/api/buddy/work', 'read'),
    // Stage 12: what a writer is shown before it logs (Claude Code's log_work).
    route('GET', '/api/buddy/work/picture', 'read'),
    // B10: an agent logs a day's work when he asks (log_work, /log-work).
    route('POST', '/api/buddy/work', 'sessions:write'),
    // Stage 12: one outcome from a connected chat, and the writing app's own changes to its line.
    route('POST', '/api/buddy/work/line', 'sessions:write'),
    route('PATCH', '/api/buddy/work/line/:id', 'sessions:write'),
];

/**
 * Every write a token may make (each TOKEN_ROUTES entry that is not a GET), in exactly one of the
 * two lists below (SYNC_SPINE_SPEC 0.4; tests/unit/agent/agentWrites.test.ts holds them to it).
 *
 * LOGGED: the AgentEditKind the route writes, so it shows under Home's "From your agent" and
 * can be undone (agentEdits.service.ts has one Undo per kind, checked by the type system).
 */
export const LOGGED: Readonly<Record<string, AgentEditKind>> = {
    'POST /api/agent/docs': 'doc_create',
    'PATCH /api/agent/docs/:id': 'doc_update',
    'POST /api/agent/docs/:id/append': 'doc_append',
    'POST /api/agent/docs/:id/replace-section': 'doc_replace_section',
    'POST /api/agent/docs/:id/blocks': 'doc_blocks',
    'POST /api/agent/docs/:id/blocks/move': 'doc_blocks',
    'POST /api/agent/docs/:id/blocks/delete': 'doc_blocks',
    'PATCH /api/agent/docs/:id/blocks/:blockId': 'doc_blocks',
    'POST /api/agent/docs/:id/canvas/:canvasId': 'doc_canvas_update',
    'POST /api/subjects': 'subject_create',
    'POST /api/topics': 'revision_schedule',
    'POST /api/revisions/start': 'revision_schedule',
    'POST /api/goals': 'goal_create',
    'PATCH /api/goals/:id': 'goal_update',
    'POST /api/goals/:id/milestones': 'milestone_add',
    'PATCH /api/goal-milestones/:id': 'milestone_update',
    'DELETE /api/goal-milestones/:id': 'milestone_remove',
    'POST /api/subjects/:id/path': 'path_plan',
    'PATCH /api/topics/:id/path': 'topic_update',
    'POST /api/focus': 'focus_add',
    'PATCH /api/focus/:id': 'focus_update',
    'DELETE /api/focus/:id': 'focus_remove',
    'PUT /api/quick-notes/:id': 'pocket_add',
    'POST /api/week/targets': 'week_target_create',
    'PATCH /api/week/targets/:id': 'week_target_update',
    'POST /api/tasks': 'task_create',
    'PATCH /api/tasks/:id': 'task_update',
    'POST /api/decisions': 'decision_create',
    'PATCH /api/decisions/:id': 'decision_update',
    'POST /api/agent/docs/:id/trash': 'doc_trash',
    'POST /api/agent/docs/:id/restore': 'doc_restore',
    'POST /api/revisions/:id/complete': 'revision_complete',
    'POST /api/revisions/:id/reschedule': 'revision_reschedule',
    'PATCH /api/learning/settings': 'settings_update',
    'PATCH /api/projects/:id': 'project_update',
    'POST /api/reminders': 'reminder_set',
    'POST /api/reminders/:id/cancel': 'reminder_cancel',
    'POST /api/revisions/spread': 'revisions_spread',
    'POST /api/buddy/memories/:id/close': 'memory_close',
};

/** Token writes that are not AgentEdit rows, each with the reason. */
export const SELF_LOGGED: Readonly<Record<string, string>> = {
    'POST /api/canvas/layout': 'stateless: lays a board out and stores nothing',
    'POST /api/canvas/render': 'stateless: draws a board as SVG or PNG and stores nothing',
    'PUT /api/sessions/by-key/:key': 'the session list is its own log (each entry names its writer; the user edits or deletes any); a topic change it asks for is logged as topic_update',
    'POST /api/suggestions': 'a pending suggestion is its own visible record (Home → Suggested, naming who proposed it): nothing changes until the user accepts it, and he can dismiss it',
    'POST /api/actions': 'a pending action is its own visible record (Home → Suggested, "Do it", naming who asked): nothing happens until the user taps it, and he can dismiss it',
    'POST /api/ambient/disconnect': "the phone app ends its own token and nothing else: Settings → Agents shows it as ended",
    'POST /api/ambient/reminders/scheduled': "the phone app says which of the user's reminders it will ring for: no email goes for those; nothing else changes",
    'POST /api/ambient/later': "the user's own tap on Later: one silent reminder of the buddy's on that item, shown with today's reminders (Home's Reminders today), where he can take it back",
    'POST /api/buddy/remember': 'a memory is its own visible record (/you, naming the agent that saved it and its notes); the user edits, marks wrong or forgets any, and no agent can change one he touched',
    'POST /api/buddy/update': 'progress or a mention is a note on its own visible memory (/you); a change or an end is logged as memory_close with an Undo that brings the old version back',
    'POST /api/buddy/tell': "the phone app hands on the user's own words: a note for tonight he sees on /you, nothing changes by it",
    'POST /api/buddy/asks/:id/answer': "the phone app hands on the user's own answer to the buddy's question (a quick answer or his words): the question is answered, as on Home",
    'POST /api/lock-pins': "a pin is its own visible record (it names who set it and shows only in its window, today only unless he named days); clear_lock_line or the user takes it off",
    'POST /api/lock-pins/clear': "takes the user's pinned words off his lock screen (the one showing, one by id, or all); nothing else changes",
    'POST /api/buddy/feedback': "the phone app hands on the user's thumb on a line: a signal for the next night, nothing changes by it",
    'POST /api/feedback': "the phone app hands on the user's own words for the owner of this server (Send feedback): shown on the owner's People page; nothing in the user's data changes",
    'POST /api/phone/diagnostics': "the phone app sends its own facts for the owner's People page (model, Android version, screen size, permissions, last update times; nothing personal); nothing in the user's data changes",
    'POST /api/buddy/words': 'the hooks queue his own typed words for the buddy: scrubbed, digested into notes he sees on /you and suggestions he decides on, then deleted; nothing in the app changes by it',
    'POST /api/buddy/work': "an agent logs a day's work on the user's word: the lines are their own visible record (/you › Your work, each removable and never written again once removed); nothing else changes",
    'POST /api/buddy/work/line': "a connected chat logs one outcome of the user's work: the line is their own visible record (/you › Your work, naming the app; each removable and never written again once removed); nothing else changes",
    'PATCH /api/buddy/work/line/:id': 'the app that wrote a work line folds it into the line it repeats, rewords it the same day, links it to a known line, or removes it on the user\'s word: only its own lines, each still on /you (a fold is kept, a removal is the user\'s own removal); nothing else changes',
};

/** The path of a URL without its query string. */
export function pathOf(url: string): string {
    const end = url.search(/[?#]/);
    return end === -1 ? url : url.slice(0, end);
}

/** Every scope that opens this request (any one is enough), or null when tokens may not call it at all. */
export function tokenRouteScopes(method: string, url: string): readonly ApiScope[] | null {
    const verb = (method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()) as Method;
    const path = pathOf(url);
    const hit = TOKEN_ROUTES.find((r) => r.method === verb && r.path.test(path));
    return hit ? (hit.also ? [hit.scope, hit.also] : [hit.scope]) : null;
}

/** The scope a token needs for this request, or null when tokens may not call it at all. */
export function tokenRouteScope(method: string, url: string): ApiScope | null {
    const verb = (method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()) as Method;
    const path = pathOf(url);
    return TOKEN_ROUTES.find((r) => r.method === verb && r.path.test(path))?.scope ?? null;
}
