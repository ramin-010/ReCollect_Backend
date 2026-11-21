// The `@ai` task line (LOOP_COMPLETE_SPEC 4.1, ECOSYSTEM_PLAN change 11: one AI system). A typed line
// becomes a task's fields through the Claude client on Haiku 5.5, with a structured output checked by
// zod, metered (`task_parse`) under the same monthly cap. Any failure (no key, the cap, an API error,
// an answer that doesn't fit) keeps the line as a plain task: the person never loses what they typed.
// Replaces the old Groq / Gemini / Cohere chain.
import { z } from 'zod';
import { callClaude, isAiConfigured } from '../claude/client';
import { assertUnderCap, recordAiUsage } from '../claude/usage.service';
import { parseJson, responseText } from '../recall/output';
import type { BetaCreateParams } from '../recall/prompts';
import { calendarDateIn, DEFAULT_TIME_ZONE } from '../../utils/timezone';

export const TASK_AI_DEFAULT_MODEL = 'claude-haiku-5-5';
export const taskAiModel = (): string => process.env['TASK_AI_MODEL']?.trim() || TASK_AI_DEFAULT_MODEL;

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

/** The JSON schema the API holds the answer to (every field present; '' when there is nothing). */
export const TASK_LINE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'description', 'priority', 'dueDate', 'tags', 'assignees'],
    properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: [...PRIORITIES] },
        dueDate: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        assignees: { type: 'array', items: { type: 'string' } },
    },
};

const zLine = z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000),
    priority: z.enum(PRIORITIES),
    dueDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'dueDate is YYYY-MM-DD or empty'),
    tags: z.array(z.string().trim().min(1).max(40)).max(5),
    assignees: z.array(z.string().trim()).max(20),
});

export const TASK_LINE_SYSTEM = `You turn one line a person typed into the fields of a task, in Recollect (a learning and productivity app). Answer with the JSON the schema asks for.
- title: what to do, starting with a verb when it reads naturally, 4 to 14 words. If the line is already a good title, keep it.
- description: short HTML (<p>, <ul><li>, <strong>) that adds what the line implies: steps, the why, a link it names. Empty ("") when there is nothing worth adding. Never invent facts, people or numbers. Write <strong>@name</strong> only for a person the line @-mentions.
- priority: "normal" unless the line says otherwise ("urgent", "ASAP", "today" → "high" or "urgent"; "someday", "no rush" → "low").
- dueDate: YYYY-MM-DD from what the line says ("tomorrow", "Friday", "in 3 days"), counted from TODAY; "" when it names no day.
- tags: up to 3, chosen from AVAILABLE_TAGS when one fits; a new one only when clearly useful; [] otherwise.
- assignees: emails, only from WORKSPACE_MEMBERS (always include the PRE-SELECTED ones); [] for a personal task.`;

export interface TaskLineInput {
    prompt: string;
    workspaceMembers?: Array<{ name: string; email: string }>;
    availableTags?: string[];
    preSelectedAssignees?: Array<{ name: string; email: string }>;
}

export interface TaskLineOutput {
    title: string;
    description: string;
    priority: (typeof PRIORITIES)[number];
    dueDate: string | null;
    tags: string[];
    assignees: string[];
    /** 'claude' when the model wrote it; 'plain' when the line was kept as it was. */
    provider: 'claude' | 'plain';
}

export function plainTaskLine(prompt: string): TaskLineOutput {
    return { title: prompt.replace(/\s+/g, ' ').trim().slice(0, 120), description: '', priority: 'normal', dueDate: null, tags: [], assignees: [], provider: 'plain' };
}

export function taskLineRequest(input: TaskLineInput, today: string): BetaCreateParams {
    const members = input.workspaceMembers ?? [];
    const context = [
        `TODAY: ${today}`,
        members.length ? `WORKSPACE_MEMBERS:\n${members.map((m) => `- ${m.name} <${m.email}>`).join('\n')}` : 'WORKSPACE_MEMBERS: none (a personal task)',
        input.availableTags?.length ? `AVAILABLE_TAGS: ${input.availableTags.slice(0, 50).join(', ')}` : 'AVAILABLE_TAGS: none',
        input.preSelectedAssignees?.length ? `PRE-SELECTED: ${input.preSelectedAssignees.map((a) => a.email).join(', ')}` : null,
        `LINE: ${input.prompt.trim().slice(0, 1000)}`,
    ]
        .filter(Boolean)
        .join('\n');
    return {
        model: taskAiModel(),
        max_tokens: 1500,
        output_config: { format: { type: 'json_schema', schema: TASK_LINE_SCHEMA } },
        system: [{ type: 'text', text: TASK_LINE_SYSTEM }],
        messages: [{ role: 'user', content: [{ type: 'text', text: context }] }],
    } as BetaCreateParams;
}

/** The fields of a typed task line; never throws for the model's sake (see the file header). */
export async function generateTaskLine(userId: string, input: TaskLineInput, now: Date = new Date()): Promise<TaskLineOutput> {
    if (!isAiConfigured()) return plainTaskLine(input.prompt);
    try {
        await assertUnderCap(userId, now);
    } catch {
        return plainTaskLine(input.prompt);
    }
    try {
        const message = await callClaude(userId, taskLineRequest(input, calendarDateIn(now, DEFAULT_TIME_ZONE)), 'task line');
        await recordAiUsage(userId, 'task_parse', message);
        const out = zLine.parse(parseJson(responseText(message)));
        const allowed = new Set([...(input.workspaceMembers ?? []), ...(input.preSelectedAssignees ?? [])].map((m) => m.email.toLowerCase()));
        return {
            title: out.title,
            description: out.description.trim(),
            priority: out.priority,
            dueDate: out.dueDate || null,
            tags: [...new Set(out.tags)].slice(0, 3),
            assignees: out.assignees.filter((e) => allowed.has(e.toLowerCase())),
            provider: 'claude',
        };
    } catch (err) {
        console.warn(`[task-ai] the line was kept as a plain task: ${err instanceof Error ? err.message : String(err)}`);
        return plainTaskLine(input.prompt);
    }
}
