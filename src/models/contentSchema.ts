import mongoose, { Document, mongo, Schema } from "mongoose";
import { title } from "process";

// Connection interface for embedded connections
export interface IConnection {
    id: string;
    fromBlock: string;
    fromSide: 'top' | 'right' | 'bottom' | 'left';
    toBlock: string;
    toSide: 'top' | 'right' | 'bottom' | 'left';
    controlPoint1?: { x: number, y: number };
    controlPoint2?: { x: number, y: number };
    color?: string;
    hidden?: boolean;
    originalBlockId?: string;
}

export interface Content extends Document {
    user: mongoose.Types.ObjectId,
    title: string,
    description: string,
    body: mongoose.Types.ObjectId[],
    connections: IConnection[],  // NEW: Embedded connections array
    tags: mongoose.Types.ObjectId[],
    links: string[],
    isPinned: boolean,
    isArchived: boolean,
    visibility: string
}

// Sub-schema for control points
const ControlPointSchema = new Schema({
    x: { type: Number, required: true },
    y: { type: Number, required: true }
}, { _id: false });

// Sub-schema for connections (embedded, no ObjectId)
const ConnectionSchema = new Schema({
    id: { type: String, required: true },
    fromBlock: { type: String, required: true },
    fromSide: { type: String, enum: ['top', 'right', 'bottom', 'left'], required: true },
    toBlock: { type: String, required: true },
    toSide: { type: String, enum: ['top', 'right', 'bottom', 'left'], required: true },
    controlPoint1: { type: ControlPointSchema, required: false },
    controlPoint2: { type: ControlPointSchema, required: false },
    color: { type: String, required: false },
    hidden: { type: Boolean, default: false },
    originalBlockId: { type: String, required: false }
}, { _id: false });

const ContentSchema = new Schema<Content>(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        title: {
            type: String,
            required: true,
            trim: true,
        },
        description: {
            type: String,
            default: ''
        },
        body: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Block'
        }],
        connections: {
            type: [ConnectionSchema],
            default: []
        },
        tags: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Tags'
        }],
        links: [
            {
                type: String,
                default: ''
            }
        ],
        isPinned: {
            type: Boolean,
            default: false
        },
        isArchived: {
            type: Boolean,
            default: false,
        },
        visibility: {
            type: String,
            enum: ['Public', 'Private'],
        }
    }, { timestamps: true }
);

ContentSchema.index({ title: 1 });

export default mongoose.model<Content>('Content', ContentSchema);