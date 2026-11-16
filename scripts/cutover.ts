// Phase 5's clean-up of the restored data (hosting blueprint phase 5 step 5; review A5).
// What it does: scripts/lib/cutover.ts. Which database: DATABASE_URL exactly as this process was
// started with it, never a .env file (scripts/lib/target.ts). The dev database is refused, and so is
// any database on this machine that is not a disposable copy (recollect_test_*, restore_*).
//
//   a dry run (the default; it only reads):
//     DATABASE_URL="<target>" node dist-scripts/scripts/cutover.js --owner-email <real address>
//   apply (asks for the new password twice, hidden; --password-stdin reads one line from stdin instead):
//     DATABASE_URL="<target>" node dist-scripts/scripts/cutover.js --owner-email <real address> --execute --confirm <database name>
//   options:
//     --from-email <address>      the account that becomes the owner's (default dev@recollect.local)
//     --delete-account <address>  an account to delete with the QA ones (repeatable; only on the owner's word)
//
// Exit code 0: done (or the dry run's plan printed); 1: refused or failed, and nothing was changed.
import { describeTarget, resolveTarget, TargetError } from './lib/target'; // first: it reads DATABASE_URL before any app module can load a .env file
import type { CutoverPlan, CutoverResult } from './lib/cutover';

const USAGE = [
    'usage: DATABASE_URL=<target> node dist-scripts/scripts/cutover.js --owner-email <address>',
    '         [--from-email <address>] [--delete-account <address>]... [--execute --confirm <database name>] [--password-stdin]',
    'A dry run unless --execute. The target is DATABASE_URL as given to this process (never a .env file).',
].join('\n');

class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

interface Args {
    ownerEmail?: string;
    fromEmail?: string;
    deleteEmails: string[];
    execute: boolean;
    confirm?: string;
    passwordStdin: boolean;
    help: boolean;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { deleteEmails: [], execute: false, passwordStdin: false, help: false };
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
        switch (flag) {
            case '--owner-email':
                args.ownerEmail = value();
                break;
            case '--from-email':
                args.fromEmail = value();
                break;
            case '--delete-account':
                args.deleteEmails.push(value());
                break;
            case '--confirm':
                args.confirm = value();
                break;
            case '--execute':
                args.execute = true;
                break;
            case '--password-stdin':
                args.passwordStdin = true;
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
            default:
                throw new UsageError(`unknown option ${raw}`);
        }
    }
    return args;
}

const log = (line: string) => console.log(`[cutover] ${line}`);

/** A line typed at the terminal without showing it. */
function askHidden(question: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        if (!stdin.isTTY) {
            reject(new UsageError('no terminal to ask for the password: pipe it in with --password-stdin'));
            return;
        }
        process.stdout.write(question);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let value = '';
        const finish = (err?: Error) => {
            stdin.off('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stdout.write('\n');
            if (err) reject(err);
            else resolve(value);
        };
        const onData = (chunk: string) => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') return finish();
                if (ch === '\u0003') return finish(new UsageError('cancelled'));
                if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
                else if (ch >= ' ') value += ch;
            }
        };
        stdin.on('data', onData);
    });
}

async function readPassword(fromStdin: boolean, problem: (password: string) => string | null): Promise<string> {
    let password: string;
    if (fromStdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
        // Windows PowerShell may put a byte-order mark before piped text; it is never part of a password.
        password = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
    } else {
        password = await askHidden('New password for the owner (not shown): ');
        if ((await askHidden('The same again: ')) !== password) throw new UsageError('the two passwords differ; nothing was changed');
    }
    const why = problem(password);
    if (why) throw new UsageError(`the password needs ${why}; nothing was changed`);
    return password;
}

