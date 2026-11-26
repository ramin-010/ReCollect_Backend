// The secret scrub (BUDDY_MEMORY_PLAN §3.1): run in code on every word the buddy is given (his
// typed words from the hooks, an agent's note, "Tell your buddy") before any model or table sees
// it. Pure; tests/unit/buddy/scrub.test.ts holds a table of cases.
//
// What goes: API keys and tokens by their known prefixes, the value after password= / secret: and
// the like, JWTs, private-key blocks, a URL's password, and any long run that looks random (32+
// characters of hex, or of base64 with digits and both cases). Each becomes "[secret]".

export const SECRET = '[secret]';

/** Known key and token shapes (each matched as a whole word). */
const KEY_PATTERNS: readonly RegExp[] = [
    /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, // Anthropic, OpenAI
    /\brcl_[A-Za-z0-9_-]{16,}/g, // Kaaga's own access tokens
    /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key ids
    /\bAIza[A-Za-z0-9_-]{30,}/g, // Google API keys
    /\bnpm_[A-Za-z0-9]{30,}/g,
    /\b(?:pk|sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
];

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/** `password=…`, `api_key: …`, `"client_secret": "…"`: the label stays, the value goes. */
const LABELLED_VALUE =
    /\b((?:password|passwd|pwd|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret[_-]?key)["']?\s*[:=]\s*)(["']?)([^\s"',;]{4,})\2/gi;
/** `token=…`, `secret=…`, `"token": "…"` (a plain "token: the hook's" in a sentence stays). */
const WEAK_LABELLED_VALUE = /\b((?:token|secret)(?:\s*=\s*|["']\s*:\s*))(["']?)([^\s"',;]{4,})\2/gi;

/** A URL's user:password@ */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi;

/** A long unbroken run that may be random (checked further by looksRandom). */
const LONG_RUN = /[A-Za-z0-9+/_=-]{32,}/g;

/** Hex of 32+, or base64-like text with digits, upper and lower case (identifiers and words pass). */
export function looksRandom(run: string): boolean {
    const core = run.replace(/=+$/, '');
    if (/^[0-9a-fA-F]{32,}$/.test(core) && /\d/.test(core)) return true;
    if (!/\d/.test(core) || !/[a-z]/.test(core) || !/[A-Z]/.test(core)) return false;
    // A path or a slug made of words (letters between separators) is not a secret.
    const pieces = core.split(/[/_-]+/).filter(Boolean);
    if (pieces.length > 1 && pieces.every((p) => p.length <= 16)) return false;
    // Random text changes case and class often; a camelCase name with a number does not.
    let changes = 0;
    for (let i = 1; i < core.length; i++) {
        const a = classOf(core[i - 1]!);
        const b = classOf(core[i]!);
        if (a !== b) changes++;
    }
    return changes / core.length > 0.25;
}

const classOf = (c: string): number => (c >= '0' && c <= '9' ? 0 : c >= 'a' && c <= 'z' ? 1 : c >= 'A' && c <= 'Z' ? 2 : 3);

/** The text with every secret it holds replaced by [secret]. */
export function scrubSecrets(text: string): string {
    let out = text.replace(PRIVATE_KEY_BLOCK, SECRET);
    for (const re of KEY_PATTERNS) out = out.replace(re, SECRET);
    out = out.replace(URL_PASSWORD, (_m, head: string) => `${head}${SECRET}@`);
    const label = (m: string, head: string, quote: string, value: string) => (value === SECRET ? m : `${head}${quote}${SECRET}${quote}`);
    out = out.replace(LABELLED_VALUE, label).replace(WEAK_LABELLED_VALUE, label);
    out = out.replace(LONG_RUN, (run) => (looksRandom(run) ? SECRET : run));
    return out;
}

/** Whether the scrub changed anything (for the counts, never the words). */
export function hadSecrets(text: string): boolean {
    return scrubSecrets(text) !== text;
}
