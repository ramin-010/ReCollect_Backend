// Sign-in for MCP clients (ALWAYS_ON_SPEC 6.5 and its build notes): Recollect is its own OAuth 2.1
// authorization server for its remote MCP server (/mcp), so claude.ai's connector and Claude Code can
// sign in with Ramin's consent instead of a pasted token. Checked against the MCP authorization spec
// 2026-07-28 and Claude's connector docs.
//
//   discovery   protected-resource metadata (RFC 9728) and authorization-server metadata (RFC 8414)
//   clients     Client ID Metadata Documents (a URL client_id, ./cimd.ts) or registration (RFC 7591)
//   authorize   exact redirect match (loopback on any port), PKCE S256, `resource` = <self>/mcp, then
//               the app's consent page with a signed, 10-minute request
//   token       codes: one use, 10 minutes; access tokens: our rcl_ tokens with the scopes he allowed,
//               an hour, renewed in place (one row per connection in Settings → Agents); refresh
//               tokens: 30 days, rotated, a second use revokes the connection
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { ApiToken, OAuthClient } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { API_SCOPES as ALL_SCOPES, type ApiScope } from '../../types/auth';

/** What an app signing in may ask for: every scope but the phone app's own `ambient` (Settings → Phone app makes that one). */
const API_SCOPES = ALL_SCOPES.filter((s): s is Exclude<ApiScope, 'ambient'> => s !== 'ambient');
import { generateApiToken, hashApiToken } from '../apiTokens/apiTokens.service';
import { CimdError, clientFromMetadataUrl, isMetadataUrl } from './cimd';

export const ACCESS_TTL_S = 3_600;
export const REFRESH_TTL_MS = 30 * 86_400_000;
export const CODE_TTL_MS = 10 * 60_000;
const REQUEST_TTL_S = 10 * 60;
const REQUEST_AUDIENCE = 'recollect-oauth-request';

/** This server's own address: the issuer, and the MCP resource is <self>/mcp. */
export const selfUrl = (): string => (process.env['RECOLLECT_SELF_URL'] || `http://localhost:${process.env['PORT'] || 8002}`).replace(/\/+$/, '');
export const mcpResource = (): string => `${selfUrl()}/mcp`;

/**
 * Where this server calls itself (hosting P1-9: /mcp's tools and Ask AI run on the same API), on
 * the port the request came in on. RECOLLECT_SELF_URL is only for the metadata, the issuer and links.
 * With HOST set (production: 127.0.0.1) the loopback address it listens on; without it, localhost:
 * the dev server listens on every interface and on his Windows PC answers localhost (IPv6), not
 * 127.0.0.1.
 */
export function internalUrl(port: number | string | undefined, env: NodeJS.ProcessEnv = process.env): string {
    const p = port || env['PORT'] || 8002;
    const host = env['HOST']?.trim();
    if (!host) return `http://localhost:${p}`;
    return host === '::1' || host === '[::1]' ? `http://[::1]:${p}` : `http://127.0.0.1:${p}`;
}
/** The web app (the consent page lives there). */
export const appUrl = (): string => (process.env['FRONTEND_URL'] || 'http://localhost:3005').replace(/\/+$/, '');

/** An OAuth error: the code and words for the JSON body (or the redirect's query). */
export class OAuthError extends Error {
    constructor(
        readonly error: string,
        readonly description: string,
        readonly status = 400
    ) {
        super(description);
    }
}

// ─── Discovery ─────────────────────────────────────────────────────────

export function protectedResourceMetadata() {
    return {
        resource: mcpResource(),
        authorization_servers: [selfUrl()],
        scopes_supported: [...API_SCOPES],
        bearer_methods_supported: ['header'],
        resource_name: 'Recollect',
    };
}

