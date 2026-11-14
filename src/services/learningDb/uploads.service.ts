// POST /api/learning/uploads (LEARNING_SPEC §2 #21): one file (≤ 20 MB, field `file`) kept in
// memory by multer, then sent to Cloudinary with resource_type 'auto' (images, PDFs, anything).
// Returns the attachment shape stored on captures and quick notes.
import multer from 'multer';
import type { RequestHandler } from 'express';
import cloudinary from '../../utils/cloudinary';
import { LearningHttpError } from '../learning/http';

export const LEARNING_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const LEARNING_UPLOAD_FOLDER = 'recollect-learning';

export interface UploadedAttachment {
    url: string;
    publicId: string;
    fileName: string;
    fileType: string;
}

const parseFile = multer({ storage: multer.memoryStorage(), limits: { fileSize: LEARNING_UPLOAD_MAX_BYTES, files: 1 } }).single('file');

/** multer, with its errors turned into 413 (too large) / 400 (anything else). */
export const learningUploadMiddleware: RequestHandler = (req, res, next) => {
    parseFile(req, res, (err: unknown) => {
        if (!err) return next();
        const code = (err as { code?: string }).code;
        if (code === 'LIMIT_FILE_SIZE') return next(new LearningHttpError(413, 'FILE_TOO_LARGE', 'Files can be at most 20 MB'));
        return next(new LearningHttpError(400, 'INVALID_UPLOAD', (err as Error).message || 'Upload failed'));
    });
};

/** Streams the buffer to Cloudinary. */
export function uploadToCloud(file: { buffer: Buffer; originalname: string; mimetype: string }): Promise<UploadedAttachment> {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { resource_type: 'auto', folder: LEARNING_UPLOAD_FOLDER },
            (err: unknown, result: { secure_url?: string; url?: string; public_id?: string } | undefined) => {
                if (err || !result?.public_id) return reject(err ?? new Error('Cloudinary returned no file'));
                resolve({
                    url: result.secure_url ?? result.url ?? '',
                    publicId: result.public_id,
                    fileName: file.originalname,
                    fileType: file.mimetype,
                });
            }
        );
        stream.end(file.buffer);
    });
}
