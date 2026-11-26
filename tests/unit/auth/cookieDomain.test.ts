// KAAGA_REBRAND_PLAN: the sign-in cookie's Domain follows the host that asked, so the old address and the new one can
// both serve while people move (a browser refuses a cookie for another site, which would sign no one in).
import { describe, expect, it } from 'vitest';
import { cookieDomainFor } from '../../../src/services/auth/token';

describe('the cookie domain for a request', () => {
    it('unset: no Domain at all', () => {
        expect(cookieDomainFor(undefined, 'api.kaaga.in')).toBeUndefined();
        expect(cookieDomainFor('', 'api.kaaga.in')).toBeUndefined();
    });
    it('one domain: used as before (no host known), or when the host belongs to it', () => {
        expect(cookieDomainFor('.kaaga.in', undefined)).toBe('.kaaga.in');
        expect(cookieDomainFor('.kaaga.in', 'api.kaaga.in')).toBe('.kaaga.in');
        expect(cookieDomainFor('.kaaga.in', 'kaaga.in')).toBe('.kaaga.in');
    });
    it('several: the one the host belongs to; none for another site', () => {
        const both = '.kaaga.in, .re-collect.in';
        expect(cookieDomainFor(both, 'api.kaaga.in')).toBe('.kaaga.in');
        expect(cookieDomainFor(both, 'api.re-collect.in')).toBe('.re-collect.in');
        expect(cookieDomainFor(both, 'localhost')).toBeUndefined();
        // A look-alike host is not the domain.
        expect(cookieDomainFor(both, 'evilkaaga.in')).toBeUndefined();
    });
});
