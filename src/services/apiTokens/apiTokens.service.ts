// Personal access tokens (Settings → Tokens; HOME_DOCS_AGENT_PLAN §3): an agent (the MCP server)
// calls the API with `Authorization: Bearer rcl_…`. Only the SHA-256 of a token is stored; the
// plain token is returned once, by create. Revoking keeps the row (revokedAt) so the list can show
// it; a revoked token never authenticates again.
import crypto from 'node:crypto';
import type { ApiToken } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { API_SCOPES, type ApiScope } from '../../types/auth';
import ErrorResponse from '../../utils/errorResponse';

export const API_TOKEN_PREFIX = 'rcl_';
/** `rcl_` + 32 random bytes in base64url (43 characters). */
const API_TOKEN_FORMAT = /^rcl_[A-Za-z0-9_-]{43}$/;
/** Characters of the token kept for display: `rcl_` + 8. */
export const API_TOKEN_DISPLAY_LENGTH = 12;
export const API_TOKEN_NAME_MAX = 100;
export const ACTIVE_TOKEN_LIMIT = 20;
/** lastUsedAt is written at most this often. */
export const LAST_USED_THROTTLE_MS = 60_000;

export interface GeneratedApiToken {
    token: string;
    tokenHash: string;
    prefix: string;
}

