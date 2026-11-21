// Which part of the night's schema makes the API refuse it ("The compiled grammar is too large")? Sends the
// schema with a trivial prompt (a refusal costs nothing; an answer costs about a cent), variant by variant.
/* eslint-disable @typescript-eslint/no-explicit-any */
import 'dotenv/config';
import { NIGHT_SCHEMA } from '../../src/services/buddy/think';
import { loopSchema } from '../../src/services/buddy/nightLoop';
import { PULSE_SCHEMA } from '../../src/services/buddy/pulse';
import { getAiClient } from '../../src/services/claude/client';

const clone = (x: any) => JSON.parse(JSON.stringify(x));
const without = (s: any, ...keys: string[]) => {
    const c = clone(s);
    for (const k of keys) {
        delete c.properties[k];
        c.required = c.required.filter((r: string) => r !== k);
    }
    return c;
};

/** The same schema with these properties' enums dropped (plain strings), wherever they are. */
function plainEnums(s: any, names: string[]): any {
    const c = clone(s);
    const walk = (x: any) => {
        if (!x || typeof x !== 'object') return;
        for (const [k, v] of Object.entries(x.properties ?? {}) as Array<[string, any]>) {
            if (names.includes(k) && v.enum) delete v.enum;
            walk(v);
        }
        if (x.items) walk(x.items);
    };
    walk(c);
    return c;
}

async function probe(name: string, schema: any, model: string) {
    const client = getAiClient();
    try {
        const r = await client.createMessage({
            model,
            max_tokens: 3000,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'low', format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Output the emptiest valid answer: empty arrays, empty strings, false.' }] }],
        } as any);
        console.log(`OK    ${name} (${model}): ${r.usage.input_tokens} in, ${r.usage.output_tokens} out`);
    } catch (e: any) {
        console.log(`FAIL  ${name} (${model}): ${String(e.message ?? e).slice(0, 160)}`);
    }
}

(async () => {
    const which = process.argv[2] ?? 'all';
    const full = loopSchema(NIGHT_SCHEMA, { threadOps: true });
    const variants: Array<[string, any, string]> = [
        ['night, the loop on (as sent)', full, 'claude-opus-5-5'],
        ['night, the loop on, on Sonnet', full, 'claude-sonnet-5-5'],
        ['without reminders', without(full, 'reminders'), 'claude-opus-5-5'],
        ['without reminders, threadOps', without(full, 'reminders', 'threadOps'), 'claude-opus-5-5'],
        ['without weekly', without(full, 'weekly'), 'claude-opus-5-5'],
        ['without memory', without(full, 'memory'), 'claude-opus-5-5'],
        ['without asks', without(full, 'asks'), 'claude-opus-5-5'],
        ['NIGHT_SCHEMA (the loop off)', NIGHT_SCHEMA, 'claude-opus-5-5'],
        ['pulse, the loop on', loopSchema(PULSE_SCHEMA, { threadOps: false }), 'claude-sonnet-5-5'],
        ['enums as strings', plainEnums(full, ['kind', 'form']), 'claude-opus-5-5'],
        ['all enums as strings', plainEnums(full, ['kind', 'form', 'op', 'meaning']), 'claude-opus-5-5'],
    ];
    for (const [name, schema, model] of variants) if (which === 'all' || name.startsWith(which)) await probe(name, schema, model);
})();
