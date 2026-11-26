// The web addresses allowed to call the API (CORS) and to open the live-editing server's socket
// (MANAGER_AND_DOCS_PLAN D7). ALLOWED_ORIGINS (comma-separated) replaces the list when it is set
// (the deploy sets it); without it, the local and known addresses below.
const DEFAULT_ORIGINS = [
    'http://localhost:3005',
    'http://localhost:5173',
    'http://192.168.40.58:3005',
    'https://kaaga.in',
    'https://api.kaaga.in',
    'https://www.kaaga.in',
    // The old address until it lapses (22 Jan 2027): it redirects, but a tab left open still calls.
    'https://re-collect.in',
    'https://api.re-collect.in',
    'https://www.re-collect.in',
];

export function allowedOrigins(): string[] {
    const fromEnv = (process.env['ALLOWED_ORIGINS'] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean);
    return fromEnv.length ? fromEnv : DEFAULT_ORIGINS;
}