export function hashApiToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateApiToken(): GeneratedApiToken {
    const token = `${API_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    return { token, tokenHash: hashApiToken(token), prefix: token.slice(0, API_TOKEN_DISPLAY_LENGTH) };
}

/** True for something shaped like one of our tokens (cheap check before a lookup). */
export function isApiTokenFormat(value: string): boolean {
    return API_TOKEN_FORMAT.test(value);
}

/** Validated, de-duplicated scopes in the canonical order; 400 for anything else. */
export function normalizeScopes(input: unknown): ApiScope[] {
    if (!Array.isArray(input) || input.length === 0) {
        throw new ErrorResponse(400, `Pick at least one scope: ${API_SCOPES.join(', ')}`);
    }
    for (const scope of input) {
        if (typeof scope !== 'string' || !(API_SCOPES as readonly string[]).includes(scope)) {
            throw new ErrorResponse(400, `Unknown scope "${String(scope)}" (use ${API_SCOPES.join(', ')})`);
        }
    }
    return API_SCOPES.filter((scope) => input.includes(scope));
}

/** Stored scopes → known scopes (an unknown stored value is ignored, never trusted). */
export function storedScopes(scopes: readonly string[]): ApiScope[] {
    return API_SCOPES.filter((scope) => scopes.includes(scope));
}

export function normalizeTokenName(input: unknown): string {
    const name = typeof input === 'string' ? input.trim() : '';
    if (!name) throw new ErrorResponse(400, 'A token needs a name');
    if (name.length > API_TOKEN_NAME_MAX) throw new ErrorResponse(400, `A token name is at most ${API_TOKEN_NAME_MAX} characters`);
    return name;
}

/** The list/create JSON. Never contains the token or its hash. */
export function serializeApiToken(row: ApiToken) {
    return {
        _id: row.id,
        name: row.name,
        prefix: row.prefix,
        scopes: storedScopes(row.scopes),
        lastUsedAt: row.lastUsedAt,
        revokedAt: row.revokedAt,
        createdAt: row.createdAt,
        /** Made by an app's sign-in (claude.ai, Claude Code), not by hand; renewed by the app itself. */
        signIn: row.oauthClientId !== null,
    };
}

export type ApiTokenJson = ReturnType<typeof serializeApiToken>;

/** GET /api/tokens: newest first, revoked ones included (with revokedAt). */
export async function listApiTokens(userId: string, db: DbClient = prisma): Promise<ApiTokenJson[]> {
    const rows = await db.apiToken.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.map(serializeApiToken);
}

/** POST /api/tokens: the new row plus the plain token (shown once). */
export async function createApiToken(
    userId: string,
    input: { name: unknown; scopes: unknown },
    db: DbClient = prisma
): Promise<ApiTokenJson & { token: string }> {
    const name = normalizeTokenName(input.name);
    const scopes = normalizeScopes(input.scopes);
    const active = await db.apiToken.count({ where: { userId, revokedAt: null } });
    if (active >= ACTIVE_TOKEN_LIMIT) throw new ErrorResponse(409, `Up to ${ACTIVE_TOKEN_LIMIT} active tokens: revoke one first`);

    const { token, tokenHash, prefix } = generateApiToken();
    const row = await db.apiToken.create({ data: { userId, name, scopes, tokenHash, prefix } });
    return { ...serializeApiToken(row), token };
}

/** DELETE /api/tokens/:id: revoke (idempotent). Another user's token is a 404. */
export async function revokeApiToken(userId: string, tokenId: string, now: Date = new Date(), db: DbClient = prisma): Promise<ApiTokenJson> {
    const row = await db.apiToken.findFirst({ where: { id: tokenId, userId } });
    if (!row) throw new ErrorResponse(404, 'Token not found');
    if (row.revokedAt) return serializeApiToken(row);
    const revoked = await db.apiToken.update({ where: { id: row.id }, data: { revokedAt: now } });
    forgetCachedApiTokens();
    return serializeApiToken(revoked);
}

/**
 * TOOL_ACCESS_PLAN §6.6 (2): a token's row is kept 10 seconds in this process. A web tool call checks its token twice
 * (at /mcp, then at every API call the tool makes), and each check was a database read. Only rows that exist are
 * kept (a stranger's guesses never fill it); every revoke, refresh or end of a connection clears it (this process at
 * once; another process within the 10 seconds). Off in tests, where rows change behind the service's back, unless a
 * test turns it on.
 */
export const TOKEN_CACHE_MS = 10_000;
const TOKEN_CACHE_MAX = 5_000;
const tokenCache = new Map<string, { row: ApiToken; until: number }>();

const tokenCacheOn = (): boolean => process.env['NODE_ENV'] !== 'test' || process.env['TOKEN_CACHE_IN_TESTS'] === '1';

/** Every cached token row goes (a token was revoked, refreshed or its connection ended). */
export function forgetCachedApiTokens(): void {
    tokenCache.clear();
}

/** The token row for a plain token, or null (unknown or malformed). Revoked rows are returned. */
export async function findApiToken(token: string, db: DbClient = prisma, now: number = Date.now()): Promise<ApiToken | null> {
    if (!isApiTokenFormat(token)) return null;
    const hash = hashApiToken(token);
    // Only reads outside a transaction use the cache (a transaction sees its own writes).
    const cached = db === prisma && tokenCacheOn();
    if (cached) {
        const hit = tokenCache.get(hash);
        if (hit && hit.until > now) return hit.row;
        if (hit) tokenCache.delete(hash);
    }
    const row = await db.apiToken.findUnique({ where: { tokenHash: hash } });
    if (row && cached) {
        if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value!);
        tokenCache.set(hash, { row, until: now + TOKEN_CACHE_MS });
    }
    return row;
}

/** lastUsedAt = now, at most once a minute (one conditional UPDATE, no read-modify-write race). */
export async function touchApiToken(row: Pick<ApiToken, 'id' | 'lastUsedAt'>, now: Date = new Date(), db: DbClient = prisma): Promise<void> {
    if (row.lastUsedAt && now.getTime() - row.lastUsedAt.getTime() < LAST_USED_THROTTLE_MS) return;
    const threshold = new Date(now.getTime() - LAST_USED_THROTTLE_MS);
    await db.apiToken.updateMany({
        where: { id: row.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: threshold } }] },
        data: { lastUsedAt: now },
    });
    // The cached row (the same object) knows it was just used: the next calls within a minute write nothing.
    (row as { lastUsedAt: Date | null }).lastUsedAt = now;
}
