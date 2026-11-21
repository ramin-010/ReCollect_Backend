// The live hour: which test person each connector token belongs to (names and times only).
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const url = new URL(process.env.DATABASE_URL);
url.pathname = '/recollect_connector_sim';
(async () => {
    const db = new Client({ connectionString: url.toString() });
    await db.connect();
    const r = await db.query(`SELECT u.email, t.name, to_char(t."createdAt" AT TIME ZONE 'UTC','HH24:MI:SS') c, t."revokedAt" IS NOT NULL rv, to_char(t."lastUsedAt" AT TIME ZONE 'UTC','HH24:MI:SS') lu FROM "ApiToken" t JOIN "User" u ON u.id = t."userId" WHERE u.email LIKE 'kiran.%' ORDER BY t."createdAt"`);
    for (const x of r.rows) console.log(`${x.c} ${x.email.split('@')[0]} ${x.name}${x.rv ? ' revoked' : ''} last used ${x.lu}`);
    await db.end();
})();
