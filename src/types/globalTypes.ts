import type { AuthUser, RequestAuth } from './auth';

declare global {
  namespace Express {
    interface Request {
      /** Set by authMiddleware (src/middlwares/auth.ts). Undefined on public routes. */
      user?: AuthUser;
      /** Set by authMiddleware with req.user: cookie session or access token (scopes, agent name). */
      auth?: RequestAuth;
    }
  }
}

export {};
