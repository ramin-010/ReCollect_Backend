// The remote door's trace since a time: node trace-since.cjs <ISO from> [ISO to] [--full]
// Each call: time, tool, arguments, and the start of the record's answer (the whole answer with --full).
const fs = require('node:fs');
const path = require('node:path');

const [from, toArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const full = process.argv.includes('--full');
const to = toArg || '9999';
const file = path.join(__dirname, '..', '..', '..', '.devdb', 'connector', 'trace.jsonl');
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const t = JSON.parse(line);
    if (t.at < from || t.at > to) continue;
    const answer = (t.answer ?? '(no answer kept)').replace(/\s+/g, ' ');
    console.log(`${t.at.slice(11, 19)} ${t.tool} ${JSON.stringify(t.args)}\n    -> ${full ? answer : answer.slice(0, 400)}`);
}
