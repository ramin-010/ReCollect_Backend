// The cutover's clean-up (hosting blueprint phase 5, step 5 "clean before opening"; review A5). It runs
// on the production database right after the dev dump was restored into it, or on a disposable copy:
//   - the QA accounts, and any account named with --delete-account, are deleted with all they own;
//   - the owner's account takes the real address (and its morning email with it, when that went to the
//     old address) and a new password, hashed by the app's own module (src/services/auth/password.ts);
//   - every access token is revoked (the rows stay, for the list in Settings › Agents). OAuth refresh
//     tokens and sign-in codes are deleted, so no connection survives;
//   - push subscriptions and pending email codes are deleted.
// Sign-in cookies need nothing here: production's own JWT_SECRET makes every dev session invalid.
//
// planCutover only reads. applyCutover plans and writes in one transaction, so a refusal or a failure
// changes nothing, and a second run finds nothing left to do. Counts only, never content; the
// addresses of accounts that stay are masked. Queries run one at a time (a transaction client must
// never run two at once).
import type { AppPrismaClient, DbClient } from '../../src/db/prisma';
import { verifyPassword } from '../../src/services/auth/password';

export const QA_EMAILS: readonly string[] = ['qa@recollect.local', 'qa2@recollect.local'];
export const DEFAULT_FROM_EMAIL = 'dev@recollect.local';
export const MIN_PASSWORD_LENGTH = 12;
/** Passwords of the dev setup and the tests: never the owner's in production. */
const DEV_PASSWORDS = new Set(['devpass123', 'qapass123', 'password123']);

export class CutoverRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CutoverRefusal';
    }
}

export interface CutoverOptions {
    /** The owner's real address (stored lower-case, as login looks it up). */
    ownerEmail: string;
    /** The account in the restored data that becomes the owner's (default dev@recollect.local). */
    fromEmail?: string;
    /** Accounts to delete besides the QA ones, named one by one on the owner's word. */
    deleteEmails?: string[];
}

export interface CutoverPlan {
    owner: { id: string; from: string; to: string; rename: boolean; morningEmail: 'follows' | 'kept' };
    /** Deleted with everything they own. */
    deleteAccounts: Array<{ id: string; email: string; why: 'qa' | 'named' }>;
    /** QA or named addresses with no account (normal on a second run). */
    notFound: string[];
    /** Accounts that stay besides the owner (masked). Unless they are placeholders, they can still sign in. */
    staying: Array<{ email: string; placeholder: boolean; signIn: string; docs: number }>;
    /** What applying revokes or deletes, besides what goes with the deleted accounts (equal to its result). */
    counts: { liveTokens: number; refreshTokens: number; oauthCodes: number; pushSubscriptions: number; emailCodes: number; oauthClients: number };
}

