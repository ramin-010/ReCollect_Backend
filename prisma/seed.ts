// Local dev seed: `npm run db:seed` (or `npx prisma db seed`).
// Creates/refreshes the QA login and resets its learning sample (prisma/seed-learning.ts):
//   email    qa@recollect.local
//   password qapass123
// and a second QA login for anything that needs two people (sharing: a reader, someone added), with no
// sample of its own:
//   email    qa2@recollect.local
//   password qapass123
// Every QA script, test run and hook test uses this account (LOOP_COMPLETE_SPEC S1.2), so the owner's own
// account (dev@recollect.local) holds only his data.
//
// Another account only on purpose, because the sample REPLACES that account's learning data:
//   npm run db:seed -- --email someone@recollect.local --reset-learning
// Safe to re-run (upsert). Refuses to run in production or against a non-local database.
import 'dotenv/config';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { hashPassword } from '../src/services/auth/password';
import { seedLearning } from './seed-learning';

export const QA_EMAIL = 'qa@recollect.local';
const QA_PASSWORD = 'qapass123';
const QA_NAME = 'QA';
export const QA2_EMAIL = 'qa2@recollect.local';
const QA2_NAME = 'QA Visitor';

function assertLocalDatabase(): void {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('Refusing to seed: NODE_ENV=production.');
    }
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is missing.');
    const host = new URL(url).hostname;
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
        throw new Error(`Refusing to seed a non-local database (host ${host}).`);
    }
}

function target(argv: string[]): { email: string; qa: boolean } {
    const i = argv.indexOf('--email');
    const email = i >= 0 ? argv[i + 1]?.trim().toLowerCase() : undefined;
    if (i >= 0 && !email) throw new Error('--email needs an address.');
    if (!email || email === QA_EMAIL) return { email: QA_EMAIL, qa: true };
    if (!argv.includes('--reset-learning')) {
        throw new Error(`Refusing to seed ${email}: the sample replaces that account's learning data. Add --reset-learning if that is what you want.`);
    }
    return { email, qa: false };
}

async function main(): Promise<void> {
    assertLocalDatabase();
    const { email, qa } = target(process.argv.slice(2));

    let user: { id: string; email: string };
    if (qa) {
        const password = await hashPassword(QA_PASSWORD);
        user = await prisma.user.upsert({
            where: { email: QA_EMAIL },
            update: { password, name: QA_NAME, isGhost: false, status: 'active' },
            create: { email: QA_EMAIL, name: QA_NAME, password, reminderEmail: QA_EMAIL, authProvider: 'local', status: 'active' },
            select: { id: true, email: true },
        });
        console.log(`Seeded the QA user ${user.email} (id ${user.id}). Password: ${QA_PASSWORD} (local only).`);
        const second = await prisma.user.upsert({
            where: { email: QA2_EMAIL },
            update: { password, name: QA2_NAME, isGhost: false, status: 'active' },
            create: { email: QA2_EMAIL, name: QA2_NAME, password, reminderEmail: QA2_EMAIL, authProvider: 'local', status: 'active' },
            select: { id: true, email: true },
        });
        console.log(`Seeded the second QA user ${second.email} (id ${second.id}), same password, no sample.`);
    } else {
        // Another account must exist already: its login is never touched.
        user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true, email: true } });
        console.log(`Resetting the learning data of ${user.email} (id ${user.id}) to the sample.`);
    }

    // Learning Home sample data (resets the account's learning rows on every run).
    console.log(`Seeded ${await seedLearning(prisma, user.id)}.`);
}

main()
    .catch((err) => {
        console.error('Seed failed:', err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => disconnectPrisma());
