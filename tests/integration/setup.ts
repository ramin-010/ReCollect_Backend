// Runs before EACH integration test file (vitest setupFiles), before the file imports the app.
import { afterAll, beforeAll, vi } from 'vitest';
import { applyIntegrationTestEnv } from '../helpers/env';
import { getTestDatabaseUrl, truncateAllTables } from '../helpers/testDb';
import { clearSentMails } from '../helpers/mail';
import { installPgConcurrencyGuard, takePgOverlaps } from '../helpers/pgConcurrencyGuard';

const databaseUrl = getTestDatabaseUrl();
applyIntegrationTestEnv(databaseUrl);

// Two queries at once on one pg connection fail the file (see tests/helpers/pgConcurrencyGuard.ts).
installPgConcurrencyGuard();

// Outgoing email is never sent: every nodemailer transporter records into tests/helpers/mail.ts.
vi.mock('nodemailer', async () => (await import('../helpers/mail')).createNodemailerMock());

// Each test file starts from empty tables.
beforeAll(async () => {
    await truncateAllTables(databaseUrl);
    clearSentMails();
    takePgOverlaps();
});

afterAll(async () => {
    const { disconnectPrisma } = await import('../../src/db/prisma');
    await disconnectPrisma();

    const overlaps = takePgOverlaps();
    if (overlaps.length > 0) {
        const list = overlaps.map((o) => `  - ${o.test || '(hook)'}\n      new:    ${o.query}\n      active: ${o.active}`).join('\n');
        throw new Error(
            `${overlaps.length} pg query(s) ran while another query was active on the same connection ` +
                `(Prisma include of 2+ relations on a write or a transaction client):\n${list}`
        );
    }
});
