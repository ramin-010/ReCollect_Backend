// The Claude API for the backend's AI features (Recall mode, practice notes, the weekly coach).
// Everything goes through the small AiClient interface so tests inject a fake: the real Anthropic
// client is never built under NODE_ENV=test.
//
// Config (backend/.env):
//   CLAUDE_API_KEY  required; without it the AI routes answer 503 AI_NOT_CONFIGURED. Never logged.
//   RECALL_MODEL    optional model override (default claude-opus-5-5). It must support adaptive
//                   thinking, effort and structured outputs (every current model does).
//
// On-demand calls use the beta Messages surface for server-side refusal fallbacks; Message Batches
// use the plain surface (batches reject `fallbacks`).
import Anthropic from '@anthropic-ai/sdk';
import type { BetaCreateParams, CreateParams } from '../recall/prompts';
import { aiFailed, aiNotConfigured, type AiHttpError } from './errors';

export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BatchRequest = { custom_id: string; params: CreateParams };
export type MessageBatch = Anthropic.Messages.Batches.MessageBatch;
export type BatchResultLine = Anthropic.Messages.Batches.MessageBatchIndividualResponse;

/** What the AI features need from the Claude API. */
export interface AiClient {
    /** One Messages API call (beta surface: refusal fallbacks). */
    createMessage(params: BetaCreateParams): Promise<BetaMessage>;
    createBatch(requests: BatchRequest[]): Promise<MessageBatch>;
    retrieveBatch(batchId: string): Promise<MessageBatch>;
    /** The results of an ended batch, in any order (match them by custom_id). */
    batchResults(batchId: string): Promise<AsyncIterable<BatchResultLine>>;
    cancelBatch(batchId: string): Promise<MessageBatch>;
}

/** RECALL_MODEL, else claude-opus-5-5. */
export function aiModel(): string {
    return process.env.RECALL_MODEL?.trim() || DEFAULT_AI_MODEL;
}

/** True when CLAUDE_API_KEY is set (the value itself is never read anywhere else). */
export function isAiConfigured(): boolean {
    return Boolean(process.env.CLAUDE_API_KEY?.trim());
}

/** Per attempt; the SDK retries 408/409/429/5xx and connection errors twice. */
const REQUEST_TIMEOUT_MS = 120_000;

function anthropicClient(apiKey: string): AiClient {
    const sdk = new Anthropic({ apiKey, maxRetries: 2, timeout: REQUEST_TIMEOUT_MS });
    return {
        createMessage: (params) => sdk.beta.messages.create(params),
        createBatch: (requests) => sdk.messages.batches.create({ requests }),
        retrieveBatch: (batchId) => sdk.messages.batches.retrieve(batchId),
        batchResults: (batchId) => sdk.messages.batches.results(batchId),
        cancelBatch: (batchId) => sdk.messages.batches.cancel(batchId),
    };
}

let injected: AiClient | null = null;
let real: AiClient | null = null;

/** Tests: use `client` instead of the Claude API (null puts the real one back). */
export function setAiClientForTests(client: AiClient | null): void {
    injected = client;
}

/** The client to call. Throws 503 AI_NOT_CONFIGURED without a key. */
export function getAiClient(): AiClient {
    if (injected) return injected;
    if (process.env.NODE_ENV === 'test') {
        throw new Error('Tests never call the Claude API: inject a fake with setAiClientForTests()');
    }
    const apiKey = process.env.CLAUDE_API_KEY?.trim();
    if (!apiKey) throw aiNotConfigured();
    real ??= anthropicClient(apiKey);
    return real;
}

/**
 * An SDK error as the HTTP error the app answers with. The key is never part of the message.
 * Most specific first; in the TypeScript SDK APIConnectionError is a subclass of APIError.
 */
export function aiErrorFrom(err: unknown, what: string): AiHttpError {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        console.error(`[ai] ${what}: the API key was rejected (${err.status})`);
        return aiNotConfigured('The AI key on the server was rejected. Check CLAUDE_API_KEY.');
    }
    if (err instanceof Anthropic.RateLimitError) {
        console.warn(`[ai] ${what}: rate limited`);
        return aiFailed('The AI is busy right now. Try again in a minute.', 'AI_BUSY');
    }
    if (err instanceof Anthropic.APIConnectionError) {
        console.error(`[ai] ${what}: could not reach the API: ${err.message}`);
        return aiFailed('The AI could not be reached. Try again.');
    }
    if (err instanceof Anthropic.APIError) {
        console.error(`[ai] ${what}: API error ${err.status ?? ''} ${err.type ?? ''}: ${err.message}`);
        if (err.type === 'billing_error') return aiFailed('The AI account is out of credit.', 'AI_BILLING');
        if (err.type === 'overloaded_error') return aiFailed('The AI is busy right now. Try again in a minute.', 'AI_BUSY');
        return aiFailed();
    }
    console.error(`[ai] ${what}: ${err instanceof Error ? err.message : String(err)}`);
    return aiFailed();
}

/** One on-demand Messages call; SDK errors become AiHttpErrors (502 / 503). */
export async function callClaude(params: BetaCreateParams, what: string): Promise<BetaMessage> {
    const client = getAiClient();
    try {
        return await client.createMessage(params);
    } catch (err) {
        throw aiErrorFrom(err, what);
    }
}
