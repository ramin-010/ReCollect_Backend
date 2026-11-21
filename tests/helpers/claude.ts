// A fake Claude API for integration tests: an AiClient (src/services/claude/client.ts) that records
// every request and answers from a queue, else with a default for the request's kind. Message
// Batches stay `in_progress` until the test ends them. Nothing here touches the network.
import type { AiClient, BatchRequest, BatchResultLine, BetaMessage, MessageBatch } from '../../src/services/claude/client';
import type { BetaCreateParams } from '../../src/services/recall/prompts';
import { GRADE_SCHEMA, QUESTIONS_SCHEMA } from '../../src/services/recall/output';
import { PRACTICE_NOTE_SCHEMA, SOLUTION_PLACEHOLDER } from '../../src/services/practice/output';
import { COACH_SCHEMA } from '../../src/services/coach/output';
import { LOCK_SCHEMA, LOCK_SCHEMA_TIMED } from '../../src/services/buddy/think';

export interface FakeUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
}

export const DEFAULT_USAGE: FakeUsage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 };
/** DEFAULT_USAGE on claude-opus-5-5: (1000·$4 + 500·$20 + 2000·$5) / 1M. Half in a batch. */
export const DEFAULT_COST_USD = 0.024;

let messageCount = 0;

/** A response whose text is `output` (JSON-encoded unless it is a string). */
export function fakeMessage(output: unknown, opts: { model?: string; stopReason?: string; usage?: Partial<FakeUsage> } = {}): BetaMessage {
    messageCount += 1;
    return {
        id: `msg_test_${messageCount}`,
        type: 'message',
        role: 'assistant',
        model: opts.model ?? 'claude-opus-5-5',
        content: [
            { type: 'thinking', thinking: '', signature: 'fake' },
            { type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output), citations: null },
        ],
        stop_reason: opts.stopReason ?? 'end_turn',
        stop_sequence: null,
        stop_details: null,
        container: null,
        context_management: null,
        usage: {
            ...DEFAULT_USAGE,
            ...opts.usage,
            cache_creation: null,
            iterations: null,
            server_tool_use: null,
            service_tier: 'standard',
            inference_geo: null,
            output_tokens_details: null,
            fallback_credit: null,
            speed: null,
        },
    } as unknown as BetaMessage;
}

const QUESTIONS = [
    {
        kind: 'recall',
        prompt: 'In what order does a monotonic stack keep its elements?',
        answerKey: 'Decreasing order from bottom to top: a push first pops every smaller element.',
        sourceQuote: 'A monotonic stack keeps its elements in decreasing order.',
    },
    {
        kind: 'pattern',
        prompt: 'Which pattern finds the next greater element for every index in one pass?',
        answerKey: 'A monotonic decreasing stack of indices.',
        sourceQuote: 'Use a monotonic stack to find the next greater element.',
    },
    {
        kind: 'complexity',
        prompt: 'Why is the monotonic stack solution O(n) despite its inner while loop?',
        answerKey: 'Each element is pushed once and popped at most once, so the total work is linear.',
        sourceQuote: 'Every element is pushed and popped at most once, so it runs in O(n).',
    },
    {
        kind: 'edge',
        prompt: 'What answer do indices that are still on the stack at the end get?',
        answerKey: '-1: no greater element exists to their right.',
        sourceQuote: 'Indices left on the stack get -1.',
    },
    {
        kind: 'apply',
        prompt: 'For daily temperatures, how would you find how many days until a warmer one?',
        answerKey: 'Keep a decreasing stack of indices; when a warmer day pops an index, the answer is the index difference.',
        sourceQuote: 'Use a monotonic stack to find the next greater element.',
    },
];

/** A valid question-writing output with `n` (1–5) questions. */
export function sampleQuestions(n = 4) {
    return { questions: QUESTIONS.slice(0, n) };
}

export const gradeOutput = (grade: 'strong' | 'partial' | 'weak', feedback = '', quote = '') => ({ grade, feedback, quote });

/** A practice note as Claude writes it: the seven sections, the placeholder where the code goes. */
export const SAMPLE_NOTE_MARKDOWN = `## Problem

Given an array of integers and a target, return the indices of the two numbers that add up to the target. Exactly one answer exists.

https://leetcode.com/problems/two-sum/

## Approach

> [!TIP]
> The partner each number needs is target minus it: keep a map from value to index and look the partner up in O(1).

1. Walk the array once.
2. If target - x is in the map, return both indices.
3. Otherwise store x with its index.

## Complexity

- Time: O(n) — one pass with O(1) lookups.
- Space: O(n) — the map holds up to n values.

## Code

\`\`\`python
${SOLUTION_PLACEHOLDER}
\`\`\`

### A cleaner version

Checks the partner before storing, so a number never pairs with itself.

\`\`\`python
def two_sum(nums, target):
    seen = {}
    for i, x in enumerate(nums):
        if target - x in seen:
            return [seen[target - x], i]
        seen[x] = i
\`\`\`

## My mistakes

- I stored each number before looking up its partner, so [3, 3] with target 6 paired an index with itself.

## Recall check

<details>
<summary>Why look up the partner before storing the current number?</summary>

So a number is never paired with itself.

</details>

<details>
<summary>What does the map hold?</summary>

Each value seen so far, mapped to its index.

</details>

## Similar problems

- **3Sum**: sort, then two pointers around each fixed number.
- **Two Sum II**: a sorted input turns the map into two pointers.
- **Subarray Sum Equals K**: a map of prefix sums finds the partner sum.`;

