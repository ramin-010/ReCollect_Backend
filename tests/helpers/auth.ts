// Users + auth cookies for integration tests.
// The cookie is signed with the same signAuthToken() the real login uses, so a request made
// with authCookie(user) is authenticated exactly like a browser after POST /api/login.
import { createUser, type CreateUserInput, type SafeUser } from '../../src/services/users/users.service';
import { AUTH_COOKIE_NAME, AUTH_HINT_COOKIE_NAME, signAuthToken } from '../../src/services/auth/token';

export const TEST_PASSWORD = 'password123';

let counter = 0;

/** Create a real user row (password hashed by the users service). */
export async function createTestUser(overrides: Partial<CreateUserInput> = {}): Promise<SafeUser> {
    counter += 1;
    return createUser({
        email: `user${counter}-${Date.now()}@test.local`,
        name: `Test User ${counter}`,
        password: TEST_PASSWORD,
        ...overrides,
    });
}

/** Cookie header value(s) for supertest: request(app).get(url).set('Cookie', authCookie(user)). */
export function authCookie(user: { id: string }): string[] {
    return [`${AUTH_COOKIE_NAME}=${signAuthToken(user.id)}`, `${AUTH_HINT_COOKIE_NAME}=1`];
}

/** Parse Set-Cookie headers into { name: value }. */
export function cookiesFrom(setCookie: string | string[] | undefined): Record<string, string> {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const out: Record<string, string> = {};
    for (const line of list) {
        const [pair] = line.split(';');
        const eq = pair?.indexOf('=') ?? -1;
        if (pair && eq > 0) out[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1));
    }
    return out;
}
