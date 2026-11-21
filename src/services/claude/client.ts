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
import { HOUSE_KEY, PROBE_BUSY_MS, PROBE_EVERY_MS, aiAccessFor, aiPaused, aiWaitError, classifyAiError, keysToProbe, markKeyOk, noteAiFailure, probeLater } from './access';

export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BatchRequest = { custom_id: string; params: CreateParams };
export type MessageBatch = Anthropic.Messages.Batches.MessageBatch;
export type BatchResultLine = Anthropic.Messages.Batches.MessageBatchIndividualResponse;

export interface StreamOptions {
    /** Each piece of the answer's text as it arrives. */
    onText?: (delta: string) => void;
    /** His Stop: the call ends at once; what had arrived is kept. */
    signal?: AbortSignal;
}

/** What the AI features need from the Claude API. */
export interface AiClient {
    /** One Messages API call (beta surface: refusal fallbacks). */
    createMessage(params: BetaCreateParams): Promise<BetaMessage>;
    /**
     * The same call, streamed: text pieces go to `onText` as they arrive; resolves with the whole
     * message. Stopped through `signal`, it resolves with what had arrived (its usage so far), or
     * rejects when nothing had. Optional: a client without it is called with createMessage.
     */
    streamMessage?(params: BetaCreateParams, options: StreamOptions): Promise<BetaMessage>;
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
        // Tool inputs are not streamed eagerly: nothing shows a tool's input before it runs, so the
        // API keeps buffering and checking each one (the claude-api skill's eager-input option is off).
        streamMessage: async (params, { onText, signal }) => {
            const stream = sdk.beta.messages.stream(params as never, signal ? { signal } : undefined);
            if (onText) stream.on('text', (delta) => onText(delta));
            try {
                return await stream.finalMessage();
            } catch (err) {
                const partial = stream.currentMessage;
                if (signal?.aborted && partial) return partial;
                throw err;
            }
        },
        createBatch: (requests) => sdk.messages.batches.create({ requests }),
        retrieveBatch: (batchId) => sdk.messages.batches.retrieve(batchId),
        batchResults: (batchId) => sdk.messages.batches.results(batchId),
        cancelBatch: (batchId) => sdk.messages.batches.cancel(batchId),
    };
}

/** Tests: one fake for every key ('*'), or one per key (stage 2: two accounts on two keys). */
const injected = new Map<string, AiClient>();
let real: AiClient | null = null;
/** Stage 10: a client per person's own key ("own:<id>"), made when the key is first used (./ownKeys.ts). */
const own = new Map<string, AiClient>();

/** Stage 10: the client for a person's own key, made once from the key ./ownKeys.ts opened. */
export function registerOwnClient(keyId: string, apiKey: string): void {
    if (process.env.NODE_ENV === 'test') return;
    if (!own.has(keyId)) own.set(keyId, anthropicClient(apiKey));
}
export function forgetOwnClient(keyId: string): void {
    own.delete(keyId);
}
export const hasOwnClient = (keyId: string): boolean => own.has(keyId);

/** Stage 10: a client for checking a key before it is stored (never cached; tests: the 'check' fake or '*'). */
export function checkClient(apiKey: string): AiClient {
    const fake = injected.get('check') ?? injected.get('*');
    if (fake) return fake;
    if (process.env.NODE_ENV === 'test') throw new Error('Tests never call the Claude API: inject a fake with setAiClientForTests()');
    return anthropicClient(apiKey);
}

/** Tests: use `client` instead of the Claude API, for every key or for `keyId` (null puts the real one back). */
export function setAiClientForTests(client: AiClient | null, keyId = '*'): void {
    if (client) injected.set(keyId, client);
    else if (keyId === '*') injected.clear();
    else injected.delete(keyId);
}

/**
 * The client for one key (the server's by default; a person's own key is stage 10). Throws 503
 * AI_NOT_CONFIGURED without one. A call never falls back to another key.
 */
