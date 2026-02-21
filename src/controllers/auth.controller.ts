import { Request, Response, NextFunction, CookieOptions } from "express";
import { z } from 'zod'
import User, { User as UserType } from '../models/userSchema'
import ErrorResponse from "../utils/errorResponse";
import Dashboard from '../models/dashboardSchema'
import { createAndSendOtp, verifyOtpInternal, deleteOtp } from './otp.controller';
import { OAuth2Client } from 'google-auth-library';

const userSignupSchema = z.object({
    name: z.string().min(1, { message: 'Name cannot be empty' }),
    email: z.string().email({ message: 'email is not valid' }),
    password: z.string().min(8, { message: 'Password must be atleast 8 charachter long' })
});

type UserSignup = z.infer<typeof userSignupSchema>

export const Signup = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const result = userSignupSchema.safeParse(req.body)

        if (!result.success) {
            return res.status(400).json({
                message: 'Invalid Credential',
                error: result.error.flatten()
            })
        }
        const { email, name, password } = result.data as UserSignup;
        const existingUser = await User.findOne({ email }).exec();

        if (existingUser) {
            throw new ErrorResponse(400, "User already exists")
        }

        const user = await User.create({
            email,
            name,
            password
        });

        sendTokenResponse(user, 200, res)
    } catch (err: any) {
        next(err);
    }
}

const userLoginSchema = z.object({
    email: z.string().email({ message: 'email is not valid' }),
    password: z.string().min(8, { message: "password must be atleast 8 character long" })
})

type UserLogin = z.infer<typeof userLoginSchema>

export const login = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const result = userLoginSchema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                message: "Invalid credentails",
                error: result.error.flatten()
            })
        }

        const { email, password } = result.data as UserLogin

        const user = await User.findOne({ email }).select('+password').exec();
        if (!user) {
            throw new ErrorResponse(400, "user does not exist")
        }
        const isMatched = await user.comparePassword(password);
        if (!isMatched) throw new ErrorResponse(400, "wrong password");

        req.user = user;
        sendTokenResponse(user, 200, res);
    } catch (err: any) {
        next(err)
    }
}

export const Getme = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const user = req.user as UserType;

        const dashboards = await Dashboard.find({ user: user._id })
            .select('name description user contents createdAt updatedAt')
            .lean();

        res.status(200).json({
            success: true,
            data: { dashboards, user },
            message: 'get me succeded'
        })
    } catch (err: any) {
        next(err)
    }
}

function sendTokenResponse(user: UserType, statusCode: number, res: Response): void {
    const token = user.getSignedJwtToken();

    if (!process.env.JWT_COOKIE_EXPIRE) {
        throw new ErrorResponse(400, 'JWT_COOKIE_EXPIRE is undefined')
    }
    const JWT_COOKIE_EXPIRE = parseInt(process.env.JWT_COOKIE_EXPIRE);
    const maxAge = JWT_COOKIE_EXPIRE * 24 * 60 * 60 * 1000;

    const options: CookieOptions = {
        expires: new Date(Date.now() + maxAge),
        httpOnly: true,
        secure: true,
        sameSite: 'lax'
    }
    const userObj = user.toObject();
    delete userObj.password;

    res.status(statusCode)
        .cookie('token', token, options)
        // Non-HTTP-only hint cookie — readable by frontend JS for instant routing
        .cookie('auth_hint', '1', {
            httpOnly: false,
            secure: true,
            sameSite: 'lax',
            expires: new Date(Date.now() + maxAge),
        })
        .json({
            success: true,
            data: userObj
        })
}

export const logout = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        res.cookie('token', '', {
            httpOnly: true,
            expires: new Date(0),
            secure: true,
            sameSite: 'none'
        });

        // Clear the auth hint cookie too
        res.cookie('auth_hint', '', {
            httpOnly: false,
            expires: new Date(0),
            secure: true,
            sameSite: 'none'
        });

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

        const { name, email, password } = result.data;

        const existingUser = await User.findOne({ email: email.toLowerCase() }).exec();
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'Email already registered. Please login instead.'
            });
        }

        const emailSent = await createAndSendOtp(email, 'signup', { name, password });

        if (!emailSent) {
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

        const storedOtp = await verifyOtpInternal(email, otp, 'signup');

        if (!storedOtp.signupData) {
            return res.status(400).json({
                success: false,
                message: 'Signup data not found. Please start the signup process again.'
            });
        }

        const user = await User.create({
            email: email.toLowerCase(),
            name: storedOtp.signupData.name,
            password: storedOtp.signupData.password
        });

        await deleteOtp(storedOtp._id as string);

        sendTokenResponse(user, 201, res);

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

        const { email } = result.data;

        const user = await User.findOne({ email: email.toLowerCase() }).exec();

        if (!user) {
            return res.status(200).json({
                success: true,
                message: 'If an account exists with this email, an OTP has been sent.'
            });
        }

        const emailSent = await createAndSendOtp(email, 'password-reset');

        if (!emailSent) {
            return res.status(500).json({
                success: false,
                message: 'Failed to send OTP email. Please try again.'
            });
        }

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

        const storedOtp = await verifyOtpInternal(email, otp, 'password-reset');

        const user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {
            return res.status(400).json({
                success: false,
                message: 'User not found.'
            });
        }

        user.password = newPassword;
        await user.save();

        await deleteOtp(storedOtp._id as string);

        res.status(200).json({
            success: true,
            message: 'Password reset successful. You can now login with your new password.'
        });

    } catch (err: any) {
        next(err);
    }
};

// --- Google OAuth ---
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT);

export const googleLogin = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { credential } = req.body;

        if (!credential) {
            throw new ErrorResponse(400, 'Google credential token is required');
        }

        // Verify the Google ID token
        const clientId = process.env.GOOGLE_CLIENT;
        if (!clientId) {
            throw new ErrorResponse(500, 'Google Client ID is not configured');
        }

        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: clientId,
        });

        const payload = ticket.getPayload();
        if (!payload || !payload.email) {
            throw new ErrorResponse(400, 'Invalid Google token');
        }

        const { email, name, sub: googleId, picture } = payload;

        // Check if user already exists
        let user = await User.findOne({ email: email.toLowerCase() }).exec();

        if (user) {
            // User exists — update googleId if not already set
            if (!user.googleId) {
                user.googleId = googleId;
                user.authProvider = 'google';
                if (picture && !user.avatar) {
                    user.avatar = picture;
                }
                await user.save();
            }
        } else {
            // Create a new user (no password needed for Google auth)
            user = await User.create({
                email: email.toLowerCase(),
                name: name || 'Google User',
                googleId,
                authProvider: 'google',
                avatar: picture || '',
                password: `google_${googleId}_${Date.now()}`, // placeholder, never used for login
            });
        }

        sendTokenResponse(user, 200, res);
    } catch (err: any) {
        next(err);
    }
};
