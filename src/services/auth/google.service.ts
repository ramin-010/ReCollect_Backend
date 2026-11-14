// Google sign-in: verify an ID token (credential) or an OAuth access token and return who it is.
// Network only, no database, so integration tests can vi.mock() this module.
import { OAuth2Client } from 'google-auth-library';
import ErrorResponse from '../../utils/errorResponse';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT);

export interface GoogleIdentity {
    email: string;
    name: string;
    googleId: string;
    picture: string | undefined;
}

export async function verifyGoogleIdentity(input: { credential?: unknown; accessToken?: unknown }): Promise<GoogleIdentity> {
    const { credential, accessToken } = input;

    if (!credential && !accessToken) {
        throw new ErrorResponse(400, 'Google credential token or access token is required');
    }

    if (credential) {
        // Verify the Google ID token
        const clientId = process.env.GOOGLE_CLIENT;
        if (!clientId) {
            throw new ErrorResponse(500, 'Google Client ID is not configured');
        }

        const ticket = await googleClient.verifyIdToken({
            idToken: String(credential),
            audience: clientId,
        });

        const payload = ticket.getPayload();
        if (!payload || !payload.email) {
            throw new ErrorResponse(400, 'Invalid Google token');
        }

        return {
            email: payload.email,
            name: payload.name || 'Google User',
            googleId: payload.sub,
            picture: payload.picture,
        };
    }

    // Verify the access token
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: {
            Authorization: `Bearer ${String(accessToken)}`,
        },
    });

    if (!response.ok) {
        throw new ErrorResponse(400, 'Invalid Google access token');
    }

    const payload = (await response.json()) as { email?: string; name?: string; sub?: string; picture?: string } | null;

    if (!payload || !payload.email) {
        throw new ErrorResponse(400, 'Invalid Google user info payload');
    }

    return {
        email: payload.email,
        name: payload.name || 'Google User',
        googleId: payload.sub ?? '',
        picture: payload.picture,
    };
}
