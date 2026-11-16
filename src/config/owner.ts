// OWNER_EMAIL: the account that runs this server (hosting P1-8, P1-15). It alone may call the
// database check (GET /api/health/db) and it gets the awake meter's emails. Unset (dev, tests):
// any signed-in cookie may call the check, and no alert is sent.

/** The owner's email, lower-cased; null when OWNER_EMAIL is unset or blank. */
export function ownerEmail(env: NodeJS.ProcessEnv = process.env): string | null {
    const value = env['OWNER_EMAIL']?.trim().toLowerCase();
    return value ? value : null;
}
