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
//   - No deletes in v1, and nothing that fakes Ramin's own actions (completing revisions, the
//     daily rollover, settings). Pocket (quick) notes can be added, never read.
//   - Home's Undo / "seen" for agent edits are cookie-only: an agent can't silence its own work.
// A cookie session has every scope and is never checked against this list.
import type { ApiScope } from '../../types/auth';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface TokenRoute {
    method: Method;
    /** Matched against the whole path (no query string), with an optional trailing slash. */
    path: RegExp;
    scope: ApiScope;
    /** Shown in docs/tests. */
    pattern: string;
}

const SEGMENT = '[^/]+';
/** Doc ids are cuids or old ObjectIds: `/api/docs/shared-by-me` etc. never match. */
const DOC_ID = '[A-Za-z0-9]+';

function route(method: Method, pattern: string, scope: ApiScope): TokenRoute {
    const source = pattern.replace(/:docId\b/g, DOC_ID).replace(/:\w+/g, SEGMENT);
    return { method, path: new RegExp(`^${source}/?$`), scope, pattern };
}

export const TOKEN_ROUTES: readonly TokenRoute[] = [
    // Agent API (src/routers/agent.routes.ts)
    route('GET', '/api/agent/docs', 'read'),
    route('GET', '/api/agent/docs/:id', 'read'),
    route('POST', '/api/agent/docs', 'docs:write'),
    route('POST', '/api/agent/docs/:id/append', 'docs:write'),
    route('POST', '/api/agent/docs/:id/replace-section', 'docs:write'),
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
];

/** The path of a URL without its query string. */
export function pathOf(url: string): string {
    const end = url.search(/[?#]/);
    return end === -1 ? url : url.slice(0, end);
}

/** The scope a token needs for this request, or null when tokens may not call it at all. */
export function tokenRouteScope(method: string, url: string): ApiScope | null {
    const verb = (method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()) as Method;
    const path = pathOf(url);
    return TOKEN_ROUTES.find((r) => r.method === verb && r.path.test(path))?.scope ?? null;
}
