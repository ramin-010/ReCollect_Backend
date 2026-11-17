// The buddy's secret scrub (BUDDY_MEMORY_PLAN §3.1): what goes and what stays.
import { describe, expect, it } from 'vitest';
import { SECRET, looksRandom, scrubSecrets } from '../../../src/services/buddy/scrub';
import { cleanNoteText, memoryKey, normalizeTags } from '../../../src/services/buddy/memory.service';

// Built from pieces so this file holds no key-shaped string a scanner would flag.
const k = (...parts: string[]) => parts.join('');

describe('scrubSecrets', () => {
    const gone: Array<[string, string]> = [
        ['an Anthropic key', `my key is ${k('sk-ant-api03-', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345')}`],
        ['an OpenAI key', `export OPENAI=${k('sk-', 'proj', 'A1b2C3d4E5f6G7h8I9j0')}`],
        ['a Recollect token', `token ${k('rcl_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefg')}`],
        ['a GitHub token', k('ghp_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789')],
        ['an AWS key id', `id ${k('AKIA', 'IOSFODNN7EXAMPLE')} here`],
        ['a Slack token', k('xoxb-', '1234567890-abcdefghij')],
        ['a JWT', k('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')],
        ['a password=', 'login with password=hunter2!x'],
        ['an api_key in JSON', '{"api_key": "abcd1234efgh"}'],
        ['a token= value', 'curl ?token=abc123def456'],
        ['a URL password', 'postgres://admin:s3cretPass@db.example.com:5432/app'],
        ['a private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'],
        ['a long hex run', `hash ${'0123456789abcdef'.repeat(3)}`],
        ['a random base64 run', 'blob Zx8Qp2Lm9Rt4Wv7Yb1Nc6Hd3Kf5Gj0Ae2Su8Io4'],
    ];
    for (const [what, text] of gone) {
        it(`removes ${what}`, () => {
            const out = scrubSecrets(text);
            expect(out).toContain(SECRET);
            expect(out).not.toMatch(/hunter2|s3cretPass|abcd1234efgh|abc123def456|MIIEow|IOSFODNN7|Zx8Qp2Lm9R/);
        });
    }

    const kept = [
        'I am worried the job search is slow and my DSA is behind',
        'the token: it expires after a day, so the hook refreshes it',
        'Tests pass: 12 of 12 after the fix',
        'See https://example.com/2026/11/how-to-design-a-rate-limiter-for-apis',
        'Rename getUserProfileSettingsFromDatabaseQuickly to something shorter',
        'The cuid cmwgckra20005vsxb6xgigs5r is a topic id',
        'A UUID 11111111-2222-4333-8444-555555555555 in a log',
        'D:/projects/notes-app/backend/src/services/buddy/memory.service.ts',
    ];
    for (const text of kept) it(`keeps: ${text.slice(0, 40)}`, () => expect(scrubSecrets(text)).toBe(text));

    it('looksRandom: random text yes, names and words no', () => {
        expect(looksRandom('Zx8Qp2Lm9Rt4Wv7Yb1Nc6Hd3Kf5Gj0Ae2Su8Io4')).toBe(true);
        expect(looksRandom('getUserProfileSettingsFromDatabaseQuickly')).toBe(false);
        expect(looksRandom('a'.repeat(40))).toBe(false);
    });
});

describe('note text', () => {
    it('cleans, scrubs and cuts at a word', () => {
        expect(cleanNoteText('  likes   short\n replies ')).toBe('likes short replies');
        const long = cleanNoteText('word '.repeat(100));
        expect(long.length).toBeLessThanOrEqual(300);
        expect(long.endsWith('…')).toBe(true);
        expect(cleanNoteText(`key ${k('sk-ant-', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345')}`)).toBe(`key ${SECRET}`);
    });

    it('memoryKey ignores case and punctuation; tags are lower case and unique', () => {
        expect(memoryKey('Prefers BLUNT pushback!')).toBe(memoryKey('prefers blunt, pushback'));
        expect(normalizeTags(['Recollect', ' recollect '], ['DSA'], [null, ''])).toEqual(['recollect', 'dsa']);
    });
});
