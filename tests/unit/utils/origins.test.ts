// D7 (MANAGER_AND_DOCS_PLAN §1): one list of allowed web addresses for CORS and the live server;
// ALLOWED_ORIGINS replaces it when set (the deploy).
import { afterEach, describe, expect, it } from 'vitest';
import { allowedOrigins } from '../../../src/config/origins';

afterEach(() => {
    delete process.env['ALLOWED_ORIGINS'];
});

describe('allowed origins', () => {
    it('defaults to the local and known addresses', () => {
        expect(allowedOrigins()).toContain('http://localhost:3005');
    });

    it('takes ALLOWED_ORIGINS, comma-separated, trimmed, without trailing slashes', () => {
        process.env['ALLOWED_ORIGINS'] = ' https://app.example.com/ , https://www.example.com,';
        expect(allowedOrigins()).toEqual(['https://app.example.com', 'https://www.example.com']);
    });
});
