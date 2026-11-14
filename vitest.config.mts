// Two test groups:
//   unit        tests/unit/**         pure logic, no database (`npm run test:unit`)
//   integration tests/integration/**  real Postgres via the app (`npm run test:int`)
// The integration database comes from TEST_DATABASE_URL (backend/.env); set TEST_DB_NAME to use
// your own database when several runs happen in parallel. See docs/MIGRATION_CONVENTIONS.md.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['tests/unit/**/*.test.ts'],
                    // A unit test that touches Postgres by mistake fails fast instead of hitting the dev DB.
                    env: {
                        NODE_ENV: 'test',
                        DOTENV_CONFIG_QUIET: 'true',
                        DATABASE_URL: 'postgresql://unit-tests-have-no-database@127.0.0.1:1/none',
                        // Set (blank) so dotenv never loads the real Claude key into unit tests.
                        CLAUDE_API_KEY: '',
                        RECALL_MODEL: '',
                    },
                },
            },
            {
                extends: true,
                test: {
                    name: 'integration',
                    include: ['tests/integration/**/*.test.ts'],
                    globalSetup: ['tests/integration/globalSetup.ts'],
                    setupFiles: ['tests/integration/setup.ts'],
                    // One database per run, truncated per file: run files one after another.
                    fileParallelism: false,
                    testTimeout: 30_000,
                    hookTimeout: 120_000,
                },
            },
        ],
    },
});
