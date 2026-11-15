// The Claude client wrapper (config, test guard, SDK errors → HTTP) and the cap / month math of the
// spend meter (src/services/claude). No database, no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_AI_MODEL, aiErrorFrom, aiModel, getAiClient, isAiConfigured, setAiClientForTests, type AiClient } from '../../../src/services/claude/client';
import { AiHttpError, aiCapReached } from '../../../src/services/claude/errors';
import { DEFAULT_MONTHLY_CAP_USD, isOverCap, monthRange } from '../../../src/services/claude/usage.service';

const saved = { key: process.env.CLAUDE_API_KEY, model: process.env.RECALL_MODEL };
afterEach(() => {
    process.env.CLAUDE_API_KEY = saved.key ?? '';
    process.env.RECALL_MODEL = saved.model ?? '';
    setAiClientForTests(null);
    vi.restoreAllMocks();
});

describe('config', () => {
    it('Opus 5.5 by default; RECALL_MODEL overrides it', () => {
        process.env.RECALL_MODEL = '';
        expect(DEFAULT_AI_MODEL).toBe('claude-opus-5-5');
        expect(aiModel()).toBe('claude-opus-5-5');
        process.env.RECALL_MODEL = ' claude-sonnet-5-5 ';
        expect(aiModel()).toBe('claude-sonnet-5-5');
    });

    it('configured = CLAUDE_API_KEY is set (blank is not)', () => {
        process.env.CLAUDE_API_KEY = '   ';
        expect(isAiConfigured()).toBe(false);
        process.env.CLAUDE_API_KEY = 'not-a-real-key';
        expect(isAiConfigured()).toBe(true);
    });
});

describe('getAiClient', () => {
    it('never builds the real client under NODE_ENV=test, even with a key', () => {
        process.env.CLAUDE_API_KEY = 'not-a-real-key';
        expect(process.env.NODE_ENV).toBe('test');
        expect(() => getAiClient()).toThrow(/never call the Claude API/);
    });

    it('returns the injected fake', () => {
        const fake = { createMessage: vi.fn() } as unknown as AiClient;
        setAiClientForTests(fake);
        expect(getAiClient()).toBe(fake);
    });
});

describe('aiErrorFrom (SDK errors → the app’s answer)', () => {
    const apiError = (status: number, type: string) =>
        Anthropic.APIError.generate(status, { type: 'error', error: { type, message: 'm' } }, `${status} ${type}`, new Headers());

    it.each([
        [401, 'authentication_error', 503, 'AI_NOT_CONFIGURED'],
        [403, 'permission_error', 503, 'AI_NOT_CONFIGURED'],
        [429, 'rate_limit_error', 502, 'AI_BUSY'],
        [529, 'overloaded_error', 502, 'AI_BUSY'],
        [402, 'billing_error', 502, 'AI_BILLING'],
        [400, 'invalid_request_error', 502, 'AI_FAILED'],
        [500, 'api_error', 502, 'AI_FAILED'],
    ])('%i %s → %i %s', (status, type, httpStatus, code) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const err = aiErrorFrom(apiError(status, type), 'test');
        expect(err).toBeInstanceOf(AiHttpError);
        expect([err.statusCode, err.code]).toEqual([httpStatus, code]);
    });

    it('a network failure or anything else is a 502 AI_FAILED', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(aiErrorFrom(new Anthropic.APIConnectionError({ message: 'down' }), 'test').code).toBe('AI_FAILED');
        expect(aiErrorFrom(new Anthropic.APIConnectionTimeoutError(), 'test').code).toBe('AI_FAILED');
        expect(aiErrorFrom(new Error('boom'), 'test').statusCode).toBe(502);
    });
});

describe('the monthly cap', () => {
    it('stops new calls once spend reaches the cap ($0 = no calls)', () => {
        expect(DEFAULT_MONTHLY_CAP_USD).toBe(50);
        expect(isOverCap(19.999999, 20)).toBe(false);
        expect(isOverCap(20, 20)).toBe(true);
        expect(isOverCap(25, 20)).toBe(true);
        expect(isOverCap(0, 0)).toBe(true);
    });

    it('402 AI_CAP_REACHED says how much was spent of what', () => {
        const err = aiCapReached(20.4, 20);
        expect([err.statusCode, err.code]).toEqual([402, 'AI_CAP_REACHED']);
        expect(err.message).toContain('$20.40');
        expect(err.message).toContain('$20.00');
    });
});

describe('monthRange (the user’s local month)', () => {
    it('Kolkata: 30 Nov 19:00 UTC is already 1 December there', () => {
        const r = monthRange('Asia/Kolkata', new Date('2026-11-30T19:00:00Z'));
        expect(r.month).toBe('2026-12');
        expect(r.start.toISOString()).toBe('2026-11-30T18:30:00.000Z');
        expect(r.end.toISOString()).toBe('2026-12-31T18:30:00.000Z');
    });

    it('New York across the end of daylight saving time', () => {
        const r = monthRange('America/New_York', new Date('2026-11-01T03:00:00Z')); // 31 Oct, 23:00 EDT
        expect(r.month).toBe('2026-10');
        expect(r.start.toISOString()).toBe('2026-10-01T04:00:00.000Z');
        expect(r.end.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    });
});
