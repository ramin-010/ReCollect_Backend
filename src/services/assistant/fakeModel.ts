// A stand-in for Claude, only for QA of the Ask AI page (MANAGER_AND_DOCS_PLAN stage 4 part 2, step
// 4): no model is called and nothing is spent. It is on only outside production and only for the
// accounts ASSISTANT_FAKE names (comma-separated emails, or "all"). It picks REAL tools by keywords
// in his message, so the catalogue, the edit log, Undo and "Do it" all run for real; only the
// model's choices and words are scripted.
import type Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../db/prisma';
import type { AiClient, BetaMessage } from '../claude/client';
import type { BetaCreateParams } from '../recall/prompts';

/** Each fake call waits this long, so the page's working state can be seen. */
const DELAY_MS = 700;

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Block = { type: string; [key: string]: unknown };

/** The fake for this user when ASSISTANT_FAKE names them; else null (the real client is used). */
export async function fakeClientFor(userId: string): Promise<AiClient | null> {
    const flag = process.env['ASSISTANT_FAKE']?.trim().toLowerCase();
    if (!flag || process.env.NODE_ENV === 'production') return null;
    if (flag !== 'all') {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
        const emails = flag.split(',').map((s) => s.trim());
        if (!user || !emails.includes(user.email.toLowerCase())) return null;
    }
    return fakeClient;
}

let n = 0;
function reply(content: Block[], stop: 'tool_use' | 'end_turn'): BetaMessage {
    n += 1;
    return {
        id: `msg_fake_${n}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content,
        stop_reason: stop,
        stop_sequence: null,
        // About what a real cached call reads and writes (so the page's cost line looks real).
        usage: { input_tokens: 900, output_tokens: 150, cache_read_input_tokens: 16_000, cache_creation_input_tokens: 0 },
    } as unknown as BetaMessage;
}
const answer = (text: string) => reply([{ type: 'text', text }], 'end_turn');
const tools = (...calls: Array<[string, Record<string, unknown>]>) =>
    reply(
        calls.map(([name, input]) => ({ type: 'tool_use', id: `toolu_fake_${++n}`, name, input })),
        'tool_use'
    );

const HELP = [
    'This is the **fake model** for testing the page: no AI was called and nothing was spent.',
    '',
    'Try one of these:',
    '- "make a note on heaps" (a change you can undo)',
    '- "add a task to book the mock" (another change)',
    '- "empty my trash" (an action that waits for your tap)',
    '- "what is due today?" or "how is my week?" (reading)',
    '- "break a tool" (a tool that fails) or "show a long answer"',
].join('\n');

const LONG = [
    '## A long answer',
    '',
    'Here is a plan for the week, written to check how answers wrap and read. A long line with no breaks: the quick brown fox jumps over the lazy dog while the backlog of revisions quietly grows and the week keeps moving.',
    '',
    '1. **Monday:** heaps and priority queues, then two practice problems.',
    '2. **Wednesday:** caching (`write-through` vs `write-back`), with a diagram.',
    '3. **Friday:** a mock interview, then the notes it leaves.',
    '',
    'Some code:',
    '',
    '```ts',
    'const kSmallest = (xs: number[], k: number) => xs.sort((a, b) => a - b).slice(0, k);',
    '```',
    '',
    '> A quote: numbers come from tools, never from memory.',
    '',
    'And a link to [your docs](/docs).',
].join('\n');

/** "make a note on heaps" -> "Heaps". */
function titleFrom(text: string, fallback: string): string {
    const m = text.match(/\b(?:on|about|to|called)\s+(.+?)[.?!]*$/i);
    const raw = (m?.[1] ?? '').trim();
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1, 80) : fallback;
}

/** Asked from inside a doc: the doc's id, his focus and the focus's first line, read back from the system text. */
interface DocAsk {
    docId: string;
    focus: string[];
    emptyLine: boolean;
    firstLine: string;
}

