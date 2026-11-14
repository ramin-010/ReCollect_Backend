// Runs once per `npm run test:int`, before any integration test file:
// create the test database if needed and apply all migrations to it.
import { ensureTestDatabase, getTestDatabaseUrl, migrateTestDatabase } from '../helpers/testDb';

export default async function setup(): Promise<void> {
    const url = getTestDatabaseUrl();
    await ensureTestDatabase(url);
    migrateTestDatabase(url);
    const { hostname, port, pathname } = new URL(url);
    console.log(`[tests] integration database ${pathname.slice(1)} on ${hostname}:${port} is migrated`);
}
