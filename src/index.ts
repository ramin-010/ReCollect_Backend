// Server entry point: `npm run dev` (ts-node-dev) / `node dist/index.js`.
// The Express app itself is built in ./app (so tests can import it without side effects).
import 'dotenv/config';
// Hosting P1-10: a production start with unsafe settings stops here, before the app or any timer
// loads (this file compiles to CommonJS, which runs these lines in order).
import { refuseUnsafeProductionStart } from './config/productionCheck';
refuseUnsafeProductionStart();

import app from './app';
import { startSearchTextPass } from './services/docs/docSearch.service';
import { schedulerMode, startBackgroundJobs, stopBackgroundJobs } from './services/scheduler/jobs';
import { flushAwakeMeter, startAwakeMeter } from './services/scheduler/awake';
import { attachCollaborationServer, collabAttached, hocuspocusServer, initializeCollaboration, startCollaborationServer } from './collaboration';
import { disconnectPrisma } from './db/prisma';
import { installShutdown } from './lifecycle/shutdown';

// All data lives in Postgres (Prisma). It connects lazily on the first query; see src/db/prisma.ts.
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing (Postgres). Locally: `npm run db:start`, then set it in backend/.env.');
}

// The database's awake time (hosting P1-15): a hosted database that sleeps when idle (Neon) bills
// the minutes it is awake. Counted from the pool's queries, kept in RECOLLECT_STATE_DIR. Quiet mode
// only: in poll mode the database never sleeps (a query every minute), so there is nothing to watch.
if (schedulerMode() === 'quiet') startAwakeMeter();

// The background jobs (src/services/scheduler/jobs.ts), in SCHEDULER_MODE:
//   poll (default): the crons as before: reminder emails every minute, expired sign-in codes every
//     5 min, the learning rollover and the morning nudge every 15 min (the rollover also once now),
//     the Recall batch at 02:30 and its poll every 10 min, the trash hourly, the buddy's queue every
//     minute and its nights every 15 min.
//   quiet (production on a database that sleeps): the same passes, run when something is due.
startBackgroundJobs();

// Doc search: once now, the words of every doc that has none (after the migration, an import, or
// content saved since the last search). Each search also writes them for the searcher's docs.
startSearchTextPass();

// Hosting P1-1: HOST picks the interface (production: 127.0.0.1, behind the tunnel); unset, every
// interface as before. COLLAB_ATTACH=1 serves live editing on this same listener at /collab; unset,
// Hocuspocus keeps its own port (COLLAB_PORT, 1234), as the dev setup expects.
const PORT = Number(process.env.PORT ?? 0); // unset: any free port, as before
const HOST = process.env.HOST?.trim() || undefined;
const onListening = () => {
    console.log(`Server runnin on : http://${HOST ?? 'localhost'}:${PORT}`);

    // Initialize and start collaboration server for real-time editing
    initializeCollaboration();
    startCollaborationServer();
};
const server = HOST ? app.listen(PORT, HOST, onListening) : app.listen(PORT, onListening);
if (collabAttached()) attachCollaborationServer(server);

// Hosting P1-2: SIGTERM / SIGINT stop accepting, end the jobs, store the live documents, close the pool.
installShutdown({
    server,
    stopJobs: stopBackgroundJobs,
    storeDocuments: () => hocuspocusServer.destroy(),
    flushState: flushAwakeMeter,
    closeDatabase: disconnectPrisma,
});
