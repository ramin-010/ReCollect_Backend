// Claude prices and the cost of one call, from its `usage` (pure: no SDK, no database).
//
// THE PRICE TABLE LIVES HERE AND NOWHERE ELSE. USD per million tokens, Anthropic's first-party API
// prices (claude-api skill, models table cached 2026-11-03). Cache writes are the 5-minute TTL
// (1.25× input) unless a call reports 1-hour writes (2× input); cache reads as listed (0.05× on Opus
// 5.5 / Sonnet 5.5, 0.025× on Fable 5.x, 0.1× elsewhere). The Message Batches API is half price on
// every token kind. Rows marked "derived" apply those documented multipliers to the model's input
// price because the skill lists only its input/output price.
//
// A model missing from the table is priced like the most expensive row, so the monthly cap errs on
// the safe side (it can only stop spending early, never late).

/** USD per 1M tokens. */
export interface ModelPrice {
    input: number;
    output: number;
    /** 5-minute cache write. */
    cacheWrite5m: number;
    /** 1-hour cache write. */
    cacheWrite1h: number;
    cacheRead: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
    // The default model (RECALL_MODEL overrides it).
    'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
    // Refusal fallbacks ("default" picks by category) and other overrides. Derived cache prices.
    'claude-opus-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
    'claude-opus-4-8': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
    'claude-sonnet-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
    // Prompts of at most 100K tokens (recall prompts are far smaller); above that it is 5× these.
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
    'claude-fable-5-2': { input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2 },
    'claude-fable-5-1': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
});

/** The Message Batches API bills every token kind at half price. */
export const BATCH_PRICE_FACTOR = 0.5;

const PRICIEST: ModelPrice = Object.values(MODEL_PRICES).reduce((a, b) => (b.output > a.output ? b : a));

const warnedUnknown = new Set<string>();

/** A model id without a trailing date (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`). */
export function baseModelId(model: string): string {
    return model.trim().replace(/-\d{8}$/, '');
}

/** The model's prices; an unknown model gets the most expensive row (see the header). */
export function priceOf(model: string): ModelPrice {
    const known = MODEL_PRICES[baseModelId(model)];
    if (known) return known;
    if (!warnedUnknown.has(model)) {
        warnedUnknown.add(model);
        console.warn(`[ai] no price for model "${model}": costing it like the most expensive model`);
    }
    return PRICIEST;
}

/** The token counts of one API call or one iteration of it (the SDK's Usage / BetaUsage fit). */
export interface TokenUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

/** A response's usage. `iterations` (beta) lists every billed attempt, e.g. a refusal fallback's. */
export interface CallUsage extends TokenUsage {
    iterations?: ReadonlyArray<Partial<TokenUsage> & { type?: string; model?: string | null }> | null;
}

export interface UsageTotals {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Tokens and cost of one usage block at one model's prices. */
export function costOfTokens(usage: Partial<TokenUsage>, model: string, batch = false): UsageTotals {
    const p = priceOf(model);
    const input = n(usage.input_tokens);
    const output = n(usage.output_tokens);
    const read = n(usage.cache_read_input_tokens);
    const write = n(usage.cache_creation_input_tokens);
    // The TTL split when the API reports it; otherwise every write is a 5-minute write.
    const write1h = usage.cache_creation ? Math.min(write, n(usage.cache_creation.ephemeral_1h_input_tokens)) : 0;
    const write5m = write - write1h;
    const usd = (input * p.input + output * p.output + read * p.cacheRead + write5m * p.cacheWrite5m + write1h * p.cacheWrite1h) / 1_000_000;
    return {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: read,
        cacheWriteTokens: write,
        costUsd: usd * (batch ? BATCH_PRICE_FACTOR : 1),
    };
}

/**
 * Tokens and cost of a whole response. With `usage.iterations` (the beta surface) every entry is
 * priced at its own model: a refusal fallback bills the declined attempt at the requested model and
 * the answer at the fallback model. Without iterations, the top-level usage at `model`.
 */
export function costOfCall(usage: CallUsage, model: string, batch = false): UsageTotals {
    const parts = (usage.iterations ?? []).filter((it) => it && (typeof it.input_tokens === 'number' || typeof it.output_tokens === 'number'));
    const priced = parts.length > 0 ? parts.map((it) => costOfTokens(it, it.model || model, batch)) : [costOfTokens(usage, model, batch)];
    return priced.reduce(
        (sum, t) => ({
            inputTokens: sum.inputTokens + t.inputTokens,
            outputTokens: sum.outputTokens + t.outputTokens,
            cacheReadTokens: sum.cacheReadTokens + t.cacheReadTokens,
            cacheWriteTokens: sum.cacheWriteTokens + t.cacheWriteTokens,
            costUsd: sum.costUsd + t.costUsd,
        }),
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
    );
}

/** USD rounded to the 6 decimals AiUsage.costUsd stores. */
export function roundUsd(usd: number): number {
    return Math.round(usd * 1_000_000) / 1_000_000;
}
