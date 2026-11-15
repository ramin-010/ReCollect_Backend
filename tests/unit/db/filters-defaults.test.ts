import { describe, expect, it } from 'vitest';
import { containsInsensitive, escapeLike, startsWithInsensitive } from '../../../src/db/filters';
import { generateInviteToken } from '../../../src/db/defaults';

describe('escapeLike', () => {
    it('escapes LIKE wildcards and the escape character itself', () => {
        expect(escapeLike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
        expect(escapeLike('plain text')).toBe('plain text');
    });

    it('builds case-insensitive Prisma filters', () => {
        expect(containsInsensitive('50%')).toEqual({ contains: '50\\%', mode: 'insensitive' });
        expect(startsWithInsensitive('re_')).toEqual({ startsWith: 're\\_', mode: 'insensitive' });
    });
});

describe('app-side defaults', () => {
    it('invite tokens are 32-char base64url strings', () => {
        const token = generateInviteToken();
        expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(generateInviteToken()).not.toBe(token);
    });
});
