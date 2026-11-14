// ===========================================================================
// Gmail Service — Handles Gmail API operations
// Sends emails, fetches thread updates, manages OAuth tokens
// ===========================================================================

import { OAuth2Client } from 'google-auth-library';
import dotenv from 'dotenv';
dotenv.config();

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
];

function getOAuth2Client(): OAuth2Client {
    const clientId = process.env.GOOGLE_CLIENT;
    const clientSecret = process.env.GOOGLE_SECRET;
    const redirectUri = `${process.env.FRONTEND_URL}/email/callback`;

    if (!clientId || !clientSecret) {
        throw new Error('Google OAuth credentials are not configured');
    }

    return new OAuth2Client(clientId, clientSecret, redirectUri);
}

/**
 * Generate the Google OAuth URL for Gmail consent
 */
export function getGmailAuthUrl(state?: string): string {
    const client = getOAuth2Client();
    return client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
        state: state || '',
    });
}

/**
 * Exchange authorization code for tokens
 */
export async function getGmailTokens(code: string) {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(code);
    return tokens;
}

/**
 * Refresh an access token using a refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
    const client = getOAuth2Client();
    client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await client.refreshAccessToken();

    if (!credentials.access_token) {
        throw new Error('Failed to refresh Gmail access token');
    }

    return credentials.access_token;
}

/**
 * Get the Gmail profile (email address) for the authenticated user
 */
export async function getGmailProfile(accessToken: string): Promise<{ email: string }> {
    const response = await fetch(`${GMAIL_API_BASE}/profile`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Gmail profile: ${response.statusText}`);
    }

    const data = await response.json();
    return { email: data.emailAddress };
}

/**
 * Build a RFC 2822 MIME message
 */
function buildMimeMessage(
    to: string,
    from: string,
    subject: string,
    htmlBody: string,
    options?: {
        cc?: string | undefined;
        bcc?: string | undefined;
        inReplyTo?: string | undefined;
        references?: string | undefined;
        attachments?: { filename: string; mimeType: string; data: Buffer }[] | undefined;
    }
): string {
    const hasAttachments = options?.attachments && options.attachments.length > 0;
    const mixedBoundary = `mixed_${Date.now()}`;
    const altBoundary = `alt_${Date.now()}`;

    let headers = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
    ];

    if (options?.cc) headers.push(`Cc: ${options.cc}`);
    if (options?.bcc) headers.push(`Bcc: ${options.bcc}`);
    if (options?.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);
    if (options?.references) headers.push(`References: ${options.references}`);

    if (hasAttachments) {
        // multipart/mixed → contains text part + attachment parts
        headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

        const parts = [
            headers.join('\r\n'),
            '',
            `--${mixedBoundary}`,
            `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
            '',
            `--${altBoundary}`,
            'Content-Type: text/html; charset="UTF-8"',
            'Content-Transfer-Encoding: 7bit',
            '',
            htmlBody,
            `--${altBoundary}--`,
        ];

        // Add each attachment
        for (const att of options!.attachments!) {
            parts.push(
                `--${mixedBoundary}`,
                `Content-Type: ${att.mimeType}; name="${att.filename}"`,
                `Content-Disposition: attachment; filename="${att.filename}"`,
                'Content-Transfer-Encoding: base64',
                '',
                att.data.toString('base64'),
            );
        }

        parts.push(`--${mixedBoundary}--`);
        return parts.join('\r\n');
    } else {
        // Simple email — no attachments
        headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);

        return [
            headers.join('\r\n'),
            '',
            `--${altBoundary}`,
            'Content-Type: text/html; charset="UTF-8"',
            'Content-Transfer-Encoding: 7bit',
            '',
            htmlBody,
            `--${altBoundary}--`,
        ].join('\r\n');
    }
}

/**
 * Base64url encode a string (for Gmail API)
 */
function base64UrlEncode(str: string): string {
    return Buffer.from(str)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Send an email via Gmail API.
 * Returns { threadId, messageId } for thread tracking.
 */
export async function sendEmail(params: {
    accessToken: string;
    to: string;
    subject: string;
    htmlBody: string;
    from: string;
    cc?: string | undefined;
    bcc?: string | undefined;
    threadId?: string | undefined;
    inReplyTo?: string | undefined;
    references?: string | undefined;
    attachments?: { filename: string; mimeType: string; data: Buffer }[] | undefined;
}): Promise<{ threadId: string; messageId: string }> {
    const { accessToken, to, subject, htmlBody, from, cc, bcc, threadId, inReplyTo, references, attachments } = params;

    const mimeMessage = buildMimeMessage(to, from, subject, htmlBody, {
        cc, bcc, inReplyTo, references, attachments,
    });
    const encodedMessage = base64UrlEncode(mimeMessage);

    const requestBody: any = { raw: encodedMessage };
    if (threadId) {
        requestBody.threadId = threadId;
    }

    const response = await fetch(`${GMAIL_API_BASE}/messages/send`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Gmail API send failed: ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    return {
        threadId: data.threadId,
        messageId: data.id,
    };
}

/**
 * Fetch full thread details for specific thread IDs.
 * Only fetches threads we are tracking — never the full inbox.
 */
export async function getThreadMessages(
    accessToken: string,
    threadId: string
): Promise<any> {
    const response = await fetch(
        `${GMAIL_API_BASE}/threads/${threadId}?format=full`,
        {
            headers: { Authorization: `Bearer ${accessToken}` },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to fetch thread ${threadId}: ${response.statusText}`);
    }

    const thread = await response.json();

    // Parse messages into a clean format
    const messages = (thread.messages || []).map((msg: any) => {
        const headers = msg.payload?.headers || [];
        const getHeader = (name: string) =>
            headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        // Extract body — prefer HTML, fallback to plain text
        let body = '';
        if (msg.payload?.body?.data) {
            body = Buffer.from(msg.payload.body.data, 'base64url').toString('utf8');
        } else if (msg.payload?.parts) {
            const htmlPart = msg.payload.parts.find((p: any) => p.mimeType === 'text/html');
            const textPart = msg.payload.parts.find((p: any) => p.mimeType === 'text/plain');
            const part = htmlPart || textPart;
            if (part?.body?.data) {
                body = Buffer.from(part.body.data, 'base64url').toString('utf8');
            }
        }

        return {
            id: msg.id,
            threadId: msg.threadId,
            from: getHeader('From'),
            to: getHeader('To'),
            subject: getHeader('Subject'),
            date: getHeader('Date'),
            messageId: getHeader('Message-ID'),
            snippet: msg.snippet || '',
            body,
            labelIds: msg.labelIds || [],
        };
    });

    return {
        threadId: thread.id,
        messages,
    };
}

/**
 * Fetch updates for multiple tracked threads.
 * Returns an array of thread data with their messages.
 */
export async function getThreadUpdates(
    accessToken: string,
    threadIds: string[]
): Promise<any[]> {
    const results = await Promise.allSettled(
        threadIds.map((id) => getThreadMessages(accessToken, id))
    );

    return results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
        .map((r) => r.value);
}
