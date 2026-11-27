// TOOL_ACCESS_PLAN §6.6 (2): a token's row is kept 10 seconds in the process (each web tool call checks its token at
// /mcp and again at every API call it makes). Repeated calls read the row once; a revoke takes effect at once; the
// row is read again after 10 seconds or once the cache is cleared; unknown tokens are never kept.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { TOKEN_CACHE_MS, findApiToken, forgetCachedApiTokens } from '../../src/services/apiTokens/apiTokens.service';
import { authCookie, createTestUser } from '../helpers/auth';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    process.env['TOKEN_CACHE_IN_TESTS'] = '1';
});
afterAll(() => {
    delete process.env['TOKEN_CACHE_IN_TESTS'];
    forgetCachedApiTokens();
});
afterEach(() => {
    vi.restoreAllMocks();
    forgetCachedApiTokens();
});

describe('the token cache (TOOL_ACCESS_PLAN §6.6)', () => {
    it('reads a token once for many calls; a revoke stops it at once', async () => {
        const user = await createTestUser();
        const { token, id } = await createTestToken(user);
        const reads = vi.spyOn(prisma.apiToken, 'findUnique');
        const agent = asAgent(token);
        for (let i = 0; i < 4; i++) expect((await agent.get('/api/agent/edits')).status).toBe(200);
        expect(reads.mock.calls.length).toBe(1);
        expect((await request(app).delete(`/api/tokens/${id}`).set('Cookie', authCookie(user))).status).toBe(200);
        expect((await agent.get('/api/agent/edits')).status).toBe(401);
    });

    it('a row changed behind it is seen after 10 seconds, or once cleared; an unknown token is never kept', async () => {
        const user = await createTestUser();
        const { token, id } = await createTestToken(user);
        const t0 = Date.now();
        expect((await findApiToken(token, prisma, t0))?.expiresAt).toBeNull();
        await prisma.apiToken.update({ where: { id }, data: { expiresAt: new Date(t0 - 1000) } });
        // Within the 10 seconds: the kept row.
        expect((await findApiToken(token, prisma, t0 + 5_000))?.expiresAt).toBeNull();
        // After them: read again.
        expect((await findApiToken(token, prisma, t0 + TOKEN_CACHE_MS + 1))?.expiresAt).not.toBeNull();
        forgetCachedApiTokens();
        await prisma.apiToken.update({ where: { id }, data: { expiresAt: null } });
        expect((await findApiToken(token, prisma))?.expiresAt).toBeNull();

        const reads = vi.spyOn(prisma.apiToken, 'findUnique');
        const stranger = `rcl_${'z'.repeat(43)}`;
        expect(await findApiToken(stranger)).toBeNull();
        expect(await findApiToken(stranger)).toBeNull();
        expect(reads.mock.calls.length).toBe(2);
    });

    it('lastUsedAt is written once a minute, not on every cached call', async () => {
        const user = await createTestUser();
        const { token, id } = await createTestToken(user);
        const writes = vi.spyOn(prisma.apiToken, 'updateMany');
        const agent = asAgent(token);
        for (let i = 0; i < 3; i++) expect((await agent.get('/api/agent/edits')).status).toBe(200);
        expect(writes.mock.calls.length).toBe(1);
        expect((await prisma.apiToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).not.toBeNull();
    });
});
