// A doc's Yjs state (D3, 2026-11-15): Doc.yjsState and DocSnapshot.yjsState / agentUpdate are bytes
// (Postgres bytea; Prisma's Bytes is a Uint8Array). Functions that read a state take bytes or Base64
// text (older callers and tests still hold text); these helpers are the one place that knows both.

/** Bytes as Prisma stores them (backed by a plain ArrayBuffer). */
export type StateBytes = Uint8Array<ArrayBuffer>;

/** A state as a function may receive it: bytes, or Base64 text. */
export type DocState = Uint8Array | string;

/** Bytes Prisma can store (Base64 text decoded; a Node Buffer or a view copied into its own buffer). */
export function stateBytes(state: DocState): StateBytes {
    if (typeof state === 'string') return new Uint8Array(Buffer.from(state, 'base64'));
    const own = state.buffer instanceof ArrayBuffer && state.byteOffset === 0 && state.byteLength === state.buffer.byteLength;
    return own ? (state as StateBytes) : new Uint8Array(state);
}

/** Base64 text of a state (for JSON, logs and old tests). */
export function stateBase64(state: DocState): string {
    return typeof state === 'string' ? state : Buffer.from(state.buffer, state.byteOffset, state.byteLength).toString('base64');
}

/** A state as an update Yjs can apply (no copy for bytes). */
export function stateUpdate(state: DocState): Uint8Array {
    return typeof state === 'string' ? new Uint8Array(Buffer.from(state, 'base64')) : state;
}
