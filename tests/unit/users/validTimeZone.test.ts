// Stage 11 (ECOSYSTEM_V2_PLAN §9.6): the browser's time zone at signup is kept only when it is a real IANA zone.
import { describe, expect, it } from 'vitest';
import { validTimeZone } from '../../../src/services/users/users.service';

describe('validTimeZone', () => {
    it('keeps a real zone, refuses anything else', () => {
        expect(validTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
        expect(validTimeZone(' Asia/Kolkata ')).toBe('Asia/Kolkata');
        expect(validTimeZone('Mars/Olympus')).toBeNull();
        expect(validTimeZone('')).toBeNull();
        expect(validTimeZone(undefined)).toBeNull();
        expect(validTimeZone('x'.repeat(65))).toBeNull();
    });
});
