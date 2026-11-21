// Stage 10 of ECOSYSTEM_V2_PLAN: a person's own key is kept sealed (AES-256-GCM): it opens only with the server's
// secret, a changed row does not open, and the plain key is in none of the stored fields.
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openKey, sealKey } from '../../../src/services/claude/ownKeys';

const secret = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();
const KEY = `sk-ant-api03-${'abc123'.repeat(15)}WXYZ`;

describe('own keys, sealed', () => {
    it('round trip with the secret; a new iv each time; the plain key in no stored field', () => {
        const a = sealKey(KEY, secret('server secret'));
        const b = sealKey(KEY, secret('server secret'));
        expect(openKey(a, secret('server secret'))).toBe(KEY);
        expect(a.iv).not.toBe(b.iv);
        expect(a.cipher).not.toBe(b.cipher);
        expect(JSON.stringify(a)).not.toContain(KEY.slice(7, 30));
    });
    it('a wrong secret or a changed row does not open', () => {
        const a = sealKey(KEY, secret('server secret'));
        expect(() => openKey(a, secret('another secret'))).toThrow();
        const flipped = Buffer.from(a.cipher, 'base64');
        flipped[0] = flipped[0]! ^ 1;
        expect(() => openKey({ ...a, cipher: flipped.toString('base64') }, secret('server secret'))).toThrow();
    });
});
