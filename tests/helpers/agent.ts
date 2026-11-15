// Personal access tokens and agent requests for integration tests.
import request from 'supertest';
import app from '../../src/app';
import { createApiToken } from '../../src/services/apiTokens/apiTokens.service';
import type { ApiScope } from '../../src/types/auth';

export const ALL_SCOPES: ApiScope[] = ['read', 'docs:write', 'learning:write', 'sessions:write', 'tasks:write'];

/** A real token for the user (the plain `rcl_…` string, as POST /api/tokens returns it once). */
export async function createTestToken(user: { id: string }, scopes: ApiScope[] = ALL_SCOPES, name = 'Claude Code'): Promise<{ token: string; id: string }> {
    const created = await createApiToken(user.id, { name, scopes });
    return { token: created.token, id: created._id };
}

/** Requests authenticated with `Authorization: Bearer <token>` (no cookie), like the MCP server. */
export function asAgent(token: string, agentName?: string) {
    const auth = (req: request.Test) => {
        req.set('Authorization', `Bearer ${token}`);
        if (agentName) req.set('X-Agent-Name', agentName);
        return req;
    };
    return {
        get: (url: string) => auth(request(app).get(url)),
        post: (url: string, body?: object, headers: Record<string, string> = {}) => auth(request(app).post(url)).set(headers).send(body ?? {}),
        put: (url: string, body?: object, headers: Record<string, string> = {}) => auth(request(app).put(url)).set(headers).send(body ?? {}),
        patch: (url: string, body?: object, headers: Record<string, string> = {}) => auth(request(app).patch(url)).set(headers).send(body ?? {}),
        delete: (url: string) => auth(request(app).delete(url)),
    };
}
