// Sign-in for MCP clients (ALWAYS_ON_SPEC 6.5 build notes): discovery, registration (DCR) and metadata
// documents (CIMD, with a stubbed fetch), the consent, PKCE, one-use codes, tokens that expire and renew
// in place, rotated refresh tokens with reuse detection, revocation, and /mcp with a signed-in token.
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { setCimdFetcherForTests } from '../../src/services/oauth/cimd';
import { mcpResource, selfUrl } from '../../src/services/oauth/oauth.service';
import { authCookie, createTestUser } from '../helpers/auth';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const verifier = () => crypto.randomBytes(32).toString('base64url');
const challengeOf = (v: string) => crypto.createHash('sha256').update(v, 'ascii').digest('base64url');

afterEach(() => setCimdFetcherForTests(null));

async function register(redirects: string[] = [REDIRECT], name = 'Claude') {
    const res = await request(app).post('/oauth/register').send({ client_name: name, redirect_uris: redirects, token_endpoint_auth_method: 'none' });
    expect(res.status).toBe(201);
    return res.body.client_id as string;
}

/** authorize → the consent page's request → Allow → the code on the redirect. */
async function signIn(user: { id: string }, clientId: string, opts: { redirect?: string; scope?: string } = {}) {
    const v = verifier();
    const redirect = opts.redirect ?? REDIRECT;
    const auth = await request(app)
        .get('/oauth/authorize')
        .query({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challengeOf(v), code_challenge_method: 'S256', state: 'st8', resource: mcpResource(), ...(opts.scope ? { scope: opts.scope } : {}) });
    expect(auth.status).toBe(302);
    const consent = new URL(auth.headers['location'] as string);
    expect(consent.pathname).toBe('/oauth/consent');
    const req = consent.searchParams.get('request')!;
    const info = await request(app).get('/api/oauth/request').query({ request: req }).set('Cookie', authCookie(user));
    expect(info.status).toBe(200);
    const answer = await request(app).post('/api/oauth/consent').set('Cookie', authCookie(user)).send({ request: req, allow: true });
    expect(answer.status).toBe(200);
    const back = new URL(answer.body.data.redirect as string);
    return { info: info.body.data, back, code: back.searchParams.get('code')!, verifier: v, redirect };
}

const exchange = (form: Record<string, string>) => request(app).post('/oauth/token').type('form').send(form);

describe('discovery', () => {
    it('serves the protected resource and the authorization server, and /mcp points at them', async () => {
        for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
            const prm = await request(app).get(path);
            expect(prm.body).toMatchObject({ resource: mcpResource(), authorization_servers: [selfUrl()], bearer_methods_supported: ['header'] });
            expect(prm.headers['access-control-allow-origin']).toBe('*');
        }
        const as = await request(app).get('/.well-known/oauth-authorization-server');
        expect(as.body).toMatchObject({
            issuer: selfUrl(),
            authorization_endpoint: `${selfUrl()}/oauth/authorize`,
            token_endpoint: `${selfUrl()}/oauth/token`,
            registration_endpoint: `${selfUrl()}/oauth/register`,
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            client_id_metadata_document_supported: true,
            authorization_response_iss_parameter_supported: true,
        });
        expect(as.body.scopes_supported).not.toContain('offline_access');
        const mcp = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(mcp.status).toBe(401);
        expect(mcp.headers['www-authenticate']).toContain(`resource_metadata="${selfUrl()}/.well-known/oauth-protected-resource/mcp"`);
        expect(mcp.headers['www-authenticate']).toContain('scope="read docs:write');
    });
});