function printPlan(plan: CutoverPlan): void {
    const o = plan.owner;
    log(`owner: ${o.rename ? `${o.from} becomes ${o.to}` : `${o.to} (already the owner's address)`}; morning email ${o.morningEmail === 'follows' ? 'follows the sign-in address' : 'kept (a separate address)'}; a new password`);
    log(`accounts deleted with all they own: ${plan.deleteAccounts.length ? plan.deleteAccounts.map((a) => `${a.email} (${a.why})`).join(', ') : 'none'}${plan.notFound.length ? ` · not found: ${plan.notFound.join(', ')}` : ''}`);
    log(
        `accounts that stay besides the owner: ${
            plan.staying.length
                ? plan.staying.map((a) => `${a.email} (${a.placeholder ? 'placeholder' : `can sign in with ${a.signIn}`}, ${a.docs} doc(s))`).join(', ')
                : 'none'
        }`
    );
    const c = plan.counts;
    log(
        `then: revoke ${c.liveTokens} access token(s) · delete ${c.refreshTokens} OAuth refresh token(s), ${c.oauthCodes} OAuth sign-in code(s), ${c.pushSubscriptions} push subscription(s), ${c.emailCodes} email code(s) (the deleted accounts' own go with them) · keep ${c.oauthClients} OAuth client registration(s) (they hold no access)`
    );
    log("sign-in cookies: production's own JWT_SECRET ends every dev session; nothing stored to revoke");
}

function printResult(r: CutoverResult): void {
    log(
        `done: ${r.deletedAccounts} account(s) deleted · owner ${r.ownerRenamed ? 'renamed and ' : ''}given the new password · ${r.revokedTokens} access token(s) revoked · deleted ${r.deletedRefreshTokens} refresh token(s), ${r.deletedOauthCodes} OAuth code(s), ${r.deletedPushSubscriptions} push subscription(s), ${r.deletedEmailCodes} email code(s)`
    );
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        return 0;
    }
    if (!args.ownerEmail) throw new UsageError('--owner-email is required');
    const target = resolveTarget({ purpose: 'cutover' });
    log(`target ${describeTarget(target)} · ${args.execute ? 'EXECUTE' : `dry run, nothing changes (to apply: --execute --confirm ${target.database})`}`);
    if (args.execute && args.confirm !== target.database) {
        throw new TargetError(`--execute needs --confirm ${target.database}: the target database's name, typed by hand`);
    }

    const { prisma, disconnectPrisma } = await import('../src/db/prisma');
    try {
        if (process.env.DATABASE_URL !== target.url) throw new TargetError("the app's database client is not the checked target; nothing was done");
        const cut = await import('./lib/cutover');
        const opts = { ownerEmail: args.ownerEmail, deleteEmails: args.deleteEmails, ...(args.fromEmail ? { fromEmail: args.fromEmail } : {}) };
        const plan = await cut.planCutover(prisma, opts); // refuses before the password is asked
        printPlan(plan);
        if (!args.execute) {
            log('dry run: nothing was changed.');
            return 0;
        }
        const password = await readPassword(args.passwordStdin, cut.passwordProblem);
        const { hashPassword } = await import('../src/services/auth/password');
        const { result } = await cut.applyCutover(prisma, opts, await hashPassword(password));
        printResult(result);
        const problems = await cut.verifyCutover(prisma, opts, password);
        if (problems.length > 0) {
            log(`NOT verified: ${problems.join('; ')}`);
            return 1;
        }
        log(`verified: ${plan.owner.to} signs in with the new password; no QA account, live access token, refresh token, OAuth code, push subscription or email code is left.`);
        return 0;
    } finally {
        await disconnectPrisma();
    }
}

main()
    .then((code) => {
        process.exitCode = code;
    })
    .catch((err: unknown) => {
        const e = err as { name?: string; message?: string; code?: string };
        if (e?.name === 'TargetError' || e?.name === 'CutoverRefusal' || e?.name === 'UsageError') {
            console.error(`[cutover] refused: ${e.message}`);
            if (e.name === 'UsageError') console.error(USAGE);
        } else {
            console.error(`[cutover] failed: ${e?.name ?? 'Error'}${typeof e?.code === 'string' ? ` ${e.code}` : ''}: ${e?.message ?? String(err)}`);
            console.error('[cutover] the clean-up is one transaction: all of it happened or none of it did; a dry run shows which.');
        }
        process.exitCode = 1;
    });
