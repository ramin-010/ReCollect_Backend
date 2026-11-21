// The night's and the pulse's schemas stay under the API's grammar limit. The API compiles a structured-output
// schema into a grammar whose size is limited; the night's full schema with the loop on (its fields, the buddy's
// own reminders and the Sunday note) was refused on 11-18 ("The compiled grammar is too large"), found by the
// week's simulation. Measured against the API that day: weight 76 refused (Opus 5.5 and Sonnet 5.5), 70 accepted (Opus 5.5).
// A schema may grow past MAX only after scripts/sim/schema-probe.ts shows the heavier one accepted by the API.
import { describe, expect, it } from 'vitest';
import { NIGHT_SCHEMA, nightLoopSchema } from '../../../src/services/buddy/think';
import { loopSchema } from '../../../src/services/buddy/nightLoop';
import { PULSE_SCHEMA } from '../../../src/services/buddy/pulse';

const MAX = 70;

/** Properties, arrays and objects, counted through the whole schema: what grew the grammar past the limit. */
function weight(schema: unknown): number {
    let n = 0;
    const walk = (s: unknown) => {
        if (!s || typeof s !== 'object') return;
        if (Array.isArray(s)) return s.forEach(walk);
        const o = s as Record<string, unknown>;
        if (o['type'] === 'object' || o['properties']) n += 1 + Object.keys((o['properties'] as object) ?? {}).length;
        if (o['type'] === 'array') n += 1;
        for (const v of Object.values(o)) walk(v);
    };
    walk(schema);
    return n;
}

describe("the buddy's schemas under the API's grammar limit", () => {
    it('measures the refused schema as too heavy (the guard itself)', () => {
        expect(weight(loopSchema(NIGHT_SCHEMA, { threadOps: true }))).toBe(76);
    });
    it('a weekday night with the loop on: its own reminders, no Sunday note', () => {
        const s = nightLoopSchema(false) as { properties: Record<string, unknown> };
        expect(Object.keys(s.properties)).toContain('reminders');
        expect(Object.keys(s.properties)).not.toContain('weekly');
        expect(weight(s)).toBeLessThanOrEqual(MAX);
    });
    it('a Sunday night with the loop on: the week\'s note, no reminders of its own', () => {
        const s = nightLoopSchema(true) as { properties: Record<string, unknown> };
        expect(Object.keys(s.properties)).toContain('weekly');
        expect(Object.keys(s.properties)).not.toContain('reminders');
        expect(weight(s)).toBeLessThanOrEqual(MAX);
    });
    it('the loop off, and a pulse with the loop on', () => {
        expect(weight(NIGHT_SCHEMA)).toBeLessThanOrEqual(MAX);
        expect(weight(loopSchema(PULSE_SCHEMA, { threadOps: false }))).toBeLessThanOrEqual(MAX);
    });
});
