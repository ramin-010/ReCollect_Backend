// Local dev seed: `npm run db:seed` (or `npx prisma db seed`).
// Creates/refreshes ONE local-only login for the frontend:
//   email    dev@recollect.local
//   password devpass123
// Safe to re-run (upsert). Refuses to run in production or against a non-local database.
// Also seeds a small learning dataset for that user (prisma/seed-learning.ts); re-running resets it.
import 'dotenv/config';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { hashPassword } from '../src/services/auth/password';
import { seedLearning } from './seed-learning';

const DEV_EMAIL = 'dev@recollect.local';
const DEV_PASSWORD = 'devpass123';
const DEV_NAME = 'Dev User';

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

async function main(): Promise<void> {
    assertLocalDatabase();
    const password = await hashPassword(DEV_PASSWORD);

    const user = await prisma.user.upsert({
        where: { email: DEV_EMAIL },
        update: { password, name: DEV_NAME, isGhost: false, status: 'active' },
        create: {
            email: DEV_EMAIL,
            name: DEV_NAME,
            password,
            reminderEmail: DEV_EMAIL,
            authProvider: 'local',
            status: 'active',
        },
    });

    console.log(`Seeded dev user ${user.email} (id ${user.id}). Password: ${DEV_PASSWORD} (local only).`);

    // Learning Home dev data (resets the dev user's learning rows on every run).
    console.log(`Seeded ${await seedLearning(prisma, user.id)}.`);
}

main()
    .catch((err) => {
        console.error('Seed failed:', err);
        process.exitCode = 1;
    })
    .finally(() => disconnectPrisma());
