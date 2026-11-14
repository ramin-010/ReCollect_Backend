// Fails the integration run when two queries overlap on ONE pg connection.
//
// Prisma does that for `create/update({ include: <2+ relations> })` and for any include of 2+
// relations on a transaction client: it sends the relation queries concurrently on the
// transaction's connection. pg 8 only prints a one-time deprecation warning ("Calling
// client.query() when the client is already executing a query ...") and pg 9 will reject it.
// Fix: write with `select: { id: true }`, then read the relations one query at a time or after
// the transaction (see loadDocRow in src/services/docs/docs.service.ts).
//
// tests/integration/setup.ts installs the guard and checks it after each file.
import pg from 'pg';
import { expect } from 'vitest';

export interface OverlappingQuery {
    test: string;
    query: string;
    active: string;
}

const box = globalThis as unknown as { __pgOverlaps?: OverlappingQuery[] };

export function installPgConcurrencyGuard(): void {
    const proto = (pg as any).Client.prototype;
    if (proto.__recollectConcurrencyGuard) return;
    proto.__recollectConcurrencyGuard = true;
    const original = proto.query;
    proto.query = function guardedQuery(this: any, ...args: any[]) {
        if (this._activeQuery || this._queryQueue?.length > 0) {
            const sql = (q: any) => String(typeof q === 'string' ? q : q?.text ?? '').slice(0, 160);
            let test = '';
            try {
                test = expect.getState().currentTestName ?? '';
            } catch {
                // outside a test (hooks)
            }
            (box.__pgOverlaps ??= []).push({ test, query: sql(args[0]), active: sql(this._activeQuery) });
        }
        return original.apply(this, args);
    };
}

/** Overlapping queries recorded so far (and clears the list). */
export function takePgOverlaps(): OverlappingQuery[] {
    const found = box.__pgOverlaps ?? [];
    box.__pgOverlaps = [];
    return found;
}