export function getAiClient(keyId: string = HOUSE_KEY): AiClient {
    const fake = injected.get(keyId) ?? injected.get('*');
    if (fake) return fake;
    if (process.env.NODE_ENV === 'test') {
        throw new Error('Tests never call the Claude API: inject a fake with setAiClientForTests()');
    }
    // Stage 10: a person's own key (opened by ./ownKeys.ts when keyFor chose it).
    if (keyId !== HOUSE_KEY) {
        const mine = own.get(keyId);
        if (mine) return mine;
        throw aiNotConfigured('This key is not set up on this server.');
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
    // Out of credit or a rejected key: the key is paused (./access.ts), a state the apps show calmly.
    const fault = classifyAiError(err);
    if (fault === 'no_credit' || fault === 'bad_key') {
        console.error(`[ai] ${what}: ${fault === 'no_credit' ? 'the key is out of credit' : 'the key was not accepted'}`);
        return aiPaused(fault);
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
        if (err.type === 'overloaded_error') return aiFailed('The AI is busy right now. Try again in a minute.', 'AI_BUSY');
        return aiFailed();
    }
    console.error(`[ai] ${what}: ${err instanceof Error ? err.message : String(err)}`);
    return aiFailed();
}

/**
 * One on-demand Messages call for an account, on that account's key (ECOSYSTEM_V2_PLAN stage 2). A
 * paused key answers 503 AI_PAUSED with no call made; a failure that pauses the key (no credit, a
 * rejected key) pauses it for every account on it. SDK errors become AiHttpErrors (502 / 503).
 */
export async function callClaude(userId: string, params: BetaCreateParams, what: string): Promise<BetaMessage> {
    const access = await aiAccessFor(userId);
    if (!access.keyId) throw aiNotConfigured();
    // A paused key, or (stage 11) a friend whose free AI waits: no call, the calm 503.
    const wait = aiWaitError(access);
    if (wait) throw wait;
    const client = getAiClient(access.keyId);
    try {
        const message = await client.createMessage(params);
        servedBy.set(message, access.keyId);
        return message;
    } catch (err) {
        await noteAiFailure(access.keyId, err);
        throw aiErrorFrom(err, what);
    }
}

/** Which key answered a message callClaude returned (stage 11: the meter's `source`; own-key spend is never the owner's). */
const servedBy = new WeakMap<object, string>();

/** 'own' when a person's own key answered this message, 'house' when the server's did, null when unknown. */
export function sourceOfMessage(message: object): 'house' | 'own' | null {
    const keyId = servedBy.get(message);
    return keyId === undefined ? null : keyId === HOUSE_KEY ? 'house' : 'own';
}

/** The smallest call a key can answer: one token from the cheapest model. */
export const PROBE_MODEL = 'claude-haiku-5-5';

/**
 * Asks a paused key whether it works again: one tiny call. Works: the key is fine (true). Still no
 * credit or still rejected: the next probe in 6 hours. Busy or unreachable: in 15 minutes.
 */
export async function probeKey(keyId: string, now: Date = new Date()): Promise<boolean> {
    // Stage 10: a person's own key after a restart: its client from its row first (a removed one is not probed).
    if (keyId !== HOUSE_KEY && !injected.size && !(await (await import('./ownKeys')).loadOwnClient(keyId))) {
        await probeLater(keyId, new Date(now.getTime() + PROBE_EVERY_MS));
        return false;
    }
    try {
        await getAiClient(keyId).createMessage({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] } as unknown as BetaCreateParams);
    } catch (err) {
        const fault = classifyAiError(err);
        if (fault === 'no_credit' || fault === 'bad_key') await noteAiFailure(keyId, err, now);
        else await probeLater(keyId, new Date(now.getTime() + (fault === 'busy' ? PROBE_BUSY_MS : PROBE_EVERY_MS)));
        return false;
    }
    const resumed = await markKeyOk(keyId);
    if (resumed) console.log(`[ai] the ${keyId === HOUSE_KEY ? "server's" : 'a'} key works again`);
    return true;
}

/** Every paused key whose probe is due (the scheduler's aiProbe job). Returns the keys that work again. */
export async function probeDueKeys(now: Date = new Date()): Promise<string[]> {
    const back: string[] = [];
    for (const keyId of await keysToProbe(now)) if (await probeKey(keyId, now)) back.push(keyId);
    return back;
}
