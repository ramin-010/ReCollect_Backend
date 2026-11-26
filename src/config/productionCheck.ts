// Refuse a bad production start (hosting P1-10). With NODE_ENV=production the server exits with a
// clear message, before the app or any timer loads, when a setting would leave it unsafe. Dev and
// tests never reach the checks. The message names settings, never their values.

/** At least this many characters for JWT_SECRET (it signs every login cookie). */
export const JWT_SECRET_MIN = 32;

const LOOPBACK_IP = /^(?:127(?:\.\d{1,3}){3}|::1)$/;

/** A database on this machine: no host (a socket), a socket path, localhost or a loopback address. */
function isLocalHost(host: string): boolean {
    const h = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
    return h === '' || h.startsWith('/') || h === 'localhost' || LOOPBACK_IP.test(h);
}

/** DATABASE_URL's problem, if any: a database on another host must be reached with TLS verified. */
function databaseProblem(raw: string | undefined): string | null {
    if (!raw?.trim()) return 'DATABASE_URL is unset';
    // Parsed as pg parses it: a URL with no host (`user:pw@/db?host=/socket/dir`) gets a stand-in host.
    const DUMMY = 'no-host.invalid';
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        try {
            url = new URL(raw.trim().replace('@/', `@${DUMMY}/`));
        } catch {
            return 'DATABASE_URL is not a valid connection URL';
        }
    }
    // pg reads ?host= before the URL's own host (a socket path, for example).
    const host = url.searchParams.get('host') ?? (url.hostname === DUMMY ? '' : url.hostname);
    if (isLocalHost(host)) return null;
    if (url.searchParams.get('sslmode')?.toLowerCase() !== 'verify-full') {
        return 'DATABASE_URL must verify TLS for a database on another host: add sslmode=verify-full';
    }
    return null;
}

/** Everything wrong with these settings for production; empty when NODE_ENV is not production. */
export function productionProblems(env: NodeJS.ProcessEnv = process.env): string[] {
    if (env['NODE_ENV'] !== 'production') return [];
    const problems: string[] = [];

    if ((env['JWT_SECRET'] ?? '').trim().length < JWT_SECRET_MIN) {
        problems.push(`JWT_SECRET must be at least ${JWT_SECRET_MIN} characters (it signs every login)`);
    }

    // Read as src/config/origins.ts reads it: without ALLOWED_ORIGINS the built-in dev list would apply.
    const origins = (env['ALLOWED_ORIGINS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!origins.length) problems.push("ALLOWED_ORIGINS must list the web app's address (unset, the dev list would apply)");

    const self = env['RECOLLECT_SELF_URL']?.trim();
    let selfIsHttps = false;
    try {
        selfIsHttps = !!self && new URL(self).protocol === 'https:';
    } catch {
        selfIsHttps = false;
    }
    if (!selfIsHttps) problems.push("RECOLLECT_SELF_URL must be the server's public https address");

    const host = env['HOST']?.trim() ?? '';
    if (!LOOPBACK_IP.test(host.replace(/^\[(.*)\]$/, '$1'))) {
        problems.push(host ? 'HOST must be a loopback address such as 127.0.0.1' : 'HOST is unset: the API would listen on every network; set HOST=127.0.0.1');
    }

    const signup = env['SIGNUP_MODE']?.trim().toLowerCase() ?? '';
    if (signup !== 'allowlist' && signup !== 'closed') {
        problems.push(signup ? 'SIGNUP_MODE must be allowlist or closed' : 'SIGNUP_MODE is unset: signup would be open to anyone; set allowlist or closed');
    }

    if (env['ASSISTANT_FAKE']?.trim()) problems.push("ASSISTANT_FAKE must be unset (it swaps Ask Kaaga's model for a scripted stand-in)");

    // Hosting review A8: TLS checks switched off for the whole process (the database, the AI, email).
    if (env['NODE_TLS_REJECT_UNAUTHORIZED']?.trim() === '0') problems.push('NODE_TLS_REJECT_UNAUTHORIZED=0 must be removed (it switches off every TLS check)');

    // Hosting review A1: /oauth/authorize reads client metadata before login: only from listed hosts.
    if (!env['OAUTH_CIMD_HOSTS']?.split(',').some((h) => h.trim())) problems.push('OAUTH_CIMD_HOSTS must list the hosts whose client metadata may be read (claude.ai)');

    const db = databaseProblem(env['DATABASE_URL']);
    if (db) problems.push(db);

    return problems;
}

/**
 * Called first by src/index.ts: with NODE_ENV=production and any problem, prints them and exits 1.
 * `exit` and `log` are for the tests.
 */
export function refuseUnsafeProductionStart(
    env: NodeJS.ProcessEnv = process.env,
    exit: (code: number) => void = (code) => process.exit(code),
    log: (message: string) => void = (message) => console.error(message),
): void {
    const problems = productionProblems(env);
    if (!problems.length) return;
    log(`Refusing to start: NODE_ENV=production with unsafe settings (fix them in the server's env file):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    exit(1);
}
