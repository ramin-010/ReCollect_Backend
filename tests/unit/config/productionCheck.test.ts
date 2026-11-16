// A bad production start is refused (hosting P1-10): one test per condition, from a production
// env that passes. Nothing here starts a server: the check is a function over the env.
import { describe, expect, it, vi } from 'vitest';
import { JWT_SECRET_MIN, productionProblems, refuseUnsafeProductionStart } from '../../../src/config/productionCheck';

const SECRET = 'x'.repeat(64);
const GOOD: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: 'https://re-collect.in',
    RECOLLECT_SELF_URL: 'https://api.re-collect.in',
    HOST: '127.0.0.1',
    SIGNUP_MODE: 'allowlist',
    DATABASE_URL: 'postgresql://app:pw@ep-quiet-sky-123456-pooler.ap-southeast-1.aws.neon.tech/workspace?sslmode=verify-full',
    OAUTH_CIMD_HOSTS: 'claude.ai',
};
const withEnv = (patch: Record<string, string | undefined>): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...GOOD };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
    }
    return env;
};
const problems = (patch: Record<string, string | undefined>) => productionProblems(withEnv(patch));

describe('productionProblems', () => {
    it('a safe production env passes; dev and tests are never checked', () => {
        expect(productionProblems(GOOD)).toEqual([]);
        expect(productionProblems({})).toEqual([]);
        expect(productionProblems({ NODE_ENV: 'development' })).toEqual([]);
        expect(productionProblems({ NODE_ENV: 'test', JWT_SECRET: 'short' })).toEqual([]);
    });

    it('JWT_SECRET unset or under 32 characters', () => {
        expect(problems({ JWT_SECRET: undefined })).toEqual([expect.stringMatching(/^JWT_SECRET must be at least 32/)]);
        expect(problems({ JWT_SECRET: 'y'.repeat(JWT_SECRET_MIN - 1) })).toHaveLength(1);
        expect(problems({ JWT_SECRET: 'y'.repeat(JWT_SECRET_MIN) })).toEqual([]);
    });

    it('ALLOWED_ORIGINS unset (or only commas and spaces)', () => {
        expect(problems({ ALLOWED_ORIGINS: undefined })).toEqual([expect.stringMatching(/^ALLOWED_ORIGINS must list/)]);
        expect(problems({ ALLOWED_ORIGINS: ' , ' })).toHaveLength(1);
    });

    it('RECOLLECT_SELF_URL unset, not https, or not a URL', () => {
        for (const v of [undefined, 'http://api.re-collect.in', 'api.re-collect.in']) {
            expect(problems({ RECOLLECT_SELF_URL: v })).toEqual([expect.stringMatching(/^RECOLLECT_SELF_URL must be/)]);
        }
    });

    it('HOST unset or not a loopback address', () => {
        expect(problems({ HOST: undefined })).toEqual([expect.stringMatching(/^HOST is unset/)]);
        for (const v of ['0.0.0.0', '::', '172.31.46.255', 'localhost']) expect(problems({ HOST: v })).toEqual([expect.stringMatching(/^HOST must be a loopback/)]);
        for (const v of ['127.0.0.1', '::1', '[::1]']) expect(problems({ HOST: v })).toEqual([]);
    });

    it('SIGNUP_MODE unset, open, or unknown', () => {
        expect(problems({ SIGNUP_MODE: undefined })).toEqual([expect.stringMatching(/^SIGNUP_MODE is unset/)]);
        for (const v of ['open', 'OPEN', 'closd']) expect(problems({ SIGNUP_MODE: v })).toEqual([expect.stringMatching(/^SIGNUP_MODE must be allowlist or closed/)]);
        expect(problems({ SIGNUP_MODE: 'closed' })).toEqual([]);
    });

    it('ASSISTANT_FAKE set', () => {
        expect(problems({ ASSISTANT_FAKE: 'all' })).toEqual([expect.stringMatching(/^ASSISTANT_FAKE must be unset/)]);
        expect(problems({ ASSISTANT_FAKE: '  ' })).toEqual([]);
    });

    it('DATABASE_URL on another host without sslmode=verify-full (a local one needs none)', () => {
        const neon = 'postgresql://app:pw@ep-quiet-sky-123456-pooler.ap-southeast-1.aws.neon.tech/workspace';
        for (const v of [neon, `${neon}?sslmode=require`, `${neon}?sslmode=no-verify`, `${neon}?sslmode=disable`]) {
            expect(problems({ DATABASE_URL: v })).toEqual([expect.stringMatching(/^DATABASE_URL must verify TLS/)]);
        }
        expect(problems({ DATABASE_URL: `${neon}?sslmode=VERIFY-FULL` })).toEqual([]);
        for (const local of ['postgresql://postgres:pw@localhost:5433/recollect_dev', 'postgresql://u:pw@127.0.0.1:5432/db', 'postgresql://u:pw@[::1]:5432/db', 'postgresql://u:pw@/db?host=/var/run/postgresql']) {
            expect(problems({ DATABASE_URL: local })).toEqual([]);
        }
        expect(problems({ DATABASE_URL: undefined })).toEqual(['DATABASE_URL is unset']);
        expect(problems({ DATABASE_URL: 'not a url' })).toEqual(['DATABASE_URL is not a valid connection URL']);
    });

    it('NODE_TLS_REJECT_UNAUTHORIZED=0 (every TLS check off) refuses the start (hosting review A8)', () => {
        expect(problems({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toEqual([expect.stringMatching(/^NODE_TLS_REJECT_UNAUTHORIZED=0 must be removed/)]);
        expect(problems({ NODE_TLS_REJECT_UNAUTHORIZED: '1' })).toEqual([]);
    });

    it('OAUTH_CIMD_HOSTS unset or blank refuses the start (hosting review A1)', () => {
        for (const v of [undefined, ' , ']) expect(problems({ OAUTH_CIMD_HOSTS: v })).toEqual([expect.stringMatching(/^OAUTH_CIMD_HOSTS must list/)]);
    });

    it('a pooled URL with sslmode=verify-full and no sslrootcert counts as verified (hosting review A9)', () => {
        expect(problems({ DATABASE_URL: 'postgresql://app:pw@ep-x-pooler.ap-southeast-1.aws.neon.tech/workspace?sslmode=verify-full&channel_binding=require' })).toEqual([]);
    });

    it('every problem at once, in a fixed order', () => {
        const all = productionProblems({ NODE_ENV: 'production', ASSISTANT_FAKE: 'qa@recollect.local', NODE_TLS_REJECT_UNAUTHORIZED: '0' });
        expect(all.map((p) => p.split(/[ =]/)[0])).toEqual(['JWT_SECRET', 'ALLOWED_ORIGINS', 'RECOLLECT_SELF_URL', 'HOST', 'SIGNUP_MODE', 'ASSISTANT_FAKE', 'NODE_TLS_REJECT_UNAUTHORIZED', 'OAUTH_CIMD_HOSTS', 'DATABASE_URL']);
    });
});

describe('refuseUnsafeProductionStart', () => {
    it('exits 1 with every problem listed by name, never a value', () => {
        const exit = vi.fn();
        const log = vi.fn();
        refuseUnsafeProductionStart(withEnv({ HOST: '0.0.0.0', JWT_SECRET: 'tiny-secret-value' }), exit, log);
        expect(exit).toHaveBeenCalledWith(1);
        const message = String(log.mock.calls[0]?.[0]);
        expect(message).toMatch(/^Refusing to start: NODE_ENV=production/);
        expect(message).toContain('  - JWT_SECRET must be at least 32');
        expect(message).toContain('  - HOST must be a loopback');
        expect(message).not.toContain('tiny-secret-value');
        expect(message).not.toContain('0.0.0.0');
        expect(message).not.toContain('pw@');
    });

    it('a safe env, or dev: no exit, nothing printed', () => {
        const exit = vi.fn();
        const log = vi.fn();
        refuseUnsafeProductionStart(GOOD, exit, log);
        refuseUnsafeProductionStart({ NODE_ENV: 'development' }, exit, log);
        expect(exit).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });
});
