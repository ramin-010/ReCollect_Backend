import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import User from '../models/userSchema';
import EmailThread from '../models/emailThreadSchema';
import ErrorResponse from '../utils/errorResponse';
import { encrypt, decrypt } from '../utils/encryption';
import {
    getGmailAuthUrl,
    getGmailTokens,
    refreshAccessToken,
    getGmailProfile,
    sendEmail,
    getThreadMessages,
    getThreadUpdates,
} from '../services/gmailService';
import { generateEmailDraft } from '../services/ai/emailAiService';

// ─── Connect Gmail: Generate OAuth URL ───────────────────────────────────────
export const connectGmail = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const userId = req.user?._id?.toString() || '';
        const authUrl = getGmailAuthUrl(userId);

        return res.status(200).json({
            success: true,
            authUrl,
        });
    } catch (err) {
        next(err);
    }
};

// ─── Gmail OAuth Callback: Exchange code for tokens ──────────────────────────
const callbackSchema = z.object({
    code: z.string().min(1, 'Authorization code is required'),
});

export const gmailCallback = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { code } = callbackSchema.parse(req.body);
        const userId = req.user?._id;

        if (!userId) {
            throw new ErrorResponse(401, 'Not authenticated');
        }

        // Exchange code for tokens
        const tokens = await getGmailTokens(code);

        if (!tokens.refresh_token) {
            throw new ErrorResponse(400, 'No refresh token received. Please try connecting again.');
        }

        // Get the Gmail email address
        const accessToken = tokens.access_token;
        if (!accessToken) {
            throw new ErrorResponse(400, 'No access token received.');
        }

        const profile = await getGmailProfile(accessToken);

        // Encrypt and store refresh token
        const encryptedRefreshToken = encrypt(tokens.refresh_token);

        await User.findByIdAndUpdate(userId, {
            gmailConnected: true,
            gmailRefreshToken: encryptedRefreshToken,
            gmailEmail: profile.email,
        });

        return res.status(200).json({
            success: true,
            message: 'Gmail connected successfully',
            email: profile.email,
        });
    } catch (err) {
        next(err);
    }
};

// ─── Gmail Connection Status ─────────────────────────────────────────────────
export const gmailStatus = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const user = req.user;

        return res.status(200).json({
            success: true,
            connected: user?.gmailConnected || false,
            email: user?.gmailEmail || null,
        });
    } catch (err) {
        next(err);
    }
};

// ─── Disconnect Gmail ────────────────────────────────────────────────────────
export const disconnectGmail = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const userId = req.user?._id;

        await User.findByIdAndUpdate(userId, {
            gmailConnected: false,
            gmailRefreshToken: '',
            gmailEmail: '',
        });

        return res.status(200).json({
            success: true,
            message: 'Gmail disconnected successfully',
        });
    } catch (err) {
        next(err);
    }
};

// ─── AI Draft Generation ─────────────────────────────────────────────────────
const draftSchema = z.object({
    recipient: z.string().min(1),
    recipientName: z.string().optional(),
    subject: z.string().optional(),
    context: z.string().min(1, 'Context is required'),
    tone: z.enum(['professional', 'casual', 'friendly', 'formal', 'persuasive']),
    instructions: z.string().optional(),
    threadId: z.string().optional(),
});

export const generateDraft = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const params = draftSchema.parse(req.body);

        // If replying to a thread, fetch thread history for context
        let threadHistory: string | undefined;
        if (params.threadId && req.user?.gmailConnected && req.user?.gmailRefreshToken) {
            try {
                const refreshToken = decrypt(req.user.gmailRefreshToken);
                const accessToken = await refreshAccessToken(refreshToken);
                const thread = await getThreadMessages(accessToken, params.threadId);

                threadHistory = thread.messages
                    .map((m: any) => `From: ${m.from}\nDate: ${m.date}\n${m.snippet}`)
                    .join('\n---\n');
            } catch (err) {
                console.warn('Could not fetch thread history for AI context:', err);
            }
        }

        const draft = await generateEmailDraft({
            recipient: params.recipient,
            recipientName: params.recipientName || undefined,
            subject: params.subject || undefined,
            context: params.context,
            tone: params.tone,
            instructions: params.instructions || undefined,
            threadHistory,
        });

        return res.status(200).json({
            success: true,
            draft,
        });
    } catch (err) {
        next(err);
    }
};

// ─── Send Email ──────────────────────────────────────────────────────────────
const sendSchema = z.object({
    to: z.string().email('Invalid recipient email'),
    subject: z.string().min(1, 'Subject is required'),
    htmlBody: z.string().min(1, 'Email body is required'),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    threadId: z.string().optional(),
    inReplyTo: z.string().optional(),
    references: z.string().optional(),
});