export function authorizationServerMetadata() {
    const base = selfUrl();
    return {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        revocation_endpoint: `${base}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [...API_SCOPES],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
    };
}

/** The 401 an MCP request without a working token gets (Claude starts its sign-in from it). */
export function wwwAuthenticate(error?: 'invalid_token'): string {
    const parts = [error ? `error="${error}"` : '', `resource_metadata="${selfUrl()}/.well-known/oauth-protected-resource/mcp"`, `scope="${API_SCOPES.join(' ')}"`].filter(Boolean);
    return `Bearer ${parts.join(', ')}`;
}

// ─── Clients ───────────────────────────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A redirect URI a client may register: https, or http on this machine (loopback). */
export function isAllowedRedirect(uri: string): boolean {
    try {
        const u = new URL(uri);
        if (u.hash) return false;
        return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
    } catch {
        return false;
    }
}

/** Exact match, except that a loopback redirect matches on any port (Claude Code picks one per session). */
export function redirectMatches(registered: readonly string[], uri: string): boolean {
    if (registered.includes(uri)) return true;
    let u: URL;
    try {
        u = new URL(uri);
    } catch {
        return false;
    }
    if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) return false;
    return registered.some((r) => {
        try {
            const v = new URL(r);
            return v.protocol === 'http:' && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search;
        } catch {
            return false;
        }
    });
}

/** POST /oauth/register (RFC 7591): a client without a metadata document registers its redirects. */
export async function registerClient(body: unknown): Promise<Record<string, unknown>> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(b['redirect_uris']) ? b['redirect_uris'].filter((r): r is string => typeof r === 'string') : [];
    if (!redirectUris.length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required');
    const bad = redirectUris.find((r) => !isAllowedRedirect(r));
    if (bad) throw new OAuthError('invalid_redirect_uri', `A redirect URI must be https, or http on localhost: ${bad.slice(0, 200)}`);
    const method = b['token_endpoint_auth_method'];
    if (method !== undefined && method !== 'none') throw new OAuthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") can register');
    const name = (typeof b['client_name'] === 'string' && b['client_name'].trim() ? b['client_name'].trim() : 'An MCP client').slice(0, 200);
    const id = `rcl_client_${crypto.randomBytes(16).toString('base64url')}`;
    const row = await prisma.oAuthClient.create({ data: { id, name, redirectUris, kind: 'dcr' } });
    return {
        client_id: row.id,
        client_name: row.name,
        redirect_uris: row.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    };
}

/** The client a client_id names: a registered one, or one read from its metadata document (kept as a row). */
export async function resolveClient(clientId: string): Promise<OAuthClient | null> {
    if (!clientId) return null;
    if (isMetadataUrl(clientId)) {
        const meta = await clientFromMetadataUrl(clientId);
        return prisma.oAuthClient.upsert({
            where: { id: clientId },
            create: { id: clientId, name: meta.name, redirectUris: meta.redirectUris, kind: 'cimd' },
            update: { name: meta.name, redirectUris: meta.redirectUris },
        });
    }
    return prisma.oAuthClient.findUnique({ where: { id: clientId } });
}

// ─── Authorize and consent ─────────────────────────────────────────────

interface PendingRequest {
    cid: string;
    ru: string;
    st: string | null;
    cc: string;
    sc: ApiScope[];
    rs: string;
}

const secret = (): string => {
    const s = process.env['JWT_SECRET'];
    if (!s) throw new Error('JWT_SECRET is not set');
    return s;
};

function parseScopes(raw: unknown): ApiScope[] {
    const words = typeof raw === 'string' ? raw.split(/\s+/).filter(Boolean) : [];
    if (!words.length) return [...API_SCOPES];
    const unknown = words.filter((w) => !(API_SCOPES as readonly string[]).includes(w) && w !== 'offline_access');
    if (unknown.length) throw new OAuthError('invalid_scope', `Unknown scope: ${unknown.join(' ').slice(0, 100)}`);
    return API_SCOPES.filter((s) => words.includes(s));
}

/** Where the browser goes after GET /oauth/authorize: the consent page, or back to the client with an error. */
export type AuthorizeOutcome = { kind: 'consent'; location: string } | { kind: 'redirect'; location: string } | { kind: 'error'; status: number; error: string; description: string };

export function errorRedirect(redirectUri: string, state: string | null, error: string, description: string): string {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (state) u.searchParams.set('state', state);
    u.searchParams.set('iss', selfUrl());
    return u.toString();
}

/** GET /oauth/authorize: check the request; errors before the redirect is trusted are shown, not sent back. */
export async function authorize(q: Record<string, unknown>): Promise<AuthorizeOutcome> {
    const str = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : '');
    const clientId = str('client_id');
    const redirectUri = str('redirect_uri');
    let client: OAuthClient | null;
    try {
        client = await resolveClient(clientId);
    } catch (err) {
        return { kind: 'error', status: 400, error: 'invalid_client', description: err instanceof CimdError ? err.message : 'The client could not be checked' };
    }
    if (!client) return { kind: 'error', status: 400, error: 'invalid_client', description: 'Unknown client_id' };
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) return { kind: 'error', status: 400, error: 'invalid_request', description: 'redirect_uri is not one this client registered' };
    const state = str('state') || null;
    const back = (error: string, description: string): AuthorizeOutcome => ({ kind: 'redirect', location: errorRedirect(redirectUri, state, error, description) });
    if (str('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code');
    const challenge = str('code_challenge');
    if (!challenge || str('code_challenge_method') !== 'S256') return back('invalid_request', 'PKCE is required: code_challenge with code_challenge_method S256');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return back('invalid_request', 'code_challenge is not a S256 challenge');
    const resource = str('resource') || mcpResource();
    if (resource.replace(/\/+$/, '') !== mcpResource()) return back('invalid_target', `resource must be ${mcpResource()}`);
    let scopes: ApiScope[];
    try {
        scopes = parseScopes(q['scope']);
    } catch (err) {
        return back('invalid_scope', err instanceof OAuthError ? err.description : 'Bad scope');
    }
    const pending: PendingRequest = { cid: client.id, ru: redirectUri, st: state, cc: challenge, sc: scopes, rs: mcpResource() };
    const request = jwt.sign(pending, secret(), { expiresIn: REQUEST_TTL_S, audience: REQUEST_AUDIENCE });
    return { kind: 'consent', location: `${appUrl()}/oauth/consent?request=${encodeURIComponent(request)}` };
}

function readRequest(request: unknown): PendingRequest {
    if (typeof request !== 'string' || !request) throw new OAuthError('invalid_request', 'This sign-in request is missing', 400);
    try {
        return jwt.verify(request, secret(), { audience: REQUEST_AUDIENCE }) as unknown as PendingRequest;
    } catch {
        throw new OAuthError('invalid_request', 'This sign-in request has expired. Start again from the app that sent you here.', 400);
    }
}

/** GET /api/oauth/request: what the consent page shows. */
export async function consentInfo(request: unknown) {
    const p = readRequest(request);
    const client = await prisma.oAuthClient.findUnique({ where: { id: p.cid } });
    if (!client) throw new OAuthError('invalid_client', 'This app is not known any more. Start again from it.');
    return { client: { name: client.name, kind: client.kind, redirectHost: new URL(p.ru).host }, scopes: p.sc };
}

/** POST /api/oauth/consent: his answer; the address to send the browser back to. */
export async function answerConsent(userId: string, request: unknown, allow: boolean): Promise<{ redirect: string }> {
    const p = readRequest(request);
    const client = await prisma.oAuthClient.findUnique({ where: { id: p.cid } });
    if (!client || !redirectMatches(client.redirectUris, p.ru)) throw new OAuthError('invalid_client', 'This app is not known any more. Start again from it.');
    if (!allow) return { redirect: errorRedirect(p.ru, p.st, 'access_denied', 'He said no') };
    const code = crypto.randomBytes(32).toString('base64url');
    await prisma.oAuthCode.create({
        data: { codeHash: hashApiToken(code), clientId: client.id, userId, redirectUri: p.ru, codeChallenge: p.cc, scopes: p.sc, resource: p.rs, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });
    const u = new URL(p.ru);
    u.searchParams.set('code', code);
    if (p.st) u.searchParams.set('state', p.st);
    u.searchParams.set('iss', selfUrl());
    return { redirect: u.toString() };
}

// ─── Tokens ────────────────────────────────────────────────────────────

interface TokenResponse {
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
    refresh_token: string;
    scope: string;
}

const s256 = (verifier: string) => crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');

async function issueRefresh(apiTokenId: string, now: Date): Promise<string> {
    const refresh = `rclr_${crypto.randomBytes(32).toString('base64url')}`;
    await prisma.oAuthRefreshToken.create({ data: { tokenHash: hashApiToken(refresh), apiTokenId, expiresAt: new Date(now.getTime() + REFRESH_TTL_MS) } });
    return refresh;
}

const response = (token: string, refresh: string, scopes: readonly string[]): TokenResponse => ({ access_token: token, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(' ') });

/** POST /oauth/token. */
export async function token(body: Record<string, unknown>, now: Date = new Date()): Promise<TokenResponse> {
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
    const grant = str('grant_type');
    if (grant === 'authorization_code') return exchangeCode(str, now);
    if (grant === 'refresh_token') return refreshToken(str, now);
    throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

async function exchangeCode(str: (k: string) => string, now: Date): Promise<TokenResponse> {
    const code = str('code');
    if (!code) throw new OAuthError('invalid_request', 'code is required');
    const row = await prisma.oAuthCode.findUnique({ where: { codeHash: hashApiToken(code) }, include: { client: true } });
    if (!row) throw new OAuthError('invalid_grant', 'Unknown code');
    if (row.usedAt) {
        // A code used twice: whatever it gave is revoked (OAuth 2.1 §4.1.3).
        if (row.apiTokenId) await prisma.apiToken.updateMany({ where: { id: row.apiTokenId, revokedAt: null }, data: { revokedAt: now } });
        throw new OAuthError('invalid_grant', 'This code was already used');
    }
    if (row.expiresAt <= now) throw new OAuthError('invalid_grant', 'This code has expired');
    if (str('client_id') !== row.clientId) throw new OAuthError('invalid_grant', 'This code was issued to another client');
    if (str('redirect_uri') && str('redirect_uri') !== row.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the one the code was issued for');
    if (!str('code_verifier') || s256(str('code_verifier')) !== row.codeChallenge) throw new OAuthError('invalid_grant', 'PKCE check failed (code_verifier)');
    if (str('resource') && str('resource').replace(/\/+$/, '') !== row.resource) throw new OAuthError('invalid_target', `resource must be ${row.resource}`);
    const claimed = await prisma.oAuthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (claimed.count !== 1) throw new OAuthError('invalid_grant', 'This code was already used');

    const { token: access, tokenHash, prefix } = generateApiToken();
    const apiToken = await prisma.apiToken.create({
        data: { userId: row.userId, name: row.client.name.slice(0, 100), scopes: row.scopes, tokenHash, prefix, expiresAt: new Date(now.getTime() + ACCESS_TTL_S * 1000), oauthClientId: row.clientId },
    });
    await prisma.oAuthCode.update({ where: { id: row.id }, data: { apiTokenId: apiToken.id } });
    return response(access, await issueRefresh(apiToken.id, now), row.scopes);
}

async function refreshToken(str: (k: string) => string, now: Date): Promise<TokenResponse> {
    const refresh = str('refresh_token');
    if (!refresh) throw new OAuthError('invalid_request', 'refresh_token is required');
    const row = await prisma.oAuthRefreshToken.findUnique({ where: { tokenHash: hashApiToken(refresh) }, include: { apiToken: true } });
    if (!row) throw new OAuthError('invalid_grant', 'Unknown refresh token');
    const conn: ApiToken = row.apiToken;
    if (row.usedAt) {
        // A refresh token used twice: someone else may hold it, so the connection ends.
        await prisma.apiToken.updateMany({ where: { id: conn.id, revokedAt: null }, data: { revokedAt: now } });
        throw new OAuthError('invalid_grant', 'This refresh token was already used; the connection was ended');
    }
    if (row.expiresAt <= now || conn.revokedAt) throw new OAuthError('invalid_grant', 'This connection has ended. Sign in again.');
    if (str('client_id') && str('client_id') !== conn.oauthClientId) throw new OAuthError('invalid_grant', 'This refresh token was issued to another client');
    const claimed = await prisma.oAuthRefreshToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (claimed.count !== 1) throw new OAuthError('invalid_grant', 'This refresh token was already used');

    // The same row, a new secret: one connection stays one row in Settings → Agents.
    const { token: access, tokenHash, prefix } = generateApiToken();
    await prisma.apiToken.update({ where: { id: conn.id }, data: { tokenHash, prefix, expiresAt: new Date(now.getTime() + ACCESS_TTL_S * 1000) } });
    return response(access, await issueRefresh(conn.id, now), conn.scopes);
}

/** POST /oauth/revoke (RFC 7009): an access or refresh token ends its connection. Always 200. */
export async function revoke(body: Record<string, unknown>, now: Date = new Date()): Promise<void> {
    const t = typeof body['token'] === 'string' ? (body['token'] as string) : '';
    if (!t) return;
    const hash = hashApiToken(t);
    const refresh = await prisma.oAuthRefreshToken.findUnique({ where: { tokenHash: hash }, select: { apiTokenId: true } });
    const id = refresh?.apiTokenId ?? (await prisma.apiToken.findUnique({ where: { tokenHash: hash }, select: { id: true, oauthClientId: true } }))?.id;
    if (id) await prisma.apiToken.updateMany({ where: { id, revokedAt: null, oauthClientId: { not: null } }, data: { revokedAt: now } });
}

/** The hourly job: codes past their time and spent or expired refresh tokens go. */
export async function pruneOAuth(now: Date = new Date()): Promise<number> {
    const codes = await prisma.oAuthCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
    const refresh = await prisma.oAuthRefreshToken.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: new Date(now.getTime() - 86_400_000) } }] } });
    return codes.count + refresh.count;
}
