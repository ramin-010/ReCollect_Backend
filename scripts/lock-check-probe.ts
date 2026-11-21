// One real lock check (Haiku 5.5) on invented lines and a note, to see its answer, stop reason and
// tokens (a fraction of a cent). For diagnosing the buddy's lock check, never his data.
//   npx ts-node --transpile-only scripts/lock-check-probe.ts
import { getAiClient } from '../src/services/claude/client';
import { lockRequest, type Line } from '../src/services/buddy/think';

const lines: Line[] = [
    { slot: 'morning', text: 'Morning slot test: 3 reviews, about 24 minutes, before work.', form: 'plain', lockOk: true, sourceId: null },
    { slot: 'afternoon', text: 'From your notes: list.insert(0, x) is O(n); dict get/set is O(1) average.', form: 'plain', lockOk: true, sourceId: null },
];
const note = 'You said mornings work better for you this week, but every session I can see started in the evening. Worth knowing which.';

(async () => {
    const req = lockRequest(lines, ['Worried the paid course is too expensive this month'], note);
    const m = await getAiClient().createMessage(req); // a probe of the prompt itself: no account, the server's key
    console.log('model', m.model, 'stop', m.stop_reason, 'usage', JSON.stringify(m.usage).slice(0, 200));
    console.log('content types', m.content.map((c) => c.type).join(','));
    console.log('text', m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('').slice(0, 400));
})().catch((e) => console.log('FAIL', e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
