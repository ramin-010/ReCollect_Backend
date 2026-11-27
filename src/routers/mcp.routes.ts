// Remote MCP (ALWAYS_ON_SPEC 6.5): POST /mcp speaks the MCP Streamable HTTP transport (stateless) over
// the same tool catalogue as the stdio server. Auth: a personal access token (`Authorization: Bearer
// rcl_…`), checked here and again by every API call the tools make, so scopes and the edit log apply
// as they do for a local agent. Without a working token: 401 with the protected-resource hint, so an
// OAuth client (claude.ai's connector, Claude Code) signs in through ./oauth.routes.ts.
import express, { type Request, type Response } from 'express';
import { findApiToken, isApiTokenFormat } from '../services/apiTokens/apiTokens.service';
import { serveMcpHttp } from '../services/assistant/catalogue';
import { internalUrl, wwwAuthenticate } from '../services/oauth/oauth.service';
import { doorLimit } from '../middlwares/rateLimit';
import { recordToolCall, takeCall } from '../services/mcp/doorStats';

const router = express.Router();

function bearer(req: Request): string | null {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    return m?.[1] ?? null;
}

function unauthorized(res: Response, message: string, invalid = false): void {
    res.setHeader('WWW-Authenticate', wwwAuthenticate(invalid ? 'invalid_token' : undefined));
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

type RpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown } };
const hasId = (m: RpcMessage): m is RpcMessage & { id: string | number } => typeof m.id === 'string' || typeof m.id === 'number';

/**
 * TOOL_ACCESS_PLAN §6.3, §12.2 (B3): takes one call from the token for every tools/call in the body, a single message
 * or a batch. Null when they may all run; else the whole body's answer (each call a tool result with the limit's words,
 * any other request in the batch an error) and the calls refused, for the counts.
 */
export function limitedBody(body: unknown, token: string, take: (token: string) => string | null = takeCall): { answer: unknown; calls: Array<{ tool: string }> } | null {
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]).filter((m): m is RpcMessage => !!m && typeof m === 'object');
    const calls = messages.filter((m) => m.method === 'tools/call' && hasId(m));
    if (!calls.length) return null;
    let words: string | null = null;
    for (const _ of calls) words ??= take(token);
    if (!words) return null;
    const limited = words;
    const answers = messages.filter(hasId).map((m) =>
        m.method === 'tools/call'
            ? { result: { content: [{ type: 'text', text: limited }], isError: true }, jsonrpc: '2.0', id: m.id }
            : { error: { code: -32000, message: limited }, jsonrpc: '2.0', id: m.id }
    );
    return { answer: batch ? answers : answers[0], calls: calls.map((c) => ({ tool: String(c.params?.name ?? '?').slice(0, 60) })) };
}

// Hosting P1-4: knocking without a valid token is limited per address. Only a refused request meets the limiter
// (TOOL_ACCESS_PLAN stage 0, the bench): every claude.ai or ChatGPT user's calls come from that host's few addresses,
// and a limiter in front of every request counts the ones in flight too, so busy hours would answer valid tokens 429.
const knock = doorLimit('mcp');
router.post('/mcp', express.json({ limit: '2mb' }), async (req: Request, res: Response) => {
    const token = bearer(req);
    const refuse = (message: string, invalid = false) => knock(req, res, () => unauthorized(res, message, invalid));
    if (!token || !isApiTokenFormat(token)) return refuse('Add a Kaaga token: Authorization: Bearer rcl_… (Settings → Agents).');
    const row = await findApiToken(token);
    if (!row || row.revokedAt) return refuse('This token is not valid any more. Make a new one in Settings → Agents.', true);
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return refuse('This token has expired: refresh it, or sign in again.', true);
    // TOOL_ACCESS_PLAN §6.3: a call over the token's limit is answered as a tool result the model reads (a 429 would
    // show in the host as a broken connector); lists, initialize and notifications are not counted.
    // §12.2 (B3): every call counts, also each one of a batch (the transport takes JSON-RPC arrays); a batch with any
    // call over the limit is answered whole, each call with the limit's words.
    const over = limitedBody(req.body, token);
    if (over) {
        for (const c of over.calls) recordToolCall({ door: 'web', app: row.name || 'Remote MCP', tool: c.tool, via: 'direct', outcome: 'limited', ms: 0 });
        res.status(200).json(over.answer);
        return;
    }
    try {
        // The tools call this server on the address it listens on, never the public one (hosting P1-9).
        await serveMcpHttp(req, res, { baseUrl: internalUrl(req.socket.localPort), token, agentName: row.name || 'Remote MCP' });
    } catch (err) {
        console.error('[mcp] request failed:', err);
        if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'The Kaaga tools could not run.' }, id: null });
    }
});

// Stateless: no server-sent stream to resume and no session to end.
router.get('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP server is stateless (POST only).' }, id: null });
});
router.delete('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});

export default router;
