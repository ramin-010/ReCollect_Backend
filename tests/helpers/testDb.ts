// Test database plumbing for the integration project (no app imports here).
//
// Which database: TEST_DATABASE_URL from backend/.env (recollect_test on the local dev server).
// Parallel runs (e.g. several workers) can each use their own database by setting TEST_DB_NAME:
//   TEST_DB_NAME=recollect_test_docs npm run test:int
// It is created if missing and migrated with `prisma migrate deploy`. The name must contain
// "test" because every test file truncates all tables.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { Client } from 'pg';

export const backendRoot = process.cwd();

function readDotEnv(): Record<string, string> {
    const file = path.join(backendRoot, '.env');
    return fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
}

function databaseName(url: string): string {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

export function getTestDatabaseUrl(): string {
    if (!fs.existsSync(path.join(backendRoot, 'prisma', 'schema.prisma'))) {
        throw new Error(`Run the tests from backend/ (cwd is ${backendRoot}).`);
    }
    const fileEnv = readDotEnv();
    const base = process.env.TEST_DATABASE_URL || fileEnv.TEST_DATABASE_URL;
    if (!base) {
        throw new Error(
            'TEST_DATABASE_URL is not set (backend/.env). Example: postgresql://postgres:postgres@127.0.0.1:5433/recollect_test'
        );
    }

    const url = new URL(base);
    const override = process.env.TEST_DB_NAME?.trim();
    if (override) {
        if (!/^[A-Za-z0-9_]+$/.test(override)) {
            throw new Error('TEST_DB_NAME may only contain letters, digits and underscores.');
        }
        url.pathname = `/${override}`;
    }

    const name = databaseName(url.toString());
    if (!/test/i.test(name)) {
        throw new Error(`Refusing to use "${name}" for tests: the name must contain "test" (tables get truncated).`);
    }
    const devUrl = fileEnv.DATABASE_URL;
    if (devUrl && databaseName(devUrl) === name) {
        throw new Error(`Refusing to use the dev database "${name}" for tests.`);
    }
    return url.toString();
}

/** CREATE DATABASE if it does not exist yet (connects to the server's `postgres` database). */
export async function ensureTestDatabase(testUrl: string): Promise<void> {
    const name = databaseName(testUrl);
    const adminUrl = new URL(testUrl);
    adminUrl.pathname = '/postgres';
    const client = new Client({ connectionString: adminUrl.toString() });
    await client.connect();
    try {
        const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        if (exists.rowCount === 0) {
            try {
                await client.query(`CREATE DATABASE "${name}"`);
            } catch (err: any) {
                if (err?.code !== '42P04') throw err; // created concurrently by another run
            }
        }
    } finally {
        await client.end();
    }
}

/** Apply prisma/migrations to the test database (`prisma migrate deploy`). */
export function migrateTestDatabase(testUrl: string): void {
    const prismaCli = path.join(backendRoot, 'node_modules', 'prisma', 'build', 'index.js');
    try {
        execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
            cwd: backendRoot,
            env: { ...process.env, DATABASE_URL: testUrl, DOTENV_CONFIG_QUIET: 'true' },
            stdio: 'pipe',
        });
    } catch (err: any) {
        const output = `${err?.stdout ?? ''}${err?.stderr ?? ''}`;
        throw new Error(`prisma migrate deploy failed for the test database:\n${output}`);
    }
}

/** Empty every table (except Prisma's migration history). Called before each test file. */
export async function truncateAllTables(testUrl: string): Promise<void> {
    const client = new Client({ connectionString: testUrl });
    await client.connect();
    try {
        const { rows } = await client.query<{ tablename: string }>(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'"
        );
        if (rows.length > 0) {
            const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
            await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
        }
    } finally {
        await client.end();
    }
}
