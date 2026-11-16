// Which database a maintenance script works on, checked before any app module loads (hosting review
// A5 and A7).
//
// A script never finds its database in a .env file: the target is DATABASE_URL exactly as the process
// was started with it, read when THIS module loads. So every script imports this module first. The
// reason: src/db/prisma.ts imports dotenv/config, and that fills a missing DATABASE_URL from
// backend/.env (the dev database) the moment any app module loads.
//
//   on the server (compiled), with the API's own settings or the direct address in the child's environment:
//     DOTENV_CONFIG_PATH=<the API's env file> node -r dotenv/config dist-scripts/scripts/<script>.js
//     DATABASE_URL="$(<read the direct address from its file>)" node dist-scripts/scripts/<script>.js
//   on the PC: the same, with an explicit address. The dev database only where a script allows it
//   (--allow-dev for check-blocks and search-reindex; never for the cutover).
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/** DATABASE_URL as the process started, before any .env file could be read. */
const DATABASE_URL_AT_START = process.env.DATABASE_URL;

/** The dev database's name and port (backend/.env, scripts/dev-db.mjs). */
export const DEV_DATABASE = 'recollect_dev';
export const DEV_PORT = 5433;
/** Databases made to be thrown away: the tests' (recollect_test_*) and the deployment's restore copies (restore_*). */
const DISPOSABLE = /^(recollect_test_|restore_)/;

export class TargetError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TargetError';
    }
}

export interface Target {
    url: string;
    host: string;
    port: number;
    database: string;
    /** On this machine (localhost, 127.x, ::1). */
    local: boolean;
    sslmode: string | null;
}

export function parseTarget(url: string): Target {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        throw new TargetError('DATABASE_URL is not a valid postgresql:// address.');
    }
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
        throw new TargetError('DATABASE_URL must be a postgresql:// address.');
    }
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!host || !database) throw new TargetError('DATABASE_URL must name a host and a database.');
    return {
        url,
        host,
        port: u.port ? Number(u.port) : 5432,
        database,
        local: host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host),
        sslmode: u.searchParams.get('sslmode'),
    };
}

/** host:port/database (sslmode): never the user or the password. */
export function describeTarget(t: Target): string {
    return `${t.host}:${t.port}/${t.database}${t.sslmode ? ` (sslmode=${t.sslmode})` : ''}`;
}

export function isDisposable(t: Target): boolean {
    return DISPOSABLE.test(t.database);
}

/**
 * The dev database, matched three ways: by its name on any host; any database on the dev server's
 * port on this machine except the tests' own (recollect_test_*); or the address backend/.env names
 * (catches a renamed dev database).
 */
export function isDevDatabase(t: Target, devUrl: string | undefined): boolean {
    if (t.database === DEV_DATABASE) return true;
    if (t.local && t.port === DEV_PORT && !t.database.startsWith('recollect_test_')) return true;
    if (devUrl) {
        try {
            const dev = parseTarget(devUrl);
            if (dev.database === t.database && dev.port === t.port && (dev.host === t.host || (dev.local && t.local))) return true;
        } catch {
            // an unreadable address in .env names no database
        }
    }
    return false;
}

/** The backend folder: the nearest parent with package.json and prisma/schema.prisma (scripts/lib or dist-scripts/scripts/lib). */
function backendRoot(): string | undefined {
    let dir = __dirname;
    for (let i = 0; i < 6; i += 1) {
        if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'prisma', 'schema.prisma'))) return dir;
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return undefined;
}

/** DATABASE_URL in backend/.env: the dev database. The file exists on the PC only (a release refuses .env). */
export function devDatabaseUrl(): string | undefined {
    const root = backendRoot();
    const file = root ? path.join(root, '.env') : undefined;
    if (!file || !fs.existsSync(file)) return undefined;
    return dotenv.parse(fs.readFileSync(file)).DATABASE_URL || undefined;
}

export interface ResolveOptions {
    /**
     * 'cutover': never the dev database, and on this machine only a disposable copy. 'maintenance': the
     * dev database only with allowDev. 'scratch': a disposable copy only (recollect_test_*, restore_*),
     * on any host: never the dev database, never production.
     */
    purpose: 'cutover' | 'maintenance' | 'scratch';
    /** --allow-dev (maintenance scripts only). */
    allowDev?: boolean;
    /** For tests: DATABASE_URL at the start (default: as read when this module loaded). */
    startUrl?: string | undefined;
    /** For tests: DATABASE_URL now (default: process.env). It must not have changed since the start. */
    currentUrl?: string | undefined;
    /** For tests: the dev address (default: backend/.env). */
    devUrl?: string | undefined;
}

/** The checked target, or a TargetError that says why not. */
export function resolveTarget(opts: ResolveOptions): Target {
    const startUrl = 'startUrl' in opts ? opts.startUrl : DATABASE_URL_AT_START;
    const currentUrl = 'currentUrl' in opts ? opts.currentUrl : process.env.DATABASE_URL;
    if (!startUrl?.trim()) {
        throw new TargetError('No database named: give this run its DATABASE_URL explicitly (a .env file is never read for it).');
    }
    if (currentUrl !== startUrl) {
        throw new TargetError('DATABASE_URL changed while the script loaded (a .env file was read); nothing was done.');
    }
    const target = parseTarget(startUrl.trim());
    const devUrl = 'devUrl' in opts ? opts.devUrl : devDatabaseUrl();
    if (isDevDatabase(target, devUrl)) {
        if (opts.purpose === 'cutover') throw new TargetError(`${describeTarget(target)} is the dev database; the cutover never runs on it.`);
        if (opts.purpose === 'scratch') throw new TargetError(`${describeTarget(target)} is the dev database; this runs only on a disposable copy.`);
        if (!opts.allowDev) throw new TargetError(`${describeTarget(target)} is the dev database; add --allow-dev to work on it on purpose.`);
    }
    if (opts.purpose === 'scratch' && !isDisposable(target)) {
        throw new TargetError(`${describeTarget(target)} is not a disposable copy (recollect_test_* or restore_*); this runs only on such a copy.`);
    }
    if (opts.purpose === 'cutover' && target.local && !isDisposable(target)) {
        throw new TargetError(
            `${describeTarget(target)} is on this machine but is not a disposable copy (recollect_test_* or restore_*); the cutover runs only on production or on such a copy.`
        );
    }
    return target;
}