function docAskOf(system: unknown): DocAsk | null {
    const text = Array.isArray(system) ? system.map((b) => (b as { text?: string }).text ?? '').join('\n') : typeof system === 'string' ? system : '';
    const docId = /\(docId ([A-Za-z0-9_-]+)\), as it is now/.exec(text)?.[1];
    if (!docId) return null;
    const focusLine = text.split('\n').find((l) => l.startsWith('His focus:')) ?? '';
    const focus = [...focusLine.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!);
    const marked = text.split('\n').find((l) => focus[0] && l.trimStart().startsWith(`» [${focus[0]}] `));
    return { docId, focus, emptyLine: /empty line/.test(focusLine), firstLine: marked ? marked.trimStart().slice(`» [${focus[0]}] `.length) : '' };
}

const FAKE_SECTION = [
    '## A section from the fake model',
    '',
    'The fake model wrote this to test Ask AI in a doc: no AI was called. Undo in the box takes it back.',
    '',
    '- It went in through insert_blocks, like any agent write.',
    '- It is one change in the edit log.',
].join('\n');

const FAKE_DIAGRAM = ['```mermaid', 'flowchart LR', '  A[Request] --> B{Token left?}', '  B -->|yes| C[Serve it]', '  B -->|no| D[Wait or refuse]', '```'].join('\n');

/** "## Token bucket refills" → "## Token bucket": the block's marker kept, its words cut to about half. */
function shorter(markdown: string): string {
    const m = /^(#{1,3} |- \[[ x]\] |- |\d+\. |> )?(.*)$/s.exec(markdown.split('\n')[0] ?? '') ?? [];
    const words = (m[2] ?? '').split(/\s+/).filter(Boolean);
    const kept = words.slice(0, Math.max(2, Math.ceil(words.length / 2))).join(' ').replace(/[,;:]$/, '');
    return `${m[1] ?? ''}${kept}${/[.!?]$/.test(kept) ? '' : '.'}`;
}

/** The fake inside a doc: real block tools on his focus, picked by keywords. */
function docStep(text: string, ask: DocAsk): BetaMessage {
    const t = text.toLowerCase();
    const [first] = ask.focus;
    const last = ask.focus[ask.focus.length - 1];
    if (/\?\s*$|\b(explain|what|why|how)\b/.test(t) && !/\b(write|add)\b/.test(t)) {
        return answer(ask.firstLine ? `The fake model read your line: “${ask.firstLine.slice(0, 120)}”. A real answer would explain it here; nothing in the doc changed.` : 'The fake model read the doc. A real answer would go here; nothing in the doc changed.');
    }
    if (/\btable\b/.test(t) && ask.focus.length > 1 && last) {
        const table = ['| Point | Note |', '| --- | --- |', '| One | from the fake model |', '| Two | Undo takes both steps back |'].join('\n');
        return tools(['insert_blocks', { docId: ask.docId, markdown: table, where: { after: last } }], ['delete_blocks', { docId: ask.docId, ids: ask.focus }]);
    }
    if (/\b(shorter|shorten|simplif|improve|fix|grammar|rewrite|tighten)\w*/.test(t) && first && ask.firstLine && !ask.emptyLine) {
        return tools(['update_block', { docId: ask.docId, blockId: first, markdown: /\bshort/.test(t) ? shorter(ask.firstLine) : `${ask.firstLine.replace(/[.!?]?$/, '')}, said more plainly.` }]);
    }
    const markdown = /\bdiagram\b/.test(t) ? FAKE_DIAGRAM : /\bsummar/.test(t) ? '> [!NOTE]\n> A summary from the fake model: the doc in one line.' : FAKE_SECTION;
    const where = !first ? { at: 'end' } : ask.emptyLine ? { before: first } : { after: last };
    return tools(['insert_blocks', { docId: ask.docId, markdown, where }]);
}

function firstStep(text: string, system?: unknown): BetaMessage {
    const ask = docAskOf(system);
    if (ask) return docStep(text, ask);
    const t = text.toLowerCase();
    if (/\b(note|doc)\b/.test(t) && /\b(make|write|create|new)\b/.test(t)) {
        const title = titleFrom(text, 'A note from the fake model');
        return tools(['create_doc', { title, markdown: `A note the fake model made for testing the Ask AI page.\n\n- It was made through the real tools.\n- Undo takes it back.` }]);
    }
    if (/\bremind\b/.test(t)) return tools(['set_reminder', { title: titleFrom(text, 'A reminder from the fake model'), at: '23:59' }]);
    if (/\b(spread|backlog)\b/.test(t)) return tools(['spread_backlog', { reason: 'He asked in Ask AI.' }]);
    if (/\btask\b/.test(t) && /\badd\b/.test(t)) return tools(['add_task', { title: titleFrom(text, 'A task from the fake model') }]);
    if (/\btrash\b/.test(t) && /\bempty\b/.test(t)) return tools(['empty_trash', { reason: 'He asked in Ask AI.' }]);
    if (/\b(break|fail)\b/.test(t)) return tools(['read_doc', { docId: 'doc-that-does-not-exist' }]);
    if (/\bweek\b/.test(t)) return tools(['get_week', {}], ['list_sessions', {}]);
    if (/\b(due|today)\b/.test(t)) return tools(['list_due', {}]);
    if (/\bloop\b/.test(t)) return tools(['list_subjects', {}]);
    if (/\blong\b/.test(t)) return answer(LONG);
    return answer(HELP);
}

const firstLines = (text: string, max: number) =>
    text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('Undo:'))
        .slice(0, max);

