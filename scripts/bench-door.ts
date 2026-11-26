// TOOL_ACCESS_PLAN §6.6: the web door under load, on dev with a QA token (plain fetch, no new package). 50 requests
// at a time for 30 seconds each of: tools/list; find_tools; use_read_tool → get_today; and, for the API's own time,
// GET /api/today with the same token. Gates (p95): tools/list under 15 ms; find_tools under 25 ms; the door's own
// share of a get_today call (the MCP call minus the API's time) under 15 ms; no errors.
// The QA tokens (10, shared by the workers) are made at the start and revoked at the end; they are never printed. With
// the per-token call limit (§6.3) on, run the backend with MCP_CALLS_PER_MINUTE raised for the bench.
//
//   npx ts-node --transpile-only scripts/bench-door.ts [--seconds 30] [--concurrency 50] [--api http://localhost:8002]
const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
};
const API = arg('--api') ?? 'http://localhost:8002';
const SECONDS = Number(arg('--seconds') ?? '30');
const CONCURRENCY = Number(arg('--concurrency') ?? '50');
// An account holds at most 20 active tokens (ACTIVE_TOKEN_LIMIT): the workers share 10.
const TOKENS = Number(arg('--tokens') ?? '10');

let cookie = '';
async function cookieApi<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${API}${path}`, { method, headers: { Cookie: cookie, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = (await res.json().catch(() => ({}))) as { data: T };
    return { status: res.status, data: json.data };
}

const pct = (xs: number[], p: number) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

async function load(name: string, tokens: string[], once: (token: string) => Promise<boolean>): Promise<{ name: string; n: number; errors: number; p50: number; p95: number; perSecond: number }> {
    const times: number[] = [];
    let errors = 0;
    const end = Date.now() + SECONDS * 1000;
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async (_, w) => {
            const token = tokens[w % tokens.length]!;
            while (Date.now() < end) {
                const t0 = performance.now();
                const ok = await once(token).catch(() => false);
                times.push(performance.now() - t0);
                if (!ok) errors += 1;
            }
        })
    );
    return { name, n: times.length, errors, p50: pct(times, 50), p95: pct(times, 95), perSecond: times.length / SECONDS };
}

let rpcId = 1;
async function rpc(token: string, method: string, params: unknown): Promise<{ ok: boolean; body: unknown }> {
    const res = await fetch(`${API}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    });
    const body = (await res.json().catch(() => null)) as { result?: { isError?: boolean }; error?: unknown } | null;
    return { ok: res.status === 200 && !!body?.result && !body.error && body.result.isError !== true, body };
}

async function main(): Promise<void> {
    const login = await fetch(`${API}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'qa@recollect.local', password: 'qapass123' }) });
    if (login.status !== 200) throw new Error(`login ${login.status}`);
    cookie = login.headers.getSetCookie().find((c) => c.startsWith('token='))!.split(';')[0]!;
    const made: Array<{ id: string; token: string }> = [];
    try {
        for (let i = 0; i < TOKENS; i++) {
            const r = await cookieApi<{ _id: string; token: string }>('POST', '/api/tokens', { name: `Door bench ${i + 1}`, scopes: ['read'] });
            if (r.status !== 201) throw new Error(`token ${r.status}`);
            made.push({ id: r.data._id, token: r.data.token });
        }
        const tokens = made.map((m) => m.token);
        // Warm up: each token once (its first lookup), the door's caches once.
        for (const t of tokens) await rpc(t, 'tools/list', {});
        const rows = [];
        rows.push(await load('tools/list', tokens, async (t) => (await rpc(t, 'tools/list', {})).ok));
        rows.push(await load('find_tools', tokens, async (t) => (await rpc(t, 'tools/call', { name: 'find_tools', arguments: { query: 'move a review to friday' } })).ok));
        rows.push(await load('use_read_tool → get_today', tokens, async (t) => (await rpc(t, 'tools/call', { name: 'use_read_tool', arguments: { name: 'get_today', args: {} } })).ok));
        rows.push(
            await load('GET /api/today (the API alone)', tokens, async (t) => {
                const res = await fetch(`${API}/api/today`, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' } });
                await res.arrayBuffer();
                return res.status === 200;
            })
        );
        for (const r of rows) console.log(`${r.name.padEnd(34)} n=${String(r.n).padStart(6)}  ${r.perSecond.toFixed(0).padStart(5)}/s  p50 ${r.p50.toFixed(1).padStart(6)} ms  p95 ${r.p95.toFixed(1).padStart(6)} ms  errors ${r.errors}`);
        const share = rows[2]!.p95 - rows[3]!.p95;
        console.log(`door's share of a get_today call (p95 difference): ${share.toFixed(1)} ms`);
        const gates = [
            ['tools/list p95 < 15 ms', rows[0]!.p95 < 15],
            ['find_tools p95 < 25 ms', rows[1]!.p95 < 25],
            ["the door's share p95 < 15 ms", share < 15],
            ['no errors', rows.every((r) => r.errors === 0)],
        ] as const;
        for (const [g, ok] of gates) console.log(`${ok ? 'pass' : 'FAIL'} ${g}`);
    } finally {
        for (const m of made) await cookieApi('DELETE', `/api/tokens/${m.id}`);
        console.log(`${made.length} bench tokens revoked.`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
