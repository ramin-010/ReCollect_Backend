// A read-only look into the connector simulation's database (never the dev database): node simq.cjs "<SELECT ...>"
// The connection comes from backend/.env with the database name swapped; it is never printed.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
const { Client } = require('pg');

(async () => {
    // A file of SQL (PowerShell 5.1 drops the double quotes Postgres needs around "CamelCase" names).
    const arg = process.argv[2];
    const sql = arg.endsWith('.sql') ? require('node:fs').readFileSync(arg, 'utf8') : arg;
    if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('SELECT only');
    const url = new URL(process.env.DATABASE_URL);
    if (!/localhost|127\.0\.0\.1/.test(url.hostname)) throw new Error('local only');
    url.pathname = '/recollect_connector_sim';
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    await c.query('SET TRANSACTION READ ONLY').catch(() => {});
    const r = await c.query(sql);
    console.log(JSON.stringify(r.rows, null, 1));
    await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