/** After the tools ran: an answer from their results (or, for "loop", another tool). */
function afterTools(messages: MessageParam[]): BetaMessage {
    const asked = messages.find((m) => m.role === 'user' && typeof m.content === 'string');
    if (asked && /\bloop\b/i.test(asked.content as string)) return tools(['list_subjects', {}]);
    const calls = ((messages[messages.length - 2]?.content ?? []) as Block[]).filter((b) => b.type === 'tool_use');
    const results = (messages[messages.length - 1]?.content ?? []) as Block[];
    const parts = calls.map((call) => {
        const res = results.find((r) => r['tool_use_id'] === call['id']);
        const text = typeof res?.['content'] === 'string' ? (res['content'] as string) : '';
        const input = (call['input'] ?? {}) as Record<string, unknown>;
        if (res?.['is_error']) return `That didn't work: ${firstLines(text, 1)[0] ?? 'the tool failed'}. Nothing was changed.`;
        switch (call['name']) {
            case 'create_doc':
                return `Made the note **${String(input['title'])}**. It's in Docs, and Undo above takes it back.`;
            case 'add_task':
                return `Added the task **${String(input['title'])}**.`;
            case 'empty_trash':
                return 'I asked to empty the trash. Nothing is deleted until you tap **Do it** on the card above (it is under Suggested on Home too).';
            case 'insert_blocks':
                return `Added ${/Inserted (\d+ blocks?)/.exec(text)?.[1] ?? 'a few blocks'} (the fake model).`;
            case 'update_block':
                return 'Changed the block (the fake model).';
            case 'delete_blocks':
                return 'Removed the old blocks.';
            default:
                return `From \`${String(call['name'])}\`:\n\n${firstLines(text, 6).map((l) => `- ${l}`).join('\n')}`;
        }
    });
    return answer(parts.join('\n\n') || 'Done.');
}

const fakeClient: AiClient = {
    async createMessage(params: BetaCreateParams): Promise<BetaMessage> {
        await new Promise((r) => setTimeout(r, DELAY_MS));
        const { messages, system } = params as unknown as { messages: MessageParam[]; system?: unknown };
        const last = messages[messages.length - 1];
        const afterToolResults = Array.isArray(last?.content) && (last.content as Block[]).some((b) => b.type === 'tool_result');
        return afterToolResults ? afterTools(messages) : firstStep(typeof last?.content === 'string' ? last.content : '', system);
    },
    createBatch: () => Promise.reject(new Error('The fake model has no batches')),
    retrieveBatch: () => Promise.reject(new Error('The fake model has no batches')),
    batchResults: () => Promise.reject(new Error('The fake model has no batches')),
    cancelBatch: () => Promise.reject(new Error('The fake model has no batches')),
};
