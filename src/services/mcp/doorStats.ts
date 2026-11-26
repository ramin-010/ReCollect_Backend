// TOOL_ACCESS_PLAN §6.3, §6.5 (11-27): the web door's call limit per token, and its counts.
//
// The limit: 90 tools/call a minute and 1,500 an hour per token (in memory, keyed by a hash of the token; each server
// process keeps its own). Over it, the answer is a normal JSON-RPC result holding a tool result with isError, which the
// model reads ("wait 20 seconds"): an HTTP 429 would show in the host as a broken connector. tools/list, initialize and
// notifications are not counted. MCP_CALLS_PER_MINUTE / MCP_CALLS_PER_HOUR change the numbers (the bench).
//
// The counts: each call's day, door, app (the token's name), tool, path (direct, use_tool, use_read_tool) and outcome,
// with its time, added up in memory and written every 60 seconds and at shutdown as increments of McpToolStat. No user,
// no arguments, no text.
import { createHash } from 'crypto';
import { prisma } from '../../db/prisma';

export const CALLS_PER_MINUTE = Number(process.env['MCP_CALLS_PER_MINUTE'] ?? 90);
export const CALLS_PER_HOUR = Number(process.env['MCP_CALLS_PER_HOUR'] ?? 1500);
export const LIMITED_MINUTE = 'Too many Kaaga calls in a minute. Wait 20 seconds, then go on.';
export const LIMITED_HOUR = 'Too many Kaaga calls this hour. Wait a few minutes, then go on; the user can keep going in the Kaaga app meanwhile.';

interface Window {
    start: number;
    count: number;
}
const windows = new Map<string, { minute: Window; hour: Window }>();

const keyOf = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 32);

/** One more tools/call for this token: null when it may run, else the words the model gets. */
export function takeCall(token: string, now = Date.now(), limits = { minute: CALLS_PER_MINUTE, hour: CALLS_PER_HOUR }): string | null {
    const key = keyOf(token);
    let w = windows.get(key);
    if (!w) {
        w = { minute: { start: now, count: 0 }, hour: { start: now, count: 0 } };
        windows.set(key, w);
    }
    if (now - w.minute.start >= 60_000) w.minute = { start: now, count: 0 };
    if (now - w.hour.start >= 3_600_000) w.hour = { start: now, count: 0 };
    if (w.hour.count >= limits.hour) return LIMITED_HOUR;
    if (w.minute.count >= limits.minute) return LIMITED_MINUTE;
    w.minute.count += 1;
    w.hour.count += 1;
    // Old windows go now and then, so the map holds only the last hour's tokens.
    if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.hour.start >= 3_600_000) windows.delete(k);
    return null;
}

export function resetLimitsForTests(): void {
    windows.clear();
}

// ─── The counts ──────────────────────────────────────────────────────

export interface ToolCall {
    door: string;
    app: string;
    tool: string;
    via: string;
    outcome: string;
    ms: number;
}

const pending = new Map<string, { day: string; door: string; app: string; tool: string; via: string; outcome: string; count: number; msTotal: number }>();
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function recordToolCall(c: ToolCall, now: Date = new Date()): void {
    const row = { day: now.toISOString().slice(0, 10), door: cut(c.door, 12), app: cut(c.app || 'Remote MCP', 60), tool: cut(c.tool, 60), via: cut(c.via, 16), outcome: cut(c.outcome, 16) };
    const key = [row.day, row.door, row.app, row.tool, row.via, row.outcome].join('\u0000');
    const was = pending.get(key);
    if (was) {
        was.count += 1;
        was.msTotal += Math.max(0, Math.round(c.ms));
    } else pending.set(key, { ...row, count: 1, msTotal: Math.max(0, Math.round(c.ms)) });
}

/** Writes what was added up as increments (several processes each add their own); answers how many rows. */
export async function flushToolStats(): Promise<number> {
    if (!pending.size) return 0;
    const rows = [...pending.values()];
    pending.clear();
    for (const r of rows) {
        await prisma.mcpToolStat
            .upsert({
                where: { day_door_app_tool_via_outcome: { day: r.day, door: r.door, app: r.app, tool: r.tool, via: r.via, outcome: r.outcome } },
                create: r,
                update: { count: { increment: r.count }, msTotal: { increment: r.msTotal } },
            })
            .catch((err: unknown) => console.error('[mcp] tool stats:', err instanceof Error ? err.message : String(err)));
    }
    return rows.length;
}

let timer: NodeJS.Timeout | null = null;
/** Every 60 seconds while the server runs (not under tests); the shutdown routine flushes the rest. */
export function startToolStats(): void {
    if (timer || process.env['NODE_ENV'] === 'test') return;
    timer = setInterval(() => void flushToolStats(), 60_000);
    timer.unref();
}
