// Server entry point: `npm run dev` (ts-node-dev) / `node dist/index.js`.
// The Express app itself is built in ./app (so tests can import it without side effects).
import 'dotenv/config';
import app from './app';
import { startCronScheduler } from './services/cronScheduler';
import { startOtpCleanupCron } from './services/auth/otp.service';
import { startShareLinkCleanupCron } from './services/docs/docSharing.service';
import { startLearningCron } from './services/learningDb/rollover.service';
import { startMorningNudgeCron } from './services/learningDb/nudge.service';
import { startRecallCrons } from './services/recall/batch.service';
import { initializeCollaboration, startCollaborationServer } from './collaboration';

// All data lives in Postgres (Prisma). It connects lazily on the first query; see src/db/prisma.ts.
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing (Postgres). Locally: `npm run db:start`, then set it in backend/.env.');
}

// Reminder emails: the cron polls Postgres every minute for due reminders.
startCronScheduler();

// Postgres has no TTL index: delete expired OTPs and share links periodically
// (the endpoints also reject expired rows).
startOtpCleanupCron();
startShareLinkCleanupCron();

// Learning rollover: every 15 min (and once now) for users whose local day changed: streak settling,
// and (routine on only) day slots, backfill, triage healing. Idempotent.
startLearningCron();

// Morning nudge email (daily loop v2): every 15 min, one digest per learner per local day, at or
// after their nudgeTime. Idempotent (User.lastNudgeDay).
startMorningNudgeCron();

// Recall mode (Claude API): tomorrow's questions as one Message Batch at 02:30 server time, and a
// poll every 10 min that stores ended batches. Both idle without CLAUDE_API_KEY;
// RECALL_NIGHTLY_BATCH=off stops the nightly submission.
startRecallCrons();

const PORT = process.env.PORT
app.listen(PORT, () => {
    console.log(`Server runnin on : http://localhost:${PORT}`);

    // Initialize and start collaboration server for real-time editing
    initializeCollaboration();
    startCollaborationServer();
})
