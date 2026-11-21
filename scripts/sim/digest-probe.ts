// Stage 18: does the API still take the digest's schema with the `today` field ("The compiled grammar is too large" is
// a refusal and costs nothing; an answer costs about a fifth of a cent)? One trivial chat through the real request.
//   node node_modules/ts-node/dist/bin.js --transpile-only scripts/sim/digest-probe.ts
import 'dotenv/config';
import { getAiClient } from '../../src/services/claude/client';
import { digestLoopRequest, digestLoopText, numberedChat } from '../../src/services/buddy/digest';
import { parseJson, responseText } from '../../src/services/recall/output';
import { costOfCall } from '../../src/services/claude/pricing';

async function main() {
    const at = new Date('2026-11-20T13:10:00Z').toISOString();
    const body = digestLoopText({
        chat: numberedChat([{ at, text: 'Tonight I am finishing the 3Sum problem, starting at 9.' }], [0], { today: '2026-11-20' as never, tz: 'Asia/Kolkata' }),
        known: [],
        threads: 'none yet',
        events: 'none',
        asks: 'none',
        saved: [],
        tasks: [],
        weekday: 'Friday',
        today: '2026-11-20',
        source: 'their chat with the buddy',
    });
    const message = await getAiClient().createMessage(digestLoopRequest(body) as never);
    const out = parseJson(responseText(message)) as { today?: boolean };
    console.log(`accepted · today=${String(out.today)} · $${costOfCall(message.usage as never, message.model).costUsd.toFixed(4)}`);
}

main().catch((err) => {
    console.error(`refused or failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
