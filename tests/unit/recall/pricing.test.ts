// The cost of a Claude call from its usage (src/services/claude/pricing.ts). No database.
import { describe, expect, it, vi } from 'vitest';
import { BATCH_PRICE_FACTOR, MODEL_PRICES, baseModelId, costOfCall, costOfTokens, priceOf, roundUsd } from '../../../src/services/claude/pricing';

const M = 1_000_000;

describe('the price table', () => {
    it('has Opus 5.5 at $4 in / $20 out, cache writes $5 (5 min) and $8 (1 h), cache reads $0.20', () => {
        expect(MODEL_PRICES['claude-opus-5-5']).toEqual({ input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 });
    });

    it('batch is half price', () => {
        expect(BATCH_PRICE_FACTOR).toBe(0.5);
    });

    it('a date-suffixed id finds its model; an unknown model is priced like the most expensive one', () => {
        expect(baseModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
        expect(priceOf('claude-sonnet-5-5-20261001')).toBe(MODEL_PRICES['claude-sonnet-5-5']);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const maxOutput = Math.max(...Object.values(MODEL_PRICES).map((p) => p.output));
        expect(priceOf('claude-made-up-9').output).toBe(maxOutput);
        warn.mockRestore();
    });
});

describe('costOfTokens', () => {
    it('prices each token kind per million on Opus 5.5', () => {
        expect(costOfTokens({ input_tokens: M, output_tokens: 0 }, 'claude-opus-5-5').costUsd).toBeCloseTo(4, 10);
        expect(costOfTokens({ input_tokens: 0, output_tokens: M }, 'claude-opus-5-5').costUsd).toBeCloseTo(20, 10);
        expect(costOfTokens({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: M }, 'claude-opus-5-5').costUsd).toBeCloseTo(0.2, 10);
        expect(costOfTokens({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: M }, 'claude-opus-5-5').costUsd).toBeCloseTo(5, 10);
    });

    it('a typical grading call: uncached input + output + cache read + cache write', () => {
        const t = costOfTokens(
            { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 3000, cache_creation_input_tokens: 2000 },
            'claude-opus-5-5'
        );
        // (1200·4 + 800·20 + 3000·0.2 + 2000·5) / 1M
        expect(t.costUsd).toBeCloseTo(0.0314, 10);
        expect(t).toMatchObject({ inputTokens: 1200, outputTokens: 800, cacheReadTokens: 3000, cacheWriteTokens: 2000 });
    });

    it('the same call in a Message Batch costs half, on every token kind', () => {
        const usage = { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 3000, cache_creation_input_tokens: 2000 };
        expect(costOfTokens(usage, 'claude-opus-5-5', true).costUsd).toBeCloseTo(0.0157, 10);
    });

    it('1-hour cache writes are priced at 2× input when the API reports them', () => {
        const t = costOfTokens(
            {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 3000,
                cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
            },
            'claude-opus-5-5'
        );
        expect(t.costUsd).toBeCloseTo((1000 * 5 + 2000 * 8) / M, 12);
        expect(t.cacheWriteTokens).toBe(3000);
    });

    it('missing, null or negative counts are zero', () => {
        const t = costOfTokens({ input_tokens: -5, output_tokens: 10, cache_read_input_tokens: null }, 'claude-opus-5-5');
        expect(t).toMatchObject({ inputTokens: 0, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    });
});

describe('costOfCall', () => {
    it('without iterations: the top-level usage at the response model', () => {
        const t = costOfCall({ input_tokens: 1000, output_tokens: 100, iterations: null }, 'claude-opus-5-5');
        expect(t.costUsd).toBeCloseTo((1000 * 4 + 100 * 20) / M, 12);
    });

    it('a refusal fallback: the declined attempt at Opus 5.5, the answer at the fallback model', () => {
        const t = costOfCall(
            {
                input_tokens: 100,
                output_tokens: 50,
                iterations: [
                    { type: 'message', model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                    { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                ],
            },
            'claude-opus-4-8'
        );
        expect(t.costUsd).toBeCloseTo((100 * 4) / M + (100 * 5 + 50 * 25) / M, 12);
        expect(t).toMatchObject({ inputTokens: 200, outputTokens: 50 });
    });

    it('an iteration without a model is priced at the response model', () => {
        const t = costOfCall({ input_tokens: 10, output_tokens: 10, iterations: [{ type: 'message', model: null, input_tokens: 1000, output_tokens: 0 }] }, 'claude-sonnet-5-5');
        expect(t.costUsd).toBeCloseTo((1000 * 2) / M, 12);
    });

    it('batch halves every iteration too', () => {
        const usage = { input_tokens: 1000, output_tokens: 1000, iterations: [{ type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 1000 }] };
        expect(costOfCall(usage, 'claude-opus-5-5', true).costUsd).toBeCloseTo(costOfCall(usage, 'claude-opus-5-5').costUsd / 2, 12);
    });
});

describe('roundUsd', () => {
    it('keeps the 6 decimals AiUsage stores', () => {
        expect(roundUsd(0.0314000004)).toBe(0.0314);
        expect(roundUsd(1.23456789)).toBe(1.234568);
    });
});
