// D3's dry run (MANAGER_AND_DOCS_PLAN §1, 2026-11-15): the newest dump restored into a copy, the
// migrations applied there (so 20261115130000_doc_state_bytes turns the Base64 text into bytes), then
// a byte-for-byte check against the real database: for every doc and snapshot, md5 of the decoded
// Base64 in recollect_dev = md5 of the bytes in the copy. Counts only, never content. The copy is
// dropped at the end (--keep keeps it).
//   node scripts/d3-dry-run.mjs [--keep]
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const url = new URL(process.env.DATABASE_URL);
const COPY = 'recollect_d3_dry';
const copyUrl = new URL(url);
copyUrl.pathname = `/${COPY}`;
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';

function pgTool(name) {
    const dirs = ['C:\\Program Files\\pgAdmin 4\\runtime'];
    const pgRoot = 'C:\\Program Files\\PostgreSQL';
    if (fs.existsSync(pgRoot)) for (const v of fs.readdirSync(pgRoot).sort().reverse()) dirs.push(path.join(pgRoot, v, 'bin'));
    try {
        const which = execFileSync('where', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean);
        if (which[0]) return which[0];
    } catch {
        /* not on the PATH */
    }
    for (const d of dirs) if (fs.existsSync(path.join(d, `${name}.exe`))) return path.join(d, `${name}.exe`);
    throw new Error(`${name} not found`);
}

const dumps = fs.readdirSync(path.join(root, '.devdb', 'dumps')).filter((f) => f.endsWith('.dump')).sort();
const dump = path.join(root, '.devdb', 'dumps', dumps[dumps.length - 1]);
console.log(`dump: ${path.basename(dump)}`);

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${COPY}`);
await admin.query(`CREATE DATABASE ${COPY}`);
await admin.end();

execFileSync(pgTool('pg_restore'), ['--no-owner', '--no-privileges', '-d', copyUrl.toString(), dump], { stdio: ['ignore', 'ignore', 'inherit'] });
console.log('restored into the copy');
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: root, env: { ...process.env, DATABASE_URL: copyUrl.toString() }, stdio: ['ignore', 'ignore', 'inherit'], shell: true });
console.log('migrations applied to the copy');

const real = new pg.Client({ connectionString: url.toString() });
const copy = new pg.Client({ connectionString: copyUrl.toString() });
await real.connect();
await copy.connect();
const sums = async (client, sql) => new Map((await client.query(sql)).rows.map((r) => [r.id, r.h]));
const report = {};
for (const [table, column] of [['Doc', 'yjsState'], ['DocSnapshot', 'yjsState'], ['DocSnapshot', 'agentUpdate']]) {
    const type = (await real.query(`SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column])).rows[0]?.data_type;
    const before = await sums(real, type === 'bytea' ? `SELECT id, md5("${column}") AS h FROM "${table}"` : `SELECT id, md5(decode("${column}", 'base64')) AS h FROM "${table}"`);
    const copyType = (await copy.query(`SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column])).rows[0]?.data_type;
    const after = await sums(copy, `SELECT id, md5("${column}") AS h FROM "${table}"`);
    let same = 0;
    let differ = 0;
    let missing = 0;
    for (const [id, h] of before) {
        if (!after.has(id)) missing += 1;
        else if (after.get(id) === h) same += 1;
        else differ += 1;
    }
    report[`${table}.${column}`] = { real: type, copy: copyType, rows: before.size, same, differ, missing, extraInCopy: [...after.keys()].filter((id) => !before.has(id)).length };
}
const titles = (await copy.query(`SELECT count(*)::int AS n, count("searchText")::int AS words FROM "Doc"`)).rows[0];
report.searchText = titles;
console.log(JSON.stringify(report, null, 2));
await real.end();
await copy.end();

console.log('check-blocks on the copy:');
execFileSync('npx', ['ts-node', '--transpile-only', 'scripts/check-blocks.ts'], { cwd: root, env: { ...process.env, DATABASE_URL: copyUrl.toString() }, stdio: 'inherit', shell: true });

if (!process.argv.includes('--keep')) {
    const a = new pg.Client({ connectionString: adminUrl.toString() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${COPY}`);
    await a.end();
    console.log('the copy was dropped');
}
