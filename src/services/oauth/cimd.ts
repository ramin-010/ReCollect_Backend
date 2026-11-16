// Client ID Metadata Documents (MCP authorization 2026-07-28; IETF draft "OAuth Client ID Metadata
// Document"): a client may use an https URL as its client_id, and the document at that URL says who it
// is. Fetched with guards against reaching inside the network (https only, public addresses only, no
// redirects, 5 s, 64 KB), checked (client_id equal to the URL, a name, redirect URIs), and cached by
// its Cache-Control between 5 minutes and a day.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface ClientMetadata {
    clientId: string;
    name: string;
    redirectUris: string[];
}

export class CimdError extends Error {}

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;
const MIN_CACHE_S = 300;
const MAX_CACHE_S = 86_400;

type Fetcher = (url: string) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/** True when an IPv4 or IPv6 address is not on the public internet. */
export function isPrivateAddress(address: string): boolean {
    const v = isIP(address);
    if (v === 4) {
        const [a, b] = address.split('.').map(Number) as [number, number];
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    if (v === 6) {
        const x = address.toLowerCase();
        if (x === '::1' || x === '::') return true;
        if (x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80')) return true;
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
        return mapped ? isPrivateAddress(mapped[1]!) : false;
    }
    return true;
}

/** The real fetch, guarded: https, a public address, no redirects, a time and size limit. */
const guardedFetch: Fetcher = async (url) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new CimdError('A client metadata URL must be https');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new CimdError('The client metadata URL is not on the public internet');
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
    const reader = res.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) {
                await reader.cancel();
                throw new CimdError('The client metadata document is too large');
            }
            chunks.push(value);
        }
    }
    const body = Buffer.concat(chunks).toString('utf8');
    return { status: res.status, headers: res.headers, text: async () => body };
};

let fetcher: Fetcher = guardedFetch;
/** Tests: answer metadata URLs from a stub (null puts the guarded fetch back). */
export function setCimdFetcherForTests(stub: Fetcher | null): void {
    fetcher = stub ?? guardedFetch;
    cache.clear();
}

const cache = new Map<string, { value: ClientMetadata; until: number }>();

/** True when a client_id is a metadata URL (https with a path), not a registered id. */
export function isMetadataUrl(clientId: string): boolean {
    try {
        const u = new URL(clientId);
        return u.protocol === 'https:' && u.pathname.length > 1 && !u.hash;
    } catch {
        return false;
    }
}

function cacheSeconds(header: string | null): number {
    const m = /max-age=(\d+)/i.exec(header ?? '');
    const s = m ? Number(m[1]) : MIN_CACHE_S;
    return Math.min(Math.max(s, MIN_CACHE_S), MAX_CACHE_S);
}

/**
 * OAUTH_CIMD_HOSTS (hosting review A1): the hosts whose client metadata the server may fetch,
 * comma-separated (production: claude.ai). Unset: any public https host, as before (dev). A URL on
 * another host is refused before any request leaves the server: /oauth/authorize runs before login.
 */
export function cimdHosts(env: NodeJS.ProcessEnv = process.env): string[] | null {
    const list = (env['OAUTH_CIMD_HOSTS'] ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    return list.length ? list : null;
}

export function cimdHostAllowed(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const hosts = cimdHosts(env);
    if (!hosts) return true;
    try {
        return hosts.includes(new URL(url).hostname.toLowerCase());
    } catch {
        return false;
    }
}

/** The client a metadata URL names, checked (CimdError when it can't be used). */
export async function clientFromMetadataUrl(url: string, now: number = Date.now()): Promise<ClientMetadata> {
    if (!cimdHostAllowed(url)) throw new CimdError('Client metadata is read only from the hosts this server lists');
    const hit = cache.get(url);
    if (hit && hit.until > now) return hit.value;
    let res: Awaited<ReturnType<Fetcher>>;
    try {
        res = await fetcher(url);
    } catch (err) {
        if (err instanceof CimdError) throw err;
        throw new CimdError(`The client metadata document could not be fetched (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.status !== 200) throw new CimdError(`The client metadata document answered ${res.status}`);
    let doc: Record<string, unknown>;
    try {
        doc = JSON.parse(await res.text()) as Record<string, unknown>;
    } catch {
        throw new CimdError('The client metadata document is not JSON');
    }
    if (doc['client_id'] !== url) throw new CimdError('The client metadata document names another client_id');
    const name = typeof doc['client_name'] === 'string' ? doc['client_name'].trim() : '';
    if (!name) throw new CimdError('The client metadata document has no client_name');
    const redirectUris = Array.isArray(doc['redirect_uris']) ? doc['redirect_uris'].filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
    if (!redirectUris.length) throw new CimdError('The client metadata document has no redirect_uris');
    const value = { clientId: url, name: name.slice(0, 200), redirectUris };
    cache.set(url, { value, until: now + cacheSeconds(res.headers.get('cache-control')) * 1000 });
    return value;
}