export const sendEmailController = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { to, subject, htmlBody, cc, bcc, threadId, inReplyTo, references } = sendSchema.parse(req.body);
        const user = req.user;

        if (!user?.gmailConnected || !user?.gmailRefreshToken) {
            throw new ErrorResponse(400, 'Gmail is not connected. Please connect your Gmail first.');
        }

        // Process file attachments from multer
        const attachments: { filename: string; mimeType: string; data: Buffer }[] = [];
        if (req.files && Array.isArray(req.files)) {
            for (const file of req.files) {
                attachments.push({
                    filename: file.originalname,
                    mimeType: file.mimetype,
                    data: file.buffer,
                });
            }
        }

        // Get fresh access token
        const refreshToken = decrypt(user.gmailRefreshToken);
        const accessToken = await refreshAccessToken(refreshToken);

        // Send via Gmail API
        const result = await sendEmail({
            accessToken,
            to,
            subject,
            htmlBody,
            from: user.gmailEmail || user.email,
            cc: cc || undefined,
            bcc: bcc || undefined,
            threadId: threadId || undefined,
            inReplyTo: inReplyTo || undefined,
            references: references || undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
        });

        // Track the thread in our database
        const existingThread = await EmailThread.findOne({
            userId: user._id,
            gmailThreadId: result.threadId,
        });

        if (existingThread) {
            // Update existing thread
            existingThread.lastMessageId = result.messageId;
            existingThread.messageCount += 1;
            existingThread.lastSyncedAt = new Date();
            await existingThread.save();
        } else {
            // Create new tracked thread
            await EmailThread.create({
                userId: user._id,
                gmailThreadId: result.threadId,
                lastMessageId: result.messageId,
                subject,
                recipient: to,
                messageCount: 1,
            });
        }

        return res.status(200).json({
            success: true,
            threadId: result.threadId,
            messageId: result.messageId,
        });
    } catch (err) {
        next(err);
    }
};

// ─── Get Tracked Threads ─────────────────────────────────────────────────────
export const getTrackedThreads = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const user = req.user;

        if (!user?.gmailConnected || !user?.gmailRefreshToken) {
            throw new ErrorResponse(400, 'Gmail is not connected.');
        }

        // Get tracked threads from our DB
        const trackedThreads = await EmailThread.find({
            userId: user._id,
            status: 'active',
        }).sort({ updatedAt: -1 });

        if (trackedThreads.length === 0) {
            return res.status(200).json({
                success: true,
                threads: [],
            });
        }

        // Fetch latest messages from Gmail for tracked threads
        const refreshToken = decrypt(user.gmailRefreshToken);
        const accessToken = await refreshAccessToken(refreshToken);

        const threadIds = trackedThreads.map((t) => t.gmailThreadId);
        const gmailThreads = await getThreadUpdates(accessToken, threadIds);

        // Merge DB metadata with Gmail data
        const threads = trackedThreads.map((dbThread) => {
            const gmailThread = gmailThreads.find(
                (gt: any) => gt.threadId === dbThread.gmailThreadId
            );
            return {
                _id: dbThread._id,
                gmailThreadId: dbThread.gmailThreadId,
                subject: dbThread.subject,
                recipient: dbThread.recipient,
                status: dbThread.status,
                messageCount: gmailThread?.messages?.length || dbThread.messageCount,
                messages: gmailThread?.messages || [],
                createdAt: (dbThread as any).createdAt,
                updatedAt: (dbThread as any).updatedAt,
            };
        });

        return res.status(200).json({
            success: true,
            threads,
        });
    } catch (err) {
        next(err);
    }
};

// ─── Get Single Thread ───────────────────────────────────────────────────────
export const getThreadDetail = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const user = req.user;
        const { threadId } = req.params;

        if (!user?.gmailConnected || !user?.gmailRefreshToken) {
            throw new ErrorResponse(400, 'Gmail is not connected.');
        }

        // Verify this thread belongs to the user
        const dbThread = await EmailThread.findOne({
            userId: user._id,
            gmailThreadId: threadId,
        });

        if (!dbThread) {
            throw new ErrorResponse(404, 'Thread not found');
        }

        // Fetch full thread from Gmail
        const refreshToken = decrypt(user.gmailRefreshToken);
        const accessToken = await refreshAccessToken(refreshToken);
        const gmailThread = await getThreadMessages(accessToken, threadId!);

        return res.status(200).json({
            success: true,
            thread: {
                _id: dbThread._id,
                gmailThreadId: dbThread.gmailThreadId,
                subject: dbThread.subject,
                recipient: dbThread.recipient,
                status: dbThread.status,
                messages: gmailThread.messages,
            },
        });
    } catch (err) {
        next(err);
    }
};

// ─── Archive Thread ──────────────────────────────────────────────────────────
export const archiveThread = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const user = req.user;
        const { threadId } = req.params;

        const thread = await EmailThread.findOneAndUpdate(
            { userId: user?._id, gmailThreadId: threadId },
            { status: 'archived' },
            { new: true }
        );

        if (!thread) {
            throw new ErrorResponse(404, 'Thread not found');
        }

        return res.status(200).json({
            success: true,
            message: 'Thread archived',
        });
    } catch (err) {
        next(err);
    }
};
