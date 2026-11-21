// Which of the buddy's request schemas are big, and why (the night with the loop on was refused 11-18:
// "The compiled grammar is too large"). Prints each schema's size and the features that grow a grammar.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NIGHT_SCHEMA, LOCK_SCHEMA, LOCK_SCHEMA_TIMED } from '../../src/services/buddy/think';
import { loopSchema } from '../../src/services/buddy/nightLoop';
import { PULSE_SCHEMA } from '../../src/services/buddy/pulse';
import { GATE_SCHEMA_LOOP } from '../../src/services/buddy/digest';

function features(schema: any) {
    const f = { props: 0, optional: 0, enums: 0, anyOf: 0, patterns: 0, lengths: 0, arrays: 0, objects: 0 };
    const walk = (s: any) => {
        if (!s || typeof s !== 'object') return;
        if (Array.isArray(s)) return s.forEach(walk);
        if (s.type === 'object' || s.properties) {
            f.objects++;
            const props = Object.keys(s.properties ?? {});
            f.props += props.length;
            f.optional += props.filter((p) => !(s.required ?? []).includes(p)).length;
        }
        if (s.type === 'array') f.arrays++;
        if (s.enum) f.enums++;
        if (s.anyOf || s.oneOf) f.anyOf++;
        if (s.pattern) f.patterns++;
        if (s.maxLength || s.minLength || s.maxItems || s.minItems) f.lengths++;
        for (const v of Object.values(s)) walk(v);
    };
    walk(schema);
    return f;
}

const show = (name: string, s: any) => console.log(name.padEnd(28), String(JSON.stringify(s).length).padStart(6), 'chars', JSON.stringify(features(s)));
show('NIGHT_SCHEMA', NIGHT_SCHEMA);
show('night, the loop on', loopSchema(NIGHT_SCHEMA, { threadOps: true }));
show('PULSE_SCHEMA', PULSE_SCHEMA);
show('pulse, the loop on', loopSchema(PULSE_SCHEMA, { threadOps: false }));
show('LOCK_SCHEMA', LOCK_SCHEMA);
show('LOCK_SCHEMA_TIMED', LOCK_SCHEMA_TIMED);
show('GATE_SCHEMA_LOOP', GATE_SCHEMA_LOOP);
if (process.argv.includes('--print')) console.log(JSON.stringify(loopSchema(NIGHT_SCHEMA, { threadOps: true }), null, 1));
