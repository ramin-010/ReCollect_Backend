// Mermaid's own parser on the server (mermaid 11.17.2, the version the browser draws with), run
// headless in a worker thread. ./check.ts uses it to check the ```mermaid blocks agents write.
//
// Why a worker: Mermaid parses synchronously, and some text makes its lexers backtrack for a long
// time (a flowchart line of 19,000 spaces runs for more than 4 s). On the server's own thread no
// timer could interrupt that and every request would wait behind it; a worker is just stopped.
// The worker also keeps the DOMPurify stand-in (below) out of the server's globals.
//
// One worker, started for the first Mermaid block (loading Mermaid takes about half a second),
// kept for the next ones, replaced after a timeout. Checks run one at a time, so a timeout always
// belongs to the block being checked. Mermaid is ESM-only and the backend CommonJS: the worker is
// an ES module of its own (a data: URL, which tsc, ts-node and vitest leave alone) that imports
// Mermaid by file URL.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

/**
 * What Mermaid made of a text. An error from a jison parser has `span`, the lines (Mermaid's
 * count) of the token it stopped at: a string that never closes runs from its quote to the end.
 * `unavailable`: the checker could not run (logged).
 */
export type MermaidParse =
    | { status: 'ok' }
    | { status: 'error'; message: string; span?: [number, number] }
    | { status: 'timeout' }
    | { status: 'unavailable' };

const LOAD_TIMEOUT_MS = 20_000;

// Runs in the worker. Mermaid sanitises label text with DOMPurify while it parses, and DOMPurify
// needs a DOM, which Node lacks. A check keeps nothing Mermaid parsed (the block is stored as
// written, and the browser sanitises what it draws), so pass-through methods on Mermaid's own
// DOMPurify instance are enough. The first parse (a flowchart label) proves they reached it.
const WORKER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads';
const purify = (await import(workerData.dompurify)).default;
Object.assign(purify, { sanitize: (text) => String(text), addHook() {}, removeHook() {}, removeHooks() {}, removeAllHooks() {} });
const mermaid = (await import(workerData.mermaid)).default;
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
await mermaid.parse('flowchart LR; a[A] --> b');
parentPort.on('message', async ({ id, text }) => {
    try {
        await mermaid.parse(text);
        parentPort.postMessage({ id });
    } catch (err) {
        const loc = err?.hash?.loc;
        const span = Number.isInteger(loc?.first_line) && Number.isInteger(loc?.last_line) ? [loc.first_line, loc.last_line] : undefined;
        parentPort.postMessage({ id, error: String(err?.message ?? err), span });
    }
});
parentPort.postMessage({ ready: true });
`;

interface Running {
    worker: Worker;
    /** Resolves once Mermaid is loaded; rejects if it never is. */
    ready: Promise<void>;
    pending: Map<number, (result: MermaidParse) => void>;
}

let running: Running | null = null;
let queue: Promise<unknown> = Promise.resolve();
let lastId = 0;

/**
 * Parses `text` with Mermaid. The parse itself may take `timeoutMs` (loading Mermaid first does
 * not count); after that the worker is stopped and the answer is `timeout`. Never rejects.
 */
export function parseMermaid(text: string, timeoutMs: number): Promise<MermaidParse> {
    const result = queue.then(() => parseNow(text, timeoutMs));
    queue = result;
    return result;
}

async function parseNow(text: string, timeoutMs: number): Promise<MermaidParse> {
    let current: Running;
    try {
        current = running ??= start();
        await current.ready;
    } catch (err) {
        console.error('[mermaid] the checker could not start, so Mermaid blocks go through unchecked:', err);
        return { status: 'unavailable' };
    }
    return new Promise((resolve) => {
        // It stopped between loading and now: no answer would ever come.
        if (running !== current) return resolve({ status: 'unavailable' });
        const id = ++lastId;
        const timer = setTimeout(() => {
            current.pending.delete(id);
            stop(current); // the parse may never end on its own
            resolve({ status: 'timeout' });
        }, timeoutMs);
        current.pending.set(id, (result) => {
            clearTimeout(timer);
            resolve(result);
        });
        current.worker.postMessage({ id, text });
    });
}

function start(): Running {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`), {
        workerData: moduleUrls(),
        // A runaway parse runs the worker out of memory, not the server.
        resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let loaded = () => {};
    let failed = (_err: Error) => {};
    const self: Running = {
        worker,
        pending: new Map(),
        ready: new Promise<void>((resolve, reject) => {
            loaded = resolve;
            failed = reject;
        }),
    };
    const end = (err: Error) => {
        clearTimeout(loadTimer);
        failed(err);
        stop(self);
        for (const done of self.pending.values()) done({ status: 'unavailable' });
        self.pending.clear();
    };
    const loadTimer = setTimeout(() => end(new Error(`Mermaid did not load in ${LOAD_TIMEOUT_MS / 1000} s`)), LOAD_TIMEOUT_MS);
    worker.on('message', (msg: { ready?: boolean; id?: number; error?: string; span?: [number, number] }) => {
        if (msg.ready) {
            clearTimeout(loadTimer);
            loaded();
            return;
        }
        const done = self.pending.get(msg.id ?? -1);
        self.pending.delete(msg.id ?? -1);
        if (msg.error === undefined) done?.({ status: 'ok' });
        else done?.(msg.span ? { status: 'error', message: msg.error, span: msg.span } : { status: 'error', message: msg.error });
    });
    worker.on('error', end);
    worker.on('exit', (code) => end(new Error(`the Mermaid worker stopped (exit code ${code})`)));
    // An idle worker never keeps the process alive; a parse in flight does (its timer). After the
    // 'message' listener: adding the first one refs the worker's port again.
    worker.unref();
    return self;
}

function stop(target: Running): void {
    if (running === target) running = null;
    void target.worker.terminate();
}

/** File URLs of Mermaid's ES module and of the DOMPurify ES module that Mermaid imports. */
function moduleUrls(): { mermaid: string; dompurify: string } {
    // Mermaid's exports give require its ES module too (dist/mermaid.core.mjs).
    const mermaid = require.resolve('mermaid');
    // DOMPurify as Mermaid imports it: the package found from Mermaid's folder, its "import" entry
    // (require would load the CommonJS build, a different instance that Mermaid never uses).
    let dir = path.dirname(createRequire(mermaid).resolve('dompurify'));
    let pkg: { name?: string; exports?: { '.'?: { import?: string | { default?: string } } } };
    for (;;) {
        const file = path.join(dir, 'package.json');
        pkg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
        if (pkg.name === 'dompurify') break;
        const up = path.dirname(dir);
        if (up === dir) throw new Error('DOMPurify, a Mermaid dependency, has no package.json');
        dir = up;
    }
    const entry = pkg.exports?.['.']?.import;
    const esm = typeof entry === 'string' ? entry : entry?.default;
    if (!esm) throw new Error("DOMPurify's package.json names no ES module");
    return { mermaid: pathToFileURL(mermaid).href, dompurify: pathToFileURL(path.join(dir, esm)).href };
}
