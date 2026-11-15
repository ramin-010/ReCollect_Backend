// The catalogue inside the backend (MANAGER_AND_DOCS_PLAN 3.4, the spike): the built MCP server
// (mcp/dist/embedded.js, an ES module) loads into this CommonJS process, lists every tool with its
// level, and its calls come back to this API as "Ask AI": logged like any agent's. Needs the MCP
// package built (npm run build in mcp/).
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { ASSISTANT_TOKEN_NAME, assistantToken, openCatalogueFor } from '../../src/services/assistant/catalogue';
import { createTestUser } from '../helpers/auth';

let server: Server;
let baseUrl = '';
beforeAll(async () => {
    server = app.listen(0);
    await once(server, 'listening');
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('the catalogue inside the backend', () => {
    it('lists every tool with its level and acts through the API as "Ask AI"', async () => {
        const user = await createTestUser();
        const catalogue = await openCatalogueFor(user.id, baseUrl);
        try {
            expect(catalogue.tools.map((t) => t.name)).toContain('empty_trash');
            expect(catalogue.tools.map((t) => t.name)).not.toContain('more_tools');
            expect(catalogue.tools.find((t) => t.name === 'empty_trash')!.level).toBe(3);
            expect(catalogue.tools.find((t) => t.name === 'search_docs')!.level).toBe(1);
            expect(catalogue.tools.every((t) => t.inputSchema['type'] === 'object')).toBe(true);

            const made = await catalogue.call('create_doc', { title: 'From the manager', markdown: 'Hello from Ask AI.' });
            expect(made.isError).toBe(false);
            const edit = await prisma.agentEdit.findFirstOrThrow({ where: { userId: user.id, kind: 'doc_create' } });
            expect(edit).toMatchObject({ agentName: 'Ask AI', summary: 'Created "From the manager"' });
            const found = await catalogue.call('search_docs', { query: 'manager' });
            expect(found.text).toContain('From the manager');
            expect((await catalogue.call('trash_doc', { docId: 'not-a-doc' })).isError).toBe(true);
        } finally {
            await catalogue.close();
        }

        // One token, named, reused while it works; a revoked one is replaced.
        const tokens = await prisma.apiToken.findMany({ where: { userId: user.id, name: ASSISTANT_TOKEN_NAME } });
        expect(tokens.map((t) => [t.revokedAt, t.scopes.length])).toEqual([[null, 5]]);
        const first = await assistantToken(user.id);
        expect(await assistantToken(user.id)).toBe(first);
        await prisma.apiToken.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });
        expect(await assistantToken(user.id)).not.toBe(first);
        expect(await prisma.apiToken.count({ where: { userId: user.id, name: ASSISTANT_TOKEN_NAME, revokedAt: null } })).toBe(1);
    });
});
