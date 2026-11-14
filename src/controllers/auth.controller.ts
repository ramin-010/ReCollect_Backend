// Auth endpoints (Postgres). Logic lives in src/services/auth; this file validates input and
// shapes responses exactly like the Mongo version (same messages, including the old typos).
import { Request, Response, NextFunction } from "express";
import { z } from 'zod'
import ErrorResponse from "../utils/errorResponse";
import { serializeUser } from '../db/serializers';
import { sendTokenResponse, clearAuthCookies } from '../services/auth/token';
import { verifyGoogleIdentity } from '../services/auth/google.service';
import {
    completeEmailSignup,
    loginWithGoogle,
    loginWithPassword,
    requestPasswordReset,
    resetPasswordWithOtp,
    signupWithPassword,
    startEmailSignup,
} from '../services/auth/auth.service';

const userSignupSchema = z.object({
    name: z.string().min(1, { message: 'Name cannot be empty' }),
    email: z.string().email({ message: 'email is not valid' }),
    password: z.string().min(8, { message: 'Password must be atleast 8 charachter long' })
});

export const Signup = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const result = userSignupSchema.safeParse(req.body)

        if (!result.success) {
            return res.status(400).json({
                message: 'Invalid Credential',
                error: result.error.flatten()
            })
        }

        const user = await signupWithPassword(result.data);
        sendTokenResponse(user, 200, res)
    } catch (err: any) {
        next(err);
    }
}

const userLoginSchema = z.object({
    email: z.string().email({ message: 'email is not valid' }),
    password: z.string().min(8, { message: "password must be atleast 8 character long" })
})

export const login = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const result = userLoginSchema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                message: "Invalid credentails",
                error: result.error.flatten()
            })
        }

        const user = await loginWithPassword(result.data);
        sendTokenResponse(user, 200, res);
    } catch (err: any) {
        next(err)
    }
}

export const Getme = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!req.user) {
            throw new ErrorResponse(401, "Not authorized, no token found");
        }

        res.status(200).json({
            success: true,
            // Dashboards were cut; the key stays (always empty) because the frontend still reads it.
            data: { dashboards: [], user: serializeUser(req.user) },
            message: 'get me succeded'
        })
    } catch (err: any) {
        next(err)
    }
}

export const logout = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        clearAuthCookies(res);

        res.status(200).json({
            success: true,
            message: 'Logged out successfully'
        });
    } catch (err: any) {
        next(err);
    }
};

const preSignupSchema = z.object({
    name: z.string().min(1, { message: 'Name cannot be empty' }),
    email: z.string().email({ message: 'Email is not valid' }),
    password: z.string().min(8, { message: 'Password must be at least 8 characters long' })
});

export const preSignup = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const result = preSignupSchema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: 'Invalid credentials',
                error: result.error.flatten()
            });
        }

        const outcome = await startEmailSignup(result.data);

        if (outcome === 'email-taken') {
            return res.status(400).json({
                success: false,
                message: 'Email already registered. Please login instead.'
            });
        }

        if (outcome === 'email-failed') {
            return res.status(500).json({
                success: false,
                message: 'Failed to send OTP email. Please try again.'
            });
        }

        res.status(200).json({
            success: true,
            message: 'OTP sent successfully to your email. Please verify to complete signup.'
        });

    } catch (err: any) {
        next(err);
    }
};

const verifySignupSchema = z.object({
    email: z.string().email({ message: 'Email is not valid' }),
    otp: z.string().length(4, { message: 'OTP must be exactly 4 digits' })
});

export const verifySignup = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const result = verifySignupSchema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request',
                error: result.error.flatten()
            });
        }

        const { email, otp } = result.data;
        const outcome = await completeEmailSignup(email, otp);

        if (outcome.status === 'missing-signup-data') {
            return res.status(400).json({
                success: false,
                message: 'Signup data not found. Please start the signup process again.'
            });
        }

        sendTokenResponse(outcome.user, 201, res);

    } catch (err: any) {
        next(err);
    }
};

const forgotPasswordSchema = z.object({
    email: z.string().email({ message: 'Email is not valid' })
});

export const forgotPassword = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const result = forgotPasswordSchema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request',
                error: result.error.flatten()
            });
        }

        const outcome = await requestPasswordReset(result.data.email);

        if (outcome === 'email-failed') {
            return res.status(500).json({
                success: false,
                message: 'Failed to send OTP email. Please try again.'
            });
        }

        // Same answer whether or not the account exists.
        res.status(200).json({
            success: true,
            message: 'If an account exists with this email, an OTP has been sent.'
        });

    } catch (err: any) {
        next(err);
    }
};

const resetPasswordSchema = z.object({
    email: z.string().email({ message: 'Email is not valid' }),
    otp: z.string().length(4, { message: 'OTP must be exactly 4 digits' }),
    newPassword: z.string().min(8, { message: 'Password must be at least 8 characters long' })
});

export const resetPassword = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const result = resetPasswordSchema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request',
                error: result.error.flatten()
            });
        }

        const { email, otp, newPassword } = result.data;
        const outcome = await resetPasswordWithOtp(email, otp, newPassword);

        if (outcome === 'user-not-found') {
            return res.status(400).json({
                success: false,
                message: 'User not found.'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Password reset successful. You can now login with your new password.'
        });

    } catch (err: any) {
        next(err);
    }
};

// --- Google OAuth ---
export const googleLogin = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { credential, accessToken } = req.body ?? {};
        const identity = await verifyGoogleIdentity({ credential, accessToken });
        const user = await loginWithGoogle(identity);
        sendTokenResponse(user, 200, res);
    } catch (err: any) {
        next(err);
    }
};