describe('sign-in with a registered client (DCR)', () => {
    it('consent → code → tokens; the token works on /mcp and the API, expires, renews in place; refresh tokens rotate', async () => {
        const user = await createTestUser();
        const clientId = await register();
        const { info, back, code, verifier: v } = await signIn(user, clientId);
        expect(info).toMatchObject({ client: { name: 'Claude', kind: 'dcr', redirectHost: 'claude.ai' }, scopes: ['read', 'docs:write', 'learning:write', 'sessions:write', 'tasks:write'] });
        expect(back.origin + back.pathname).toBe(REDIRECT);
        expect(back.searchParams.get('state')).toBe('st8');
        expect(back.searchParams.get('iss')).toBe(selfUrl());

        // PKCE: a wrong verifier fails; the right one gets the pair.
        expect((await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier() })).body.error).toBe('invalid_grant');
        const tok = await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: v, resource: mcpResource() });
        expect(tok.status).toBe(200);
        expect(tok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read docs:write learning:write sessions:write tasks:write' });
        const access = tok.body.access_token as string;
        expect(access).toMatch(/^rcl_/);

        // The token works: the API (its scopes) and /mcp.
        expect((await request(app).get('/api/brief').set('Authorization', `Bearer ${access}`)).status).toBe(200);
        const init = await request(app)
            .post('/mcp')
            .set('Authorization', `Bearer ${access}`)
            .set('Accept', 'application/json, text/event-stream')
            .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
        expect(init.status).toBe(200);
        expect(init.text).toContain('serverInfo');

        // One row in Settings → Agents, marked as a sign-in.
        const tokens = await request(app).get('/api/tokens').set('Cookie', authCookie(user));
        const rows = (tokens.body.data as Array<{ name: string; signIn: boolean }>).filter((t) => t.signIn);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.name).toBe('Claude');

        // A used code again: refused, and what it gave is revoked.
        const again = await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: v });
        expect(again.body.error).toBe('invalid_grant');
        expect((await request(app).get('/api/brief').set('Authorization', `Bearer ${access}`)).status).toBe(401);
    });

    it('refresh renews the same row; an expired token is a 401 with the sign-in hint; a reused refresh ends the connection', async () => {
        const user = await createTestUser();
        const clientId = await register();
        const { code, verifier: v } = await signIn(user, clientId);
        const first = (await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: v })).body;
        const row = await prisma.apiToken.findFirstOrThrow({ where: { userId: user.id, oauthClientId: clientId } });

        // Expired: 401 on the API and on /mcp (with WWW-Authenticate).
        await prisma.apiToken.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expect((await request(app).get('/api/brief').set('Authorization', `Bearer ${first.access_token}`)).status).toBe(401);
        const mcp = await request(app).post('/mcp').set('Authorization', `Bearer ${first.access_token}`).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(mcp.status).toBe(401);
        expect(mcp.headers['www-authenticate']).toContain('error="invalid_token"');

        // Refresh: a new pair, the same row, a working token again; the old access token is gone.
        const second = (await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId })).body;
        expect(second.access_token).toMatch(/^rcl_/);
        expect(second.refresh_token).not.toBe(first.refresh_token);
        expect(await prisma.apiToken.count({ where: { userId: user.id, oauthClientId: clientId } })).toBe(1);
        expect((await request(app).get('/api/brief').set('Authorization', `Bearer ${second.access_token}`)).status).toBe(200);

        // The first refresh token again: reuse → the connection ends.
        const reuse = await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
        expect(reuse.body.error).toBe('invalid_grant');
        expect((await request(app).get('/api/brief').set('Authorization', `Bearer ${second.access_token}`)).status).toBe(401);
        expect((await exchange({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: clientId })).body.error).toBe('invalid_grant');
    });

    it('revoke ends the connection; Deny goes back with access_denied', async () => {
        const user = await createTestUser();
        const clientId = await register();
        const { code, verifier: v } = await signIn(user, clientId);
        const pair = (await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: v })).body;
        expect((await request(app).post('/oauth/revoke').type('form').send({ token: pair.refresh_token })).status).toBe(200);
        expect((await request(app).get('/api/brief').set('Authorization', `Bearer ${pair.access_token}`)).status).toBe(401);

        const auth = await request(app).get('/oauth/authorize').query({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challengeOf(verifier()), code_challenge_method: 'S256', state: 'x' });
        const req = new URL(auth.headers['location'] as string).searchParams.get('request')!;
        const no = await request(app).post('/api/oauth/consent').set('Cookie', authCookie(user)).send({ request: req, allow: false });
        const back = new URL(no.body.data.redirect as string);
        expect(back.searchParams.get('error')).toBe('access_denied');
        expect(back.searchParams.get('state')).toBe('x');
    });
});

