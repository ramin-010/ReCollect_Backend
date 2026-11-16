// Sign-in for MCP clients (ALWAYS_ON_SPEC 6.5; ../services/oauth/oauth.service.ts).
//
// publicOAuthRouter (mounted before the app's CORS check: other apps' servers and tools call it):
//   GET  /.well-known/oauth-protected-resource[/mcp]   which server signs in for /mcp
//   GET  /.well-known/oauth-authorization-server        the endpoints and what they support
//   POST /oauth/register                                a client without a metadata document (JSON)
//   GET  /oauth/authorize                               checks, then the app's consent page
//   POST /oauth/token                                   code → tokens, refresh → new tokens (form)
//   POST /oauth/revoke                                  ends a connection (form)
// consentRouter (/api/oauth, his cookie only): what the consent page shows, and his answer.
import express, { type NextFunction, type Request, type Response } from 'express';
import { authOnce, cookieOnly } from '../middlwares/scopes';
import { doorLimit } from '../middlwares/rateLimit';
import { requireUser } from '../middlwares/auth';
import {
    answerConsent,
    authorizationServerMetadata,
    authorize,
    consentInfo,
    OAuthError,
    protectedResourceMetadata,
    registerClient,
    revoke,
    token,
} from '../services/oauth/oauth.service';

/** OAuth's error body (and 401 for a client error at the token endpoint). */
function oauthFail(res: Response, err: unknown): void {
    if (err instanceof OAuthError) {
        res.status(err.status).json({ error: err.error, error_description: err.description });
        return;
    }
    console.error('[oauth] failed:', err);
    res.status(500).json({ error: 'server_error', error_description: 'Something went wrong on the server' });
}

/** Any origin may read the metadata and use the token endpoint (no cookies are involved). */
function openCors(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    next();
}

export const publicOAuthRouter = express.Router();
const wellKnown = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'];
publicOAuthRouter.use([...wellKnown, '/oauth/register', '/oauth/token', '/oauth/revoke'], openCors);

publicOAuthRouter.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => {
    res.json(protectedResourceMetadata());
});
publicOAuthRouter.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json(authorizationServerMetadata());
});

publicOAuthRouter.post('/oauth/register', doorLimit('oauthRegister'), async (req, res) => {
    try {
        res.status(201).json(await registerClient(req.body));
    } catch (err) {
        oauthFail(res, err);
    }
});

publicOAuthRouter.get('/oauth/authorize', async (req, res) => {
    try {
        const out = await authorize(req.query as Record<string, unknown>);
        if (out.kind === 'error') {
            // The redirect can't be trusted yet, so the problem is shown here.
            res.status(out.status)
                .type('html')
                .send(`<!doctype html><meta charset="utf-8"><title>Sign-in problem</title><body style="font-family:system-ui;max-width:560px;margin:15vh auto;padding:0 16px;color:#2c2c2b"><h1 style="font-size:22px">This sign-in can't go on</h1><p>${out.description.replace(/[<>&"]/g, '')}.</p><p style="color:#73706b">Go back to the app that sent you here and start again.</p></body>`);
            return;
        }
        res.redirect(302, out.location);
    } catch (err) {
        oauthFail(res, err);
    }
});

publicOAuthRouter.post('/oauth/token', doorLimit('oauthToken'), async (req, res) => {
    try {
        res.json(await token((req.body ?? {}) as Record<string, unknown>));
    } catch (err) {
        oauthFail(res, err);
    }
});

publicOAuthRouter.post('/oauth/revoke', async (req, res) => {
    try {
        await revoke((req.body ?? {}) as Record<string, unknown>);
        res.status(200).json({});
    } catch (err) {
        oauthFail(res, err);
    }
});

export const consentRouter = express.Router();
consentRouter.use(authOnce, cookieOnly);
consentRouter.get('/request', async (req, res) => {
    try {
        requireUser(req);
        res.json({ success: true, data: await consentInfo(req.query['request']) });
    } catch (err) {
        if (err instanceof OAuthError) {
            res.status(err.status).json({ success: false, message: err.description, code: err.error });
            return;
        }
        oauthFail(res, err);
    }
});
consentRouter.post('/consent', async (req, res) => {
    try {
        const user = requireUser(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        res.json({ success: true, data: await answerConsent(user.id, body['request'], body['allow'] === true) });
    } catch (err) {
        if (err instanceof OAuthError) {
            res.status(err.status).json({ success: false, message: err.description, code: err.error });
            return;
        }
        oauthFail(res, err);
    }
});
