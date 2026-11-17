// A local backup of the dev database (LOOP_COMPLETE_SPEC S1.2): the owner's real data lives on this disk.
//   npm run db:dump                    a dump now
//   node scripts/db-dump.mjs --daily   only when there is none for today (start-recollect.ps1 runs this)
// Writes backend/.devdb/dumps/recollect_dev-<YYYY-MM-DD>[-HHmm].dump (pg_dump custom format; restore with
// pg_restore --clean -d <url> <file>) and keeps the newest 14. pg_dump is not in the embedded Postgres
// package: it is found through PG_DUMP, the PATH, pgAdmin 4 or a PostgreSQL install. Without one, every
// table is written as JSON instead (<name>.json.gz: no restore tool, but nothing is lost).
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..', '.devdb', 'dumps');
const KEEP = 14;
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is missing.');
const db = new URL(url).pathname.slice(1) || 'db';

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
fs.mkdirSync(dir, { recursive: true });

if (process.argv.includes('--daily') && fs.readdirSync(dir).some((f) => f.startsWith(`${db}-${day}`))) {
    console.log(`[db-dump] today's dump exists (${day}); nothing to do.`);
    process.exit(0);
}

function findPgDump() {
    if (process.env.DB_DUMP_JSON) return undefined; // force the JSON fallback (to test it)
    const candidates = [process.env.PG_DUMP];
    try {
        const which = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['pg_dump'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        candidates.push(...which.split(/\r?\n/));
    } catch {
        // not on the PATH
    }
    if (process.platform === 'win32') {
        candidates.push('C:\\Program Files\\pgAdmin 4\\runtime\\pg_dump.exe');
        const pgRoot = 'C:\\Program Files\\PostgreSQL';
        if (fs.existsSync(pgRoot)) for (const v of fs.readdirSync(pgRoot).sort().reverse()) candidates.push(path.join(pgRoot, v, 'bin', 'pg_dump.exe'));
    }
    return candidates.find((c) => c && c.trim() && fs.existsSync(c.trim()))?.trim();
}

const stamp = `${day}-${pad(now.getHours())}${pad(now.getMinutes())}`;
const pgDump = findPgDump();
let file;
if (pgDump) {
    file = path.join(dir, `${db}-${stamp}.dump`);
    execFileSync(pgDump, ['--format=custom', `--file=${file}`, `--dbname=${url}`], { stdio: ['ignore', 'ignore', 'inherit'] });
} else {
    // No pg_dump: every table of the public schema as JSON, gzipped.
    file = path.join(dir, `${db}-${stamp}.json.gz`);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const tables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.tablename);
    const out = {};
    for (const t of tables) out[t] = (await client.query(`SELECT * FROM "${t}"`)).rows;
    await client.end();
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(out)));
}

// Keep the newest KEEP dumps of this database.
const mine = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${db}-`))
    .sort()
    .reverse();
for (const old of mine.slice(KEEP)) fs.rmSync(path.join(dir, old));
console.log(`[db-dump] ${path.basename(file)} (${Math.round(fs.statSync(file).size / 1024)} KB, ${pgDump ? 'pg_dump' : 'JSON: no pg_dump found'}); ${Math.min(mine.length, KEEP)} kept in ${dir}`);
