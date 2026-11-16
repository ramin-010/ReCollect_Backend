// Which database a maintenance script may touch (hosting review A5, A7): scripts/lib/target.ts; and the
// cutover's pure rules (scripts/lib/cutover.ts). The cutover on a real database: tests/integration/cutover.test.ts.
import { describe, expect, it } from 'vitest';
import { describeTarget, isDevDatabase, parseTarget, resolveTarget, type ResolveOptions } from '../../../scripts/lib/target';
import { maskEmail, passwordProblem } from '../../../scripts/lib/cutover';
import { mentionPattern } from '../../../scripts/lib/officeFilter';

const NEON = 'postgresql://app:s3cret@ep-cool-1-pooler.ap-southeast-1.aws.neon.tech/workspace?sslmode=verify-full';
const DEV = 'postgresql://postgres:postgres@127.0.0.1:5433/recollect_dev';
const at = (host: string, port: number, db: string) => `postgresql://u:p@${host}:${port}/${db}`;
const resolve = (url: string | undefined, purpose: ResolveOptions['purpose'], more: Partial<ResolveOptions> = {}) =>
    resolveTarget({ purpose, startUrl: url, currentUrl: url, devUrl: DEV, ...more });

describe('the target of a maintenance script', () => {
    it('is described by host, port and database, never by its user or password', () => {
        const text = describeTarget(parseTarget(NEON));
        expect(text).toBe('ep-cool-1-pooler.ap-southeast-1.aws.neon.tech:5432/workspace (sslmode=verify-full)');
        expect(text).not.toMatch(/s3cret|app:/);
    });

    it('must be given to the process: never missing, never changed while loading, always postgresql://', () => {
        expect(() => resolve(undefined, 'maintenance')).toThrow(/No database named/);
        expect(() => resolveTarget({ purpose: 'maintenance', startUrl: undefined, currentUrl: DEV, devUrl: DEV })).toThrow(/No database named/);
        expect(() => resolveTarget({ purpose: 'maintenance', startUrl: NEON, currentUrl: DEV, devUrl: DEV })).toThrow(/changed while the script loaded/);
        expect(() => resolve('mysql://u:p@db.example.org/workspace', 'maintenance')).toThrow(/postgresql/);
    });

    it('knows the dev database by its name anywhere, by the dev port on this machine, or as backend/.env names it', () => {
        expect(isDevDatabase(parseTarget(DEV), DEV)).toBe(true);
        expect(isDevDatabase(parseTarget(at('db.example.org', 5432, 'recollect_dev')), undefined)).toBe(true);
        expect(isDevDatabase(parseTarget(at('localhost', 5433, 'anything')), undefined)).toBe(true);
        expect(isDevDatabase(parseTarget(at('localhost', 5433, 'recollect_test_cutover')), undefined)).toBe(false);
        // a renamed dev database is still the dev database when backend/.env points at it
        const renamed = 'postgresql://postgres:postgres@127.0.0.1:5544/mydev';
        expect(isDevDatabase(parseTarget(at('localhost', 5544, 'mydev')), renamed)).toBe(true);
        expect(isDevDatabase(parseTarget(at('localhost', 5544, 'mydev')), undefined)).toBe(false);
        expect(isDevDatabase(parseTarget(NEON), DEV)).toBe(false);
    });

    it('the cutover never runs on the dev database, nor on a database on this machine that is not a disposable copy', () => {
        expect(() => resolve(DEV, 'cutover')).toThrow(/dev database; the cutover never runs on it/);
        expect(() => resolve(DEV, 'cutover', { allowDev: true })).toThrow(/never runs on it/);
        expect(() => resolve(at('localhost', 5432, 'postgres'), 'cutover')).toThrow(/not a disposable copy/);
        expect(resolve(at('127.0.0.1', 5433, 'recollect_test_cutover'), 'cutover').database).toBe('recollect_test_cutover');
        expect(resolve(at('localhost', 5432, 'restore_20261116'), 'cutover').database).toBe('restore_20261116');
        expect(resolve(NEON, 'cutover').host).toBe('ep-cool-1-pooler.ap-southeast-1.aws.neon.tech');
    });

    it('the office filter runs only on a disposable copy, on any host: never dev, never production', () => {
        expect(() => resolve(DEV, 'scratch')).toThrow(/dev database; this runs only on a disposable copy/);
        expect(() => resolve(DEV, 'scratch', { allowDev: true })).toThrow(/dev database/);
        expect(() => resolve(NEON, 'scratch')).toThrow(/not a disposable copy/);
        expect(() => resolve(at('localhost', 5432, 'postgres'), 'scratch')).toThrow(/not a disposable copy/);
        expect(resolve(at('127.0.0.1', 5433, 'recollect_test_office'), 'scratch').database).toBe('recollect_test_office');
        expect(resolve(at('db.example.org', 5432, 'restore_20261116'), 'scratch').database).toBe('restore_20261116');
    });

    it('check-blocks and search-reindex take the dev database only with --allow-dev', () => {
        expect(() => resolve(DEV, 'maintenance')).toThrow(/add --allow-dev/);
        expect(resolve(DEV, 'maintenance', { allowDev: true }).database).toBe('recollect_dev');
        expect(resolve(NEON, 'maintenance').database).toBe('workspace');
    });
});

describe("the cutover's rules", () => {
    it('masks the address of an account that stays', () => {
        expect(maskEmail('ramin.example@gmail.com')).toBe('r***e@gmail.com');
        expect(maskEmail('ab@x.org')).toBe('a*@x.org');
    });

    it("the office filter's mention check: each key as a whole word, its punctuation escaped", () => {
        expect(mentionPattern(['erp', 'erp-workspace', 'a.b'])).toBe('\\m(erp|erp\\-workspace|a\\.b)\\M');
        expect(mentionPattern([])).toBeNull();
    });

    it("refuses a weak owner password, a padded one and the dev setup's", () => {
        expect(passwordProblem('short-one')).toMatch(/at least 12/);
        expect(passwordProblem(' a-long-enough-password')).toMatch(/no space/);
        expect(passwordProblem('a-long-enough-password')).toBeNull();
    });
});
