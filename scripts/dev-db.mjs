// Local Postgres 17 for development and tests, run straight from node_modules (no install, no admin rights).
//   npm run db:start   → starts it on 127.0.0.1:5433 and keeps running (Ctrl+C to stop)
// Data lives in backend/.devdb/ (git-ignored). Local-only credentials: postgres / postgres.
// Databases: recollect_dev (the app) and recollect_test (tests; each test worker may create its own).
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.DEV_DB_PORT || 5433);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', '.devdb', 'data');
const DATABASES = ['recollect_dev', 'recollect_test'];

const portInUse = () => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: PORT });
  s.once('connect', () => { s.end(); resolve(true); });
  s.once('error', () => resolve(false));
});

if (await portInUse()) {
  console.log(`[dev-db] something is already listening on 127.0.0.1:${PORT}, assuming the dev database is running.`);
  process.exit(0);
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: true,
  // UTF-8 like any Linux/EC2 server (the Windows default would be WIN1252, which can't store "→", "₹", emoji…),
  // and UTC like the planned EC2 server.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-c', 'timezone=UTC', '-c', 'log_timezone=UTC'],
  onLog: () => {},
  onError: (e) => console.error('[dev-db]', String(e).trim()),
});

if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
  console.log('[dev-db] first run: initialising data directory', dataDir);
  await pg.initialise();
}
await pg.start();
for (const db of DATABASES) {
  try { await pg.createDatabase(db); console.log('[dev-db] created database', db); }
  catch { /* already exists */ }
}
console.log(`[dev-db] ready: postgresql://postgres:postgres@127.0.0.1:${PORT}/recollect_dev`);

const stop = async () => { console.log('[dev-db] stopping…'); await pg.stop().catch(() => {}); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30); // keep the process alive
