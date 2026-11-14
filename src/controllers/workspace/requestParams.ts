// Small request helpers shared by the workspace controllers.
import type { Request } from 'express';

/** A route parameter as a string ('' if somehow missing: it then simply matches nothing). */
export function routeParam(req: Request, name: string): string {
    const value = req.params[name];
    return typeof value === 'string' ? value : '';
}

/** ?spaceId=<id> filters by space; missing, empty or 'all' means every space. */
export function spaceIdFilter(value: unknown): string | undefined {
    return typeof value === 'string' && value && value !== 'all' ? value : undefined;
}
