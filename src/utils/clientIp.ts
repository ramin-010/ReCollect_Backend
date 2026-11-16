// The client's address, for the limits on the doors (hosting P1-4).
//
// Behind the Cloudflare Tunnel every request reaches the server from cloudflared on loopback, and
// Cloudflare names the visitor in the CF-Connecting-IP header. That header is believed only when
// TRUST_CF_IP=1 and the socket's peer is loopback: from anywhere else it could be forged, and is
// ignored. Express's `trust proxy` is never turned on, so req.ip stays the socket's peer too.
import { isIP } from 'node:net';
import type { Request } from 'express';

const trustCf = (env: NodeJS.ProcessEnv) => /^(1|true|yes|on)$/i.test(env['TRUST_CF_IP']?.trim() ?? '');

/** 127.0.0.0/8 and ::1, also as IPv4 mapped into IPv6 (::ffff:127.0.0.1). */
export function isLoopback(address: string): boolean {
    const a = address.trim().toLowerCase().replace(/^::ffff:/, '');
    return a === '::1' || /^127(?:\.\d{1,3}){3}$/.test(a);
}

export function clientIp(req: Pick<Request, 'headers' | 'socket'>, env: NodeJS.ProcessEnv = process.env): string {
    const peer = req.socket?.remoteAddress ?? '';
    if (trustCf(env) && isLoopback(peer)) {
        const raw = req.headers['cf-connecting-ip'];
        const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
        if (value && isIP(value)) return value;
    }
    return peer || 'unknown';
}
