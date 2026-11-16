// The office-data filter on a disposable copy of a dev dump (hosting review A6; the Phase 2 seed and
// Phase 5's option). What it deletes and why: scripts/lib/officeFilter.ts; --print-sql shows every
// statement. Only a disposable copy is accepted (recollect_test_*, restore_*), on any host: never the
// dev database, never production. The database is DATABASE_URL as given to this process (never a .env
// file); it uses node-postgres alone, no app module.
//
//   a dry run (the default; everything runs in a transaction that is rolled back):
//     DATABASE_URL="<copy>" node dist-scripts/scripts/office-filter.js [--office-key <key>]... [--clear-derived]
//   apply:     ... --execute --confirm <database name>
//   re-count on a restore of the filtered dump (read only):  ... --recount --office-key <each key the filter used>
//   the SQL:   node dist-scripts/scripts/office-filter.js --print-sql [--clear-derived]
//
// Exit code 0: done and verified (or a dry run, or a re-count of zero); 1: refused, failed or not zero.
import { describeTarget, resolveTarget, TargetError } from './lib/target'; // first: it reads DATABASE_URL before anything can load a .env file
import { countOfficeRowsLeft, filterSqlText, FILTER_STEPS, runOfficeFilter, type FilterResult } from './lib/officeFilter';

class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

interface Args {
    keys: string[];
    clearDerived: boolean;
    execute: boolean;
    confirm?: string;
    recount: boolean;
    printSql: boolean;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { keys: [], clearDerived: false, execute: false, recount: false, printSql: false };
    for (let i = 0; i < argv.length; i += 1) {
        const raw = argv[i] ?? '';
        const eq = raw.indexOf('=');
        const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
        const value = (): string => {
            if (raw.startsWith('--') && eq > 0) return raw.slice(eq + 1);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`);
            i += 1;
            return next;
        };
        if (flag === '--office-key') args.keys.push(value());
        else if (flag === '--confirm') args.confirm = value();
        else if (flag === '--clear-derived') args.clearDerived = true;
        else if (flag === '--execute') args.execute = true;
        else if (flag === '--recount') args.recount = true;
        else if (flag === '--print-sql') args.printSql = true;
        else throw new UsageError(`unknown option ${raw}`);
    }
    return args;
}

const log = (line: string) => console.log(`[office-filter] ${line}`);
const list = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');

function printResult(r: FilterResult, clearDerived: boolean): void {
    log(`project keys in this copy: ${r.projectKeys.join(', ') || 'none'}`);
    log(`office keys: ${r.keys.join(', ') || 'none'} (flagged in the data, plus any --office-key); office rows in ${r.accounts} account(s)`);
    const verb = r.executed ? 'deleted' : 'would delete';
    log(`${verb}: ${FILTER_STEPS.filter((s) => !s.derived).map((s) => `${r.counts[s.name] ?? 0} ${s.label}`).join(', ')}`);
    if (clearDerived) log(`${r.executed ? 'cleared' : 'would clear'} (--clear-derived): ${FILTER_STEPS.filter((s) => s.derived).map((s) => `${r.counts[s.name] ?? 0} ${s.label}`).join(', ')}`);
    else log("the buddy's own writing (portrait, day lines, chapters) is kept: add --clear-derived to clear it (it may mention office work)");
    const named = Object.entries(r.mentions).filter(([, n]) => n > 0);
    log(`office keys still named as a word afterwards (counts only, never deleted): ${named.length ? named.map(([k, n]) => `${k} ${n}`).join(', ') : 'none'}`);
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));
    if (args.printSql) {
        console.log(filterSqlText(args.clearDerived));
        return 0;
    }
    const target = resolveTarget({ purpose: 'scratch' });
    const mode = args.recount ? 'a re-count, read only' : args.execute ? 'EXECUTE' : `dry run, nothing changes (to apply: --execute --confirm ${target.database})`;
    log(`target ${describeTarget(target)} · ${mode}`);
    if (args.execute && args.confirm !== target.database) {
        throw new TargetError(`--execute needs --confirm ${target.database}: the target database's name, typed by hand`);
    }
    const { Client } = await import('pg');
    const db = new Client({ connectionString: target.url });
    await db.connect();
    try {
        if (args.recount) {
            if (args.keys.length === 0) throw new UsageError('--recount needs the office keys the filter used (--office-key, one per key)');
            const left = await countOfficeRowsLeft(db, args.keys);
            const total = Object.values(left).reduce((a, b) => a + b, 0);
            log(`office rows left for ${args.keys.join(', ')}: ${list(left)}`);
            log(total === 0 ? 'verified: none left.' : 'NOT zero.');
            return total === 0 ? 0 : 1;
        }
        const result = await runOfficeFilter(db, { officeKeys: args.keys, clearDerived: args.clearDerived }, args.execute);
        printResult(result, args.clearDerived);
        const leftInRun = Object.values(result.left).reduce((a, b) => a + b, 0);
        if (!args.execute) {
            log(`dry run: nothing was changed (afterwards ${leftInRun === 0 ? 'no office row would be left' : `${leftInRun} office row(s) would be left`}).`);
            return 0;
        }
        const left = await countOfficeRowsLeft(db, result.keys);
        const total = Object.values(left).reduce((a, b) => a + b, 0);
        log(total === 0 ? `verified: no office row left (${list(left)}). Next: pg_dump this copy, restore the dump elsewhere, run --recount with ${result.keys.map((k) => `--office-key ${k}`).join(' ') || 'the same keys'}.` : `NOT verified: ${list(left)}`);
        return total === 0 ? 0 : 1;
    } finally {
        await db.end();
    }
}

main()
    .then((code) => {
        process.exitCode = code;
    })
    .catch((err: unknown) => {
        const e = err as { name?: string; message?: string; code?: string };
        if (e?.name === 'TargetError' || e?.name === 'UsageError') console.error(`[office-filter] refused: ${e.message}`);
        else {
            console.error(`[office-filter] failed: ${e?.name ?? 'Error'}${typeof e?.code === 'string' ? ` ${e.code}` : ''}: ${e?.message ?? String(err)}`);
            console.error('[office-filter] the filter is one transaction: a failure inside it changes nothing; a dry run or --recount shows the state.');
        }
        process.exitCode = 1;
    });
