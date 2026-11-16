// Who may make an account (hosting P1-3). SIGNUP_MODE:
//   open      (the default: dev and tests) anyone, as before;
//   allowlist only the emails in SIGNUP_ALLOWLIST (comma or space separated);
//   closed    nobody.
// It covers every way an account is made: /signup, /pre-signup, /verify-signup, a new account
// through /auth/google, and claiming a placeholder account (made when someone was invited before
// they had one). Existing accounts always log in. An unknown value counts as closed.
import ErrorResponse from '../utils/errorResponse';

export type SignupMode = 'open' | 'allowlist' | 'closed';

export function signupMode(env: NodeJS.ProcessEnv = process.env): SignupMode {
    const v = env['SIGNUP_MODE']?.trim().toLowerCase();
    if (!v || v === 'open') return 'open';
    return v === 'allowlist' ? 'allowlist' : 'closed';
}

export function signupAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
    return (env['SIGNUP_ALLOWLIST'] ?? '')
        .split(/[\s,]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
}

/** Whether a new account (or a claim) may be made for this email. */
export function signupAllowed(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const mode = signupMode(env);
    if (mode === 'open') return true;
    if (mode === 'closed') return false;
    return signupAllowlist(env).includes(email.trim().toLowerCase());
}

export const SIGNUP_CLOSED_MESSAGE = 'New accounts are closed on this server.';

/** 403 unless signupAllowed. */
export function assertSignupAllowed(email: string, env: NodeJS.ProcessEnv = process.env): void {
    if (!signupAllowed(email, env)) throw new ErrorResponse(403, SIGNUP_CLOSED_MESSAGE);
}
