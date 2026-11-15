// The logged-in user behind a request that doesn't need one (the public page of a published doc):
// the `token` cookie's user id when it is valid and the user exists, else null. Never throws and never
// reads access tokens (an agent has no business on the public page).
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { findUserById } from '../services/users/users.service';

export async function cookieUserId(req: Request): Promise<string | null> {
    const token: unknown = req.cookies?.token;
    const secret = process.env.JWT_SECRET;
    if (typeof token !== 'string' || !token || !secret) return null;
    try {
        const decoded = jwt.verify(token, secret) as { id?: unknown };
        if (typeof decoded.id !== 'string') return null;
        const user = await findUserById(decoded.id);
        return user ? user.id : null;
    } catch {
        return null;
    }
}
