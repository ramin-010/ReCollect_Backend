// Remote MCP (ALWAYS_ON_SPEC 6.5): POST /mcp speaks the MCP Streamable HTTP transport (stateless) over
// the same tool catalogue as the stdio server. Auth: a personal access token (`Authorization: Bearer
// rcl_…`), checked here and again by every API call the tools make, so scopes and the edit log apply
// as they do for a local agent. Without a working token: 401 with the protected-resource hint, so an
// OAuth client (claude.ai's connector, Claude Code) signs in through ./oauth.routes.ts.
import express, { type Request, type Response } from 'express';
import { findApiToken, isApiTokenFormat } from '../services/apiTokens/apiTokens.service';
import { serveMcpHttp } from '../services/assistant/catalogue';
import { selfUrl, wwwAuthenticate } from '../services/oauth/oauth.service';

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

router.post('/mcp', express.json({ limit: '2mb' }), async (req: Request, res: Response) => {
    const token = bearer(req);
    if (!token || !isApiTokenFormat(token)) return unauthorized(res, 'Add a Recollect token: Authorization: Bearer rcl_… (Settings → Agents).');
    const row = await findApiToken(token);
    if (!row || row.revokedAt) return unauthorized(res, 'This token is not valid any more. Make a new one in Settings → Agents.', true);
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return unauthorized(res, 'This token has expired: refresh it, or sign in again.', true);
    try {
        await serveMcpHttp(req, res, { baseUrl: selfUrl(), token, agentName: row.name || 'Remote MCP' });
    } catch (err) {
        console.error('[mcp] request failed:', err);
        if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'The Recollect tools could not run.' }, id: null });
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
