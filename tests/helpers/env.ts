// Environment for integration tests. Runs before the app is imported, and wins over backend/.env
// (dotenv never overrides variables that are already set), so tests never use real secrets or
// real third-party services.
export function applyIntegrationTestEnv(databaseUrl: string): void {
    const env: Record<string, string> = {
        NODE_ENV: 'test',
        DOTENV_CONFIG_QUIET: 'true',
        DATABASE_URL: databaseUrl,
        // Auth (cookies are set exactly like in production code, with these values)
        JWT_SECRET: 'test-jwt-secret-not-for-production',
        JWT_EXPIRE: '1d',
        JWT_COOKIE_EXPIRE: '1',
        BCRYPT_SALT_ROUNDS: '4', // bcryptjs at 10 rounds makes every signup ~100 ms slower
        FRONTEND_URL: 'http://localhost:3005',
        // Third parties: dummies. Email is mocked (tests/helpers/mail.ts); nothing else is called.
        CLOUDINARY_CLOUD_NAME: 'test-cloud',
        CLOUDINARY_API_KEY: 'test-key',
        CLOUDINARY_API_SECRET: 'test-secret',
        EMAIL_USER: 'tests@example.invalid',
        EMAIL_PASSWORD: 'test-password',
        EMAIL_FROM: 'noreply@example.invalid',
        GOOGLE_CLIENT: 'test-google-client-id.apps.googleusercontent.com',
        GOOGLE_SECRET: 'test-google-secret',
        GROQ_API_KEY: '',
        GEMINI_API_KEY: '',
        COHERE_API_KEY: '',
        OPENROUTER_API_KEY: '',
        // Claude (Recall mode): off unless a test sets a dummy key and injects a fake client
        // (setAiClientForTests); the real API is never called (src/services/claude/client.ts).
        CLAUDE_API_KEY: '',
        RECALL_MODEL: '',
        RECALL_NIGHTLY_BATCH: 'off',
    };
    Object.assign(process.env, env);
}