describe('the checks before the consent', () => {
    it('refuses unknown clients and redirects on the page; sends other problems back to the client', async () => {
        const unknown = await request(app).get('/oauth/authorize').query({ response_type: 'code', client_id: 'nope', redirect_uri: REDIRECT, code_challenge: challengeOf(verifier()), code_challenge_method: 'S256' });
        expect(unknown.status).toBe(400);
        expect(unknown.text).toContain("This sign-in can't go on");
        const clientId = await register();
        const badRedirect = await request(app).get('/oauth/authorize').query({ response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.example/cb', code_challenge: challengeOf(verifier()), code_challenge_method: 'S256' });
        expect(badRedirect.status).toBe(400);
        const noPkce = await request(app).get('/oauth/authorize').query({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's' });
        expect(noPkce.status).toBe(302);
        expect(new URL(noPkce.headers['location'] as string).searchParams.get('error')).toBe('invalid_request');
        const wrongResource = await request(app).get('/oauth/authorize').query({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challengeOf(verifier()), code_challenge_method: 'S256', resource: 'https://other.example/mcp' });
        expect(new URL(wrongResource.headers['location'] as string).searchParams.get('error')).toBe('invalid_target');
        const badScope = await request(app).get('/oauth/authorize').query({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challengeOf(verifier()), code_challenge_method: 'S256', scope: 'read admin' });
        expect(new URL(badScope.headers['location'] as string).searchParams.get('error')).toBe('invalid_scope');
        // Registration: only https or loopback redirects.
        expect((await request(app).post('/oauth/register').send({ client_name: 'x', redirect_uris: ['http://example.com/cb'] })).status).toBe(400);
        // The consent API is his cookie only.
        expect((await request(app).get('/api/oauth/request').query({ request: 'x' })).status).toBe(401);
    });

    it('a loopback redirect matches on any port (Claude Code), and a narrower scope is kept', async () => {
        const user = await createTestUser();
        const clientId = await register(['http://localhost/callback'], 'Claude Code');
        const { code, verifier: v, redirect } = await signIn(user, clientId, { redirect: 'http://localhost:53122/callback', scope: 'read sessions:write' });
        const pair = (await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: v })).body;
        expect(pair.scope).toBe('read sessions:write');
        // docs:write was not allowed: a doc write is refused.
        const write = await request(app).post('/api/agent/docs').set('Authorization', `Bearer ${pair.access_token}`).send({ title: 'x', markdown: 'y' });
        expect(write.status).toBe(403);
    });
});

describe('metadata documents (CIMD)', () => {
    const URL_ID = 'https://claude.ai/oauth/claude-code-client-metadata';

    it('reads the client from its document, checks it, and signs in', async () => {
        const user = await createTestUser();
        let fetched = 0;
        setCimdFetcherForTests(async (url) => {
            fetched += 1;
            const body = url === URL_ID ? { client_id: URL_ID, client_name: 'Claude (metadata)', redirect_uris: [REDIRECT] } : { client_id: 'https://someone.else/doc', client_name: 'x', redirect_uris: [REDIRECT] };
            return { status: 200, headers: new Headers({ 'cache-control': 'max-age=600' }), text: async () => JSON.stringify(body) };
        });
        const { info, code, verifier: v } = await signIn(user, URL_ID);
        expect(info.client).toMatchObject({ name: 'Claude (metadata)', kind: 'cimd' });
        const pair = await exchange({ grant_type: 'authorization_code', code, client_id: URL_ID, redirect_uri: REDIRECT, code_verifier: v });
        expect(pair.status).toBe(200);
        expect(fetched).toBe(1); // cached

        // A document that names another client_id is refused.
        const other = await request(app).get('/oauth/authorize').query({ response_type: 'code', client_id: 'https://claude.ai/oauth/other-client', redirect_uri: REDIRECT, code_challenge: challengeOf(verifier()), code_challenge_method: 'S256' });
        expect(other.status).toBe(400);
        expect(other.text).toContain('another client_id');
    });
});