export interface CutoverResult {
    deletedAccounts: number;
    ownerRenamed: boolean;
    revokedTokens: number;
    deletedRefreshTokens: number;
    deletedOauthCodes: number;
    deletedPushSubscriptions: number;
    deletedEmailCodes: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalise(email: string, what: string): string {
    const e = email.trim().toLowerCase();
    if (!EMAIL.test(e)) throw new CutoverRefusal(`${what} is not an email address.`);
    return e;
}

/** a***z@example.org: enough for the owner to recognise an address, not enough to spread it through a log. */
export function maskEmail(email: string): string {
    const at = email.lastIndexOf('@');
    const local = at >= 0 ? email.slice(0, at) : email;
    const domain = at >= 0 ? email.slice(at + 1) : '';
    const shown = local.length <= 2 ? `${local.slice(0, 1)}*` : `${local[0]}***${local[local.length - 1]}`;
    return domain ? `${shown}@${domain}` : shown;
}

/** Why a new owner password is refused, or null when it is fine. */
export function passwordProblem(password: string): string | null {
    if (password.length < MIN_PASSWORD_LENGTH) return `at least ${MIN_PASSWORD_LENGTH} characters`;
    if (password.trim() !== password) return 'no space at the start or the end (a pasted space would lock the owner out)';
    if (DEV_PASSWORDS.has(password)) return 'to differ from the passwords the dev setup and the tests use';
    return null;
}

const ACCOUNT = { id: true, email: true, reminderEmail: true, isGhost: true, authProvider: true } as const;
type Account = { id: string; email: string; reminderEmail: string | null; isGhost: boolean; authProvider: string };

/** The account with this address in any letter case (addresses are not lower-cased everywhere). */
async function accountByEmail(db: DbClient, email: string): Promise<Account | null> {
    const found: Account[] = await db.user.findMany({ where: { email: { equals: email, mode: 'insensitive' } }, select: ACCOUNT });
    if (found.length > 1) throw new CutoverRefusal(`${found.length} accounts use ${maskEmail(email)} in different letter cases; resolve that by hand first.`);
    return found[0] ?? null;
}

/** What the cutover would do, read only. Throws CutoverRefusal when it must not run. */
export async function planCutover(db: DbClient, opts: CutoverOptions): Promise<CutoverPlan> {
    const to = normalise(opts.ownerEmail, 'The owner address');
    const from = normalise(opts.fromEmail ?? DEFAULT_FROM_EMAIL, 'The address to take over');
    const named = [...new Set((opts.deleteEmails ?? []).map((e) => normalise(e, 'An address to delete')))];
    if (QA_EMAILS.includes(to)) throw new CutoverRefusal('The owner address cannot be a QA address.');
    if (QA_EMAILS.includes(from)) throw new CutoverRefusal('A QA account cannot become the owner.');
    if (named.includes(from)) throw new CutoverRefusal(`--delete-account names ${from}, the account that becomes the owner.`);

    // Whose account is the owner's afterwards?
    const holder = await accountByEmail(db, to); // already has the real address
    const source = from === to ? holder : await accountByEmail(db, from);
    let owner: Account;
    let deleteHolder = false;
    if (holder && (!source || holder.id === source.id)) {
        // already cut over (a second run), or the address was the real one all along
        if (named.includes(to)) throw new CutoverRefusal('--delete-account names the owner account itself.');
        owner = holder;
    } else if (source && !holder) {
        owner = source;
    } else if (source && holder) {
        if (!named.includes(to)) {
            const docs = await db.doc.count({ where: { userId: holder.id } });
            const kind = holder.isGhost ? 'a placeholder' : `signs in with ${holder.authProvider}`;
            throw new CutoverRefusal(
                `${to} is already used by another account (${kind}, ${docs} doc(s)). To delete that account and give its address to ${from}, add --delete-account ${to}; or choose another address.`
            );
        }
        owner = source;
        deleteHolder = true;
    } else {
        throw new CutoverRefusal(`No owner account: neither ${to} nor ${from} exists in this database.`);
    }
    if (owner.isGhost) throw new CutoverRefusal('The owner account is a placeholder that never signed up; resolve that by hand.');

    // The accounts to delete: the QA ones, then the named ones.
    const deleteAccounts: CutoverPlan['deleteAccounts'] = [];
    const notFound: string[] = [];
    for (const email of QA_EMAILS) {
        const account = await accountByEmail(db, email);
        if (account) deleteAccounts.push({ id: account.id, email: account.email, why: 'qa' });
        else notFound.push(email);
    }
    for (const email of named) {
        if (QA_EMAILS.includes(email)) continue;
        const account = email === to ? (deleteHolder ? holder : null) : await accountByEmail(db, email);
        if (!account) {
            notFound.push(email);
            continue;
        }
        if (account.id === owner.id) throw new CutoverRefusal('--delete-account names the owner account itself.');
        deleteAccounts.push({ id: account.id, email: account.email, why: 'named' });
    }
    const deleteIds = deleteAccounts.map((a) => a.id);

    // Deleting an account deletes the workspaces it owns, and every member's tasks in them.
    if (deleteIds.length > 0) {
        const shared = await db.workspace.count({ where: { ownerId: { in: deleteIds }, members: { some: { userId: { notIn: deleteIds } } } } });
        if (shared > 0) {
            throw new CutoverRefusal(`${shared} workspace(s) owned by an account to delete have other members, whose tasks would go too; move or remove them first.`);
        }
    }

    // The morning email follows the sign-in address when it went to the old one.
    const follows = owner.reminderEmail === null || owner.reminderEmail.toLowerCase() === owner.email.toLowerCase();
    if (follows && owner.reminderEmail?.toLowerCase() !== to) {
        const clash = await db.user.count({ where: { id: { notIn: [owner.id, ...deleteIds] }, reminderEmail: { equals: to, mode: 'insensitive' } } });
        if (clash > 0) throw new CutoverRefusal(`Another account sends its morning email to ${to}; change that first.`);
    }

    const others: Account[] = await db.user.findMany({ where: { id: { notIn: [owner.id, ...deleteIds] } }, select: ACCOUNT, orderBy: { createdAt: 'asc' } });
    const staying: CutoverPlan['staying'] = [];
    for (const account of others) {
        const docs = await db.doc.count({ where: { userId: account.id } });
        staying.push({ email: maskEmail(account.email), placeholder: account.isGhost, signIn: account.authProvider, docs });
    }

    // What applying will change (the deleted accounts' own rows go with them, so they are not counted).
    const kept = { notIn: deleteIds };
    const liveTokens = await db.apiToken.count({ where: { revokedAt: null, userId: kept } });
    const refreshTokens = await db.oAuthRefreshToken.count({ where: { apiToken: { userId: kept } } });
    const oauthCodes = await db.oAuthCode.count({ where: { userId: kept } });
    const pushSubscriptions = await db.pushSubscription.count({ where: { userId: kept } });
    const emailCodes = await db.otp.count();
    const oauthClients = await db.oAuthClient.count();

    return {
        owner: { id: owner.id, from: owner.email, to, rename: owner.email !== to, morningEmail: follows ? 'follows' : 'kept' },
        deleteAccounts,
        notFound,
        staying,
        counts: { liveTokens, refreshTokens, oauthCodes, pushSubscriptions, emailCodes, oauthClients },
    };
}

/** Plan and apply in one transaction. passwordHash comes from hashPassword() of the app. */
export async function applyCutover(db: AppPrismaClient, opts: CutoverOptions, passwordHash: string): Promise<{ plan: CutoverPlan; result: CutoverResult }> {
    return db.$transaction(
        async (tx) => {
            const plan = await planCutover(tx, opts);
            const ids = plan.deleteAccounts.map((a) => a.id);
            const deletedAccounts = ids.length > 0 ? (await tx.user.deleteMany({ where: { id: { in: ids } } })).count : 0;
            await tx.user.update({
                where: { id: plan.owner.id },
                data: { email: plan.owner.to, password: passwordHash, ...(plan.owner.morningEmail === 'follows' ? { reminderEmail: plan.owner.to } : {}) },
                select: { id: true },
            });
            const revokedTokens = (await tx.apiToken.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date() } })).count;
            const deletedRefreshTokens = (await tx.oAuthRefreshToken.deleteMany({})).count;
            const deletedOauthCodes = (await tx.oAuthCode.deleteMany({})).count;
            const deletedPushSubscriptions = (await tx.pushSubscription.deleteMany({})).count;
            const deletedEmailCodes = (await tx.otp.deleteMany({})).count;
            return {
                plan,
                result: { deletedAccounts, ownerRenamed: plan.owner.rename, revokedTokens, deletedRefreshTokens, deletedOauthCodes, deletedPushSubscriptions, deletedEmailCodes },
            };
        },
        { maxWait: 10_000, timeout: 120_000 }
    );
}

/** After applyCutover, read back what must be true; returns the problems (none = verified). */
export async function verifyCutover(db: DbClient, opts: CutoverOptions, password: string): Promise<string[]> {
    const to = normalise(opts.ownerEmail, 'The owner address');
    const problems: string[] = [];
    const owner = await db.user.findFirst({ where: { email: to }, omit: { password: false } });
    if (!owner) problems.push(`no account has the address ${to}`);
    else if (!(await verifyPassword(password, owner.password))) problems.push('the new password does not sign the owner in');
    for (const email of [...QA_EMAILS, ...(opts.deleteEmails ?? []).map((e) => e.trim().toLowerCase())]) {
        if (await db.user.count({ where: { email: { equals: email, mode: 'insensitive' } } })) problems.push(`${maskEmail(email)} still has an account`);
    }
    if (await db.apiToken.count({ where: { revokedAt: null } })) problems.push('an access token is still live');
    if (await db.oAuthRefreshToken.count()) problems.push('a refresh token is left');
    if (await db.oAuthCode.count()) problems.push('an OAuth sign-in code is left');
    if (await db.pushSubscription.count()) problems.push('a push subscription is left');
    if (await db.otp.count()) problems.push('an email code is left');
    return problems;
}
