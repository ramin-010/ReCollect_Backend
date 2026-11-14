import mongoose, { Document, Schema } from 'mongoose';

export interface EmailThread extends Document {
    userId: mongoose.Types.ObjectId;
    gmailThreadId: string;
    lastMessageId: string;
    subject: string;
    recipient: string;
    recipientName?: string;
    snippet?: string;
    messageCount: number;
    status: 'active' | 'archived';
    lastSyncedAt: Date;
}

const EmailThreadSchema = new Schema<EmailThread>(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        gmailThreadId: {
            type: String,
            required: true,
        },
        lastMessageId: {
            type: String,
            required: true,
        },
        subject: {
            type: String,
            required: true,
            trim: true,
        },
        recipient: {
            type: String,
            required: true,
            trim: true,
        },
        recipientName: {
            type: String,
            default: '',
        },
        snippet: {
            type: String,
            default: '',
        },
        messageCount: {
            type: Number,
            default: 1,
        },
        status: {
            type: String,
            enum: ['active', 'archived'],
            default: 'active',
        },
        lastSyncedAt: {
            type: Date,
            default: Date.now,
        },
    },
    { timestamps: true }
);

// Compound index for efficient lookups
EmailThreadSchema.index({ userId: 1, gmailThreadId: 1 }, { unique: true });

export default mongoose.model<EmailThread>('EmailThread', EmailThreadSchema);