/** A valid practice-note output (title + Markdown). */
export const samplePracticeNote = (over: { title?: string; markdown?: string } = {}) => ({ title: 'Two Sum', markdown: SAMPLE_NOTE_MARKDOWN, ...over });

/** A valid weekly-coach output. */
export const sampleCoach = (over: Partial<Record<'strong' | 'slipping' | 'fix' | 'deadline', string>> & { focus?: string[] } = {}) => ({
    // Numbers only from the coach test's week (the coach checks every number against its evidence).
    strong: 'You did 1 of 2 DSA reviews on time and answered 1 recall question strong.',
    slipping: 'Dijkstra came back weak, and 1 review was missed.',
    fix: 'Clear due reviews first thing each weekday morning, before anything new.',
    deadline: 'With 1 of 2 milestones done, the deadline is realistic at a steady pace.',
    focus: ['Re-test Dijkstra with negative edges', 'Clear the missed DSA review', 'Draft the first mock interview plan'],
    ...over,
});

export function succeededLine(customId: string, message: BetaMessage = fakeMessage(sampleQuestions())): BatchResultLine {
    return { custom_id: customId, result: { type: 'succeeded', message } } as unknown as BatchResultLine;
}

export function erroredLine(customId: string): BatchResultLine {
    return {
        custom_id: customId,
        result: { type: 'errored', error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: null } },
    } as unknown as BatchResultLine;
}

interface FakeBatch {
    requests: BatchRequest[];
    ended: boolean;
    canceled: boolean;
    results: BatchResultLine[];
}

function batchObject(id: string, status: MessageBatch['processing_status'], count: number): MessageBatch {
    return {
        id,
        type: 'message_batch',
        processing_status: status,
        request_counts: { processing: status === 'ended' ? 0 : count, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        ended_at: status === 'ended' ? new Date().toISOString() : null,
        archived_at: null,
        cancel_initiated_at: null,
        results_url: status === 'ended' ? `https://example.invalid/${id}/results` : null,
    };
}

export class FakeClaude implements AiClient {
    calls: BetaCreateParams[] = [];
    readonly batches = new Map<string, FakeBatch>();
    private queue: Array<BetaMessage | Error> = [];
    private batchCount = 0;

    /** Answers for the next createMessage calls, in order (an Error is thrown). */
    push(...responses: Array<BetaMessage | Error>): void {
        this.queue.push(...responses);
    }

    reset(): void {
        this.calls = [];
        this.queue = [];
        this.batches.clear();
    }

    /** Ends a batch with these results (default: every request succeeds with sample questions). */
    endBatch(batchId: string, results?: BatchResultLine[]): void {
        const b = this.batches.get(batchId);
        if (!b) throw new Error(`FakeClaude: no batch ${batchId}`);
        b.ended = true;
        b.results = results ?? b.requests.map((r) => succeededLine(r.custom_id));
    }

    async createMessage(params: BetaCreateParams): Promise<BetaMessage> {
        this.calls.push(params);
        const next = this.queue.shift();
        if (next instanceof Error) throw next;
        if (next) return next;
        const schema = params.output_config?.format?.schema;
        if (schema === QUESTIONS_SCHEMA) return fakeMessage(sampleQuestions());
        if (schema === GRADE_SCHEMA) return fakeMessage(gradeOutput('strong'));
        if (schema === PRACTICE_NOTE_SCHEMA) return fakeMessage(samplePracticeNote());
        if (schema === COACH_SCHEMA) return fakeMessage(sampleCoach());
        // The buddy's lock check (it runs for every person since stage 3): nothing reveals a private thing.
        if (schema === LOCK_SCHEMA) return fakeMessage({ lines: ['morning', 'afternoon', 'evening'].map((slot) => ({ slot, reveals: false })), note: false, insight: false }, { model: 'claude-sonnet-5-5' });
        // Stage 7: timed lines go to the lock check by number.
        if (schema === LOCK_SCHEMA_TIMED) return fakeMessage({ lines: [0, 1, 2, 3].map((i) => ({ i, reveals: false })), note: false, insight: false }, { model: 'claude-sonnet-5-5' });
        throw new Error('FakeClaude: unexpected request');
    }

    async createBatch(requests: BatchRequest[]): Promise<MessageBatch> {
        this.batchCount += 1;
        const id = `msgbatch_test${this.batchCount}`;
        this.batches.set(id, { requests, ended: false, canceled: false, results: [] });
        return batchObject(id, 'in_progress', requests.length);
    }

    async retrieveBatch(batchId: string): Promise<MessageBatch> {
        const b = this.batches.get(batchId);
        if (!b) throw new Error(`FakeClaude: no batch ${batchId}`);
        return batchObject(batchId, b.ended ? 'ended' : 'in_progress', b.requests.length);
    }

    async batchResults(batchId: string): Promise<AsyncIterable<BatchResultLine>> {
        const b = this.batches.get(batchId);
        if (!b?.ended) throw new Error(`FakeClaude: batch ${batchId} has not ended`);
        const lines = [...b.results];
        return (async function* () {
            yield* lines;
        })();
    }

    async cancelBatch(batchId: string): Promise<MessageBatch> {
        const b = this.batches.get(batchId);
        if (!b) throw new Error(`FakeClaude: no batch ${batchId}`);
        b.canceled = true;
        return batchObject(batchId, 'canceling', b.requests.length);
    }
}
