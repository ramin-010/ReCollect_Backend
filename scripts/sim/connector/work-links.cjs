// The live hour: each linked line of a round's person and what it points at.   node work-links.cjs <round>
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const planted = JSON.parse(fs.readFileSync(path.join(__dirname, 'planted-work.local.json'), 'utf8'));
const url = new URL(process.env.DATABASE_URL);
url.pathname = '/recollect_connector_sim';
(async () => {
    const db = new Client({ connectionString: url.toString() });
    await db.connect();
    const r = await db.query(`SELECT w.kind, left(w.text, 45) t, f.kind fk, left(f.text, 45) ft, f.app fa FROM "WorkLine" w JOIN "WorkLine" f ON f.id = w."followsId" WHERE w."userId" = $1 ORDER BY w."createdAt"`, [planted[process.argv[2]].userId]);
    for (const x of r.rows) console.log(`${x.kind}: ${x.t}  ->  ${x.fk} [${x.fa}]: ${x.ft}`);
    await db.end();
})();
