// Personal access tokens: format, hashing, scopes (src/services/apiTokens), which endpoints accept
// a token (tokenRoutes.ts) and the agent-name header (src/middlwares/auth.ts). No database.
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
    API_TOKEN_DISPLAY_LENGTH,
    generateApiToken,
    hashApiToken,
    isApiTokenFormat,
    normalizeScopes,
    normalizeTokenName,
    serializeApiToken,
    storedScopes,
} from '../../../src/services/apiTokens/apiTokens.service';
import { TOKEN_ROUTES, pathOf, tokenRouteScope } from '../../../src/services/apiTokens/tokenRoutes';
import { agentNameFor } from '../../../src/middlwares/auth';
import ErrorResponse from '../../../src/utils/errorResponse';

describe('token format and hashing', () => {
    it('is rcl_ + 43 base64url characters; only the sha256 hex is stored; the prefix is 12 characters', () => {
        const { token, tokenHash, prefix } = generateApiToken();
        expect(token).toMatch(/^rcl_[A-Za-z0-9_-]{43}$/);
        expect(isApiTokenFormat(token)).toBe(true);
        expect(tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
        expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(prefix).toBe(token.slice(0, API_TOKEN_DISPLAY_LENGTH));
        expect(prefix).toMatch(/^rcl_.{8}$/);
    });

    it('every token is new', () => {
        const tokens = new Set(Array.from({ length: 200 }, () => generateApiToken().token));
        expect(tokens.size).toBe(200);
    });

    it('hashing is stable and differs per token', () => {
        const a = generateApiToken().token;
        expect(hashApiToken(a)).toBe(hashApiToken(a));
        expect(hashApiToken(a)).not.toBe(hashApiToken(`${a.slice(0, -1)}x`));
    });

    it('rejects strings that are not our tokens', () => {
        for (const bad of ['', 'rcl_', 'rcl_short', `abc_${'a'.repeat(43)}`, `rcl_${'a'.repeat(42)}!`, `rcl_${'a'.repeat(44)}`]) {
            expect(isApiTokenFormat(bad), bad).toBe(false);
        }
    });

    it('the JSON never contains the hash', () => {
        const row = { id: 't1', userId: 'u', name: 'Claude', tokenHash: 'secret-hash', prefix: 'rcl_abcdefgh', scopes: ['read', 'bogus'], lastUsedAt: null, revokedAt: null, createdAt: new Date(0), expiresAt: null, oauthClientId: null };
        const json = serializeApiToken(row);
        expect(json).toEqual({ _id: 't1', name: 'Claude', prefix: 'rcl_abcdefgh', scopes: ['read'], lastUsedAt: null, revokedAt: null, createdAt: new Date(0), signIn: false });
        expect(JSON.stringify(json)).not.toContain('secret-hash');
    });
});

describe('scopes and names', () => {
    it('validates, de-duplicates and orders scopes', () => {
        expect(normalizeScopes(['learning:write', 'read', 'read'])).toEqual(['read', 'learning:write']);
        expect(normalizeScopes(['docs:write'])).toEqual(['docs:write']);
    });

    it('400 for no scopes or unknown ones', () => {
        for (const bad of [undefined, [], 'read', ['admin'], ['read', 7]]) {
            expect(() => normalizeScopes(bad), String(bad)).toThrow(ErrorResponse);
        }
    });

    it('stored scopes keep only known values', () => {
        expect(storedScopes(['read', 'docs:write', 'everything'])).toEqual(['read', 'docs:write']);
    });

    it('a name is trimmed, required and at most 100 characters', () => {
        expect(normalizeTokenName('  Claude Code  ')).toBe('Claude Code');
        expect(() => normalizeTokenName('   ')).toThrow('A token needs a name');
        expect(() => normalizeTokenName(42)).toThrow(ErrorResponse);
        expect(() => normalizeTokenName('x'.repeat(101))).toThrow(/at most 100/);
    });

    it('the agent name is the X-Agent-Name header (cleaned, ≤ 60) or the token name', () => {
        expect(agentNameFor('Claude Code', 'laptop token')).toBe('Claude Code');
        expect(agentNameFor(undefined, 'laptop token')).toBe('laptop token');
        expect(agentNameFor('  \u0000 ', 'laptop token')).toBe('laptop token');
        expect(agentNameFor('a\nb\tc', 'x')).toBe('a b c');
        expect(agentNameFor('y'.repeat(80), 'x')).toHaveLength(60);
        expect(agentNameFor(['array'], '')).toBe('agent');
    });
});

describe('which endpoints accept a token (tokenRoutes.ts)', () => {
    it.each([
        ['GET', '/api/agent/docs?query=locks', 'read'],
        ['GET', '/api/agent/docs/abc123', 'read'],
        ['POST', '/api/agent/docs', 'docs:write'],
        ['POST', '/api/agent/docs/abc123/append', 'docs:write'],
        ['POST', '/api/agent/docs/abc123/replace-section', 'docs:write'],
        ['GET', '/api/agent/edits', 'read'],
        // Stage 4 (the manager): logged, undoable; emptying the trash is only asked for.
        ['POST', '/api/agent/docs/abc123/trash', 'docs:write'],
        ['POST', '/api/revisions/r1/complete', 'learning:write'],
        ['POST', '/api/revisions/r1/reschedule', 'learning:write'],
        ['PATCH', '/api/learning/settings', 'learning:write'],
        ['PATCH', '/api/projects/p1', 'sessions:write'],
        ['POST', '/api/actions', 'learning:write'],
        ['GET', '/api/docs', 'read'],
        ['GET', '/api/docs/cm0abc123', 'read'],
        ['HEAD', '/api/docs/cm0abc123', 'read'],
        ['GET', '/api/today', 'read'],
        ['GET', '/api/today/', 'read'],
        ['GET', '/api/subjects', 'read'],
        ['POST', '/api/subjects', 'learning:write'],
        ['GET', '/api/topics/by-doc/doc1', 'read'],
        ['POST', '/api/topics', 'learning:write'],
        ['POST', '/api/revisions/start', 'learning:write'],
        ['GET', '/api/goals', 'read'],
        ['POST', '/api/goals', 'learning:write'],
        ['PATCH', '/api/goals/g1', 'learning:write'],
        ['POST', '/api/goals/g1/milestones', 'learning:write'],
        ['PATCH', '/api/goal-milestones/m1', 'learning:write'],
        ['DELETE', '/api/goal-milestones/m1', 'learning:write'],
        ['POST', '/api/focus', 'learning:write'],
        ['PATCH', '/api/focus/f1', 'learning:write'],
        ['DELETE', '/api/focus/f1', 'learning:write'],
        ['PUT', '/api/quick-notes/7d9f1c2e-1111-4222-8333-944455556666', 'learning:write'],
        // The buddy: a note, reading memories, an agent's forget (logged, undoable).
        ['POST', '/api/buddy/remember', 'sessions:write'],
        ['GET', '/api/buddy/memories', 'read'],
        ['POST', '/api/buddy/memories/m1/close', 'sessions:write'],
        ['GET', '/api/buddy/chapters', 'read'],
    ])('%s %s needs %s', (method, url, scope) => {
        expect(tokenRouteScope(method, url)).toBe(scope);
    });

    it.each([
        // account, auth, tokens, users
        ['GET', '/api/get-me'],
        ['GET', '/api/profile'],
        ['PATCH', '/api/update-profile'],
        ['DELETE', '/api/account'],
        ['POST', '/api/change-password'],
        ['GET', '/api/user/settings'],
        ['GET', '/api/search'],
        ['GET', '/api/tokens'],
        ['POST', '/api/tokens'],
        ['DELETE', '/api/tokens/t1'],
        ['POST', '/api/otp/generate-auth'],
        // Home's control over agent edits
        ['POST', '/api/agent/edits/e1/undo'],
        ['POST', '/api/agent/edits/seen'],
        ['GET', '/api/agent/doc-activity'],
        // doc writes outside the agent API, sharing
        ['POST', '/api/docs'],
        ['POST', '/api/docs/abc123'],
        ['PATCH', '/api/docs/abc123'],
        ['DELETE', '/api/docs/abc123'],
        ['GET', '/api/docs/shared-by-me'],
        ['GET', '/api/docs/pending-requests'],
        ['GET', '/api/docs/abc123/requests'],
        ['POST', '/api/create-doc-link'],
        ['POST', '/api/docs/ai/generate'],
        // learning: deletes, the user's own actions, private notes, settings
        ['DELETE', '/api/goals/g1'],
        ['PATCH', '/api/quick-notes/q1'],
        ['DELETE', '/api/quick-notes/q1'],
        ['DELETE', '/api/subjects/s1'],
        ['PATCH', '/api/subjects/s1'],
        ['DELETE', '/api/topics/t1'],
        ['POST', '/api/revisions/r1/uncomplete'],
        ['POST', '/api/revisions/fresh-start'],
        ['POST', '/api/learning/ensure-today'],
        ['POST', '/api/captures'],
        ['GET', '/api/captures'],
        // the buddy: his own changes, settings, the page and the export are the app's
        ['POST', '/api/buddy/memories'],
        ['PATCH', '/api/buddy/memories/m1'],
        ['DELETE', '/api/buddy/memories/m1'],
        ['GET', '/api/buddy/settings'],
        ['PATCH', '/api/buddy/settings'],
        ['GET', '/api/buddy/you'],
        ['GET', '/api/buddy/export'],
        // other modules
        ['GET', '/api/todos'],
        ['GET', '/api/workspaces'],
        ['GET', '/api/notifications'],
        ['GET', '/api/recent-visits'],
        ['POST', '/api/collab/upload'],
        // look-alikes
        ['GET', '/api/todayx'],
        ['GET', '/api/agent/docs/a/b'],
        ['GET', '/API/TODAY'],
    ])('%s %s is refused', (method, url) => {
        expect(tokenRouteScope(method, url)).toBeNull();
    });

    it('every listed route is under /api and has a scope; only GETs and the stateless canvas tools need just read', () => {
        // POSTs that store nothing: a board in, its layout or its picture out.
        const statelessPosts = ['/api/canvas/layout', '/api/canvas/render'];
        for (const route of TOKEN_ROUTES) {
            expect(route.pattern.startsWith('/api/')).toBe(true);
            expect(['read', 'docs:write', 'learning:write', 'sessions:write', 'tasks:write', 'ambient']).toContain(route.scope);
            if (route.scope === 'ambient') continue; // the phone app's own door (its Disconnect), below
            expect(route.method === 'GET' || statelessPosts.includes(route.pattern)).toBe(route.scope === 'read');
        }
        // `ambient` alone opens only the phone app's own doors (Disconnect, the reminders it rings for, Tell your buddy, a thumb); elsewhere it rides along with `read`.
        expect(TOKEN_ROUTES.filter((r) => r.scope === 'ambient').map((r) => `${r.method} ${r.pattern}`)).toEqual(['POST /api/ambient/disconnect', 'POST /api/ambient/reminders/scheduled', 'POST /api/buddy/tell', 'POST /api/buddy/feedback']);
    });

    it('pathOf drops the query string', () => {
        expect(pathOf('/api/agent/docs?query=a/b')).toBe('/api/agent/docs');
        expect(pathOf('/api/today')).toBe('/api/today');
    });
});
