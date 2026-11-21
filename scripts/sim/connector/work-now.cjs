// The live hour: the work lines and the calls so far for one round's person (counts and short texts; invented data only).
//   node scripts/sim/connector/work-now.cjs <round>
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const round = process.argv[2];
const planted = JSON.parse(fs.readFileSync(path.join(__dirname, 'planted-work.local.json'), 'utf8'));
const url = new URL(process.env.DATABASE_URL);
url.pathname = '/recollect_connector_sim';
(async () => {
    const db = new Client({ connectionString: url.toString() });
    await db.connect();
    const r = await db.query(`SELECT to_char("createdAt" AT TIME ZONE 'UTC','HH24:MI:SS') t, kind, left(text, 70) txt, app, project, "followsId" IS NOT NULL f, "sameAsId" IS NOT NULL j, hidden h FROM "WorkLine" WHERE "userId" = $1 ORDER BY "createdAt"`, [planted[round].userId]);
    for (const x of r.rows) console.log(`${x.t} ${x.kind}${x.f ? ' (on)' : ''}${x.j ? ' (folded)' : ''}${x.h ? ' (removed)' : ''} [${x.app}/${x.project}] ${x.txt}`);
    const m = await db.query(`SELECT count(*)::int n FROM "Memory" WHERE "userId" = $1`, [planted[round].userId]);
    console.log(`memories: ${m.rows[0].n}`);
    await db.end();
})();
