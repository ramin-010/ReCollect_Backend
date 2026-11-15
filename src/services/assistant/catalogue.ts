// The manager's tools (MANAGER_AND_DOCS_PLAN §3.4, "the catalogue inside the backend"): the MCP
// server itself (mcp/dist/embedded.js, an ES module) loaded into this CommonJS process with a native
// dynamic import, driven over an in-memory transport. Its calls come back to this API over HTTP with
// a token of the user's own, named "Ask AI", so the manager meets the same allowlist, levels, edit
// log and Undo as every agent. One catalogue; nothing is written twice.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prisma } from '../../db/prisma';
import { API_SCOPES, type ApiScope } from '../../types/auth';
import { createApiToken, findApiToken, revokeApiToken } from '../apiTokens/apiTokens.service';
import { ASK_AI_AGENT } from '../actions/actions.service';

/** The built MCP package's embedded entry (RECOLLECT_MCP_EMBEDDED overrides). */
export const MCP_EMBEDDED = process.env['RECOLLECT_MCP_EMBEDDED'] ?? path.resolve(__dirname, '..', '..', '..', '..', 'mcp', 'dist', 'embedded.js');

/** The token's name in Settings → Agents (so he sees the manager has one, and can revoke it). */
export const ASSISTANT_TOKEN_NAME = 'Ask AI (built in)';

export interface CatalogueTool {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    level: 1 | 2 | 3;
}

export interface Catalogue {
    tools: CatalogueTool[];
    call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
    close(): Promise<void>;
}

interface EmbeddedModule {
    openCatalogue(options: { baseUrl: string; token: string; agentName: string; timeoutMs?: number }): Promise<Catalogue>;
    handleMcpHttp(req: unknown, res: unknown, options: { baseUrl: string; token: string; agentName: string; timeoutMs?: number }): Promise<void>;
}

/** Remote MCP (ALWAYS_ON_SPEC 6.5): one Streamable HTTP request served by the same catalogue, on the caller's token. */
export async function serveMcpHttp(req: unknown, res: unknown, options: { baseUrl: string; token: string; agentName: string }): Promise<void> {
    const mod = await embedded();
    await mod.handleMcpHttp(req, res, options);
}

// TypeScript turns `import()` into `require()` for CommonJS output; an ES module needs the real one.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

/** Node's own import; a test runner that runs modules in a vm (vitest) has no callback for it, and its own import() then does it. */
async function loadEsm(file: string): Promise<unknown> {
    const url = pathToFileURL(file).href;
    try {
        return await importEsm(url);
    } catch (err) {
        if (!/dynamic import callback/i.test(String(err))) throw err;
        return import(/* @vite-ignore */ url);
    }
}

let loaded: Promise<EmbeddedModule> | null = null;
function embedded(): Promise<EmbeddedModule> {
    loaded ??= loadEsm(MCP_EMBEDDED).then((m) => m as EmbeddedModule).catch((err: unknown) => {
        loaded = null;
        throw new Error(`The manager's tools could not load from ${MCP_EMBEDDED} (run npm run build in mcp/): ${err instanceof Error ? err.message : String(err)}`);
    });
    return loaded;
}

/** userId → the plain token of the user's "Ask AI" token (kept in memory only; a restart makes a new one). */
const tokens = new Map<string, string>();

/** The user's "Ask AI" token: reused while it works; a new one revokes the ones before it. */
export async function assistantToken(userId: string): Promise<string> {
    const known = tokens.get(userId);
    if (known) {
        const row = await findApiToken(known);
        if (row && !row.revokedAt && row.userId === userId) return known;
    }
    const old = await prisma.apiToken.findMany({ where: { userId, name: ASSISTANT_TOKEN_NAME, revokedAt: null }, select: { id: true } });
    for (const t of old) await revokeApiToken(userId, t.id);
    // Every scope but the phone app's own `ambient` (the manager reads the picture's data through `read`).
    const created = await createApiToken(userId, { name: ASSISTANT_TOKEN_NAME, scopes: API_SCOPES.filter((s): s is ApiScope => s !== 'ambient') });
    tokens.set(userId, created.token);
    return created.token;
}

/** The catalogue for one user, calling the API at `baseUrl` (this server) as "Ask AI". */
export async function openCatalogueFor(userId: string, baseUrl: string): Promise<Catalogue> {
    const mod = await embedded();
    return mod.openCatalogue({ baseUrl, token: await assistantToken(userId), agentName: ASK_AI_AGENT });
}
