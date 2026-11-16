// Graceful shutdown (hosting P1-2). On SIGTERM or SIGINT (systemd stopping or restarting the
// service; Ctrl+C in a terminal) the server, in this order:
//   1. stops accepting connections (idle keep-alive sockets close now);
//   2. stops the background jobs: no new runs, and the passes in progress finish;
//   3. stores every live document still loaded (Hocuspocus closes its sockets and stores each one);
//   4. writes the awake meter's state;
//   5. closes the database pool;
// then exits 0, or 1 if that took longer than 20 seconds.
//
// Windows cannot deliver SIGTERM to a Node process as a signal (it ends it at once), so a process
// started with an IPC channel also shuts down on the message 'shutdown' (the test of this file
// uses it on Windows; on Linux it sends the real signal).
import type { Server as HttpServer } from 'node:http';

export const SHUTDOWN_LIMIT_MS = 20_000;

export interface ShutdownParts {
    server: HttpServer;
    /** Stops the timers and waits for the passes running (src/services/scheduler/jobs.ts). */
    stopJobs: () => Promise<void>;
    /** Closes the live-editing sockets and stores every loaded document (Hocuspocus's destroy()). */
    storeDocuments: () => Promise<unknown>;
    /** The awake meter's state, written now. */
    flushState: () => void;
    /** The database pool, closed. */
    closeDatabase: () => Promise<void>;
    log?: (line: string) => void;
    exit?: (code: number) => void;
    limitMs?: number;
}

const step = async (name: string, work: () => Promise<unknown> | unknown, log: (line: string) => void): Promise<void> => {
    try {
        await work();
    } catch (err) {
        log(`[shutdown] ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
};

/** The shutdown routine; calling it again (a second signal) returns the same run. */
export function makeShutdown(parts: ShutdownParts): (reason: string) => Promise<void> {
    const log = parts.log ?? ((line) => console.log(line));
    const exit = parts.exit ?? ((code) => process.exit(code));
    let running: Promise<void> | null = null;
    return (reason: string) => {
        if (running) return running;
        running = (async () => {
            const started = Date.now();
            log(`[shutdown] ${reason}: stopping`);
            const limit = setTimeout(() => {
                log(`[shutdown] not done after ${(parts.limitMs ?? SHUTDOWN_LIMIT_MS) / 1000} s: exiting anyway`);
                exit(1);
            }, parts.limitMs ?? SHUTDOWN_LIMIT_MS);
            limit.unref?.();

            const closed = new Promise<void>((resolve) => parts.server.close(() => resolve()));
            parts.server.closeIdleConnections?.();
            await step('the background jobs', parts.stopJobs, log);
            await step('the live documents', parts.storeDocuments, log);
            await step('the awake meter', parts.flushState, log);
            await step('the database', parts.closeDatabase, log);
            parts.server.closeAllConnections?.();
            await Promise.race([closed, new Promise((r) => setTimeout(r, 1_000))]);
            clearTimeout(limit);
            log(`[shutdown] done in ${Date.now() - started} ms`);
            exit(0);
        })();
        return running;
    };
}

/** src/index.ts: SIGTERM, SIGINT and (with an IPC channel) the message 'shutdown' run the routine. */
export function installShutdown(parts: ShutdownParts): (reason: string) => Promise<void> {
    const shutdown = makeShutdown(parts);
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
    if (process.send) {
        process.on('message', (message) => {
            if (message === 'shutdown') void shutdown('asked over IPC');
        });
    }
    return shutdown;
}
