// Errors of the AI routes (/api/recall, /api/ai). errorHandler answers them as
// `{ success: false, code, message }` with their status; recollect/lib/api/recallApi.ts reads
// `code` (AI_NOT_CONFIGURED, AI_CAP_REACHED, NO_CONTENT) and the status.
import ErrorResponse from '../../utils/errorResponse';

export class AiHttpError extends ErrorResponse {
    readonly code: string;

    constructor(statusCode: number, code: string, message: string) {
        super(statusCode, message);
        this.code = code;
        this.name = 'AiHttpError';
    }
}

/** 503: no CLAUDE_API_KEY on the server (or Anthropic rejected it). */
export function aiNotConfigured(message = 'The AI is not set up on this server yet.'): AiHttpError {
    return new AiHttpError(503, 'AI_NOT_CONFIGURED', message);
}

/** 402: this month's spend has reached the user's cap. */
export function aiCapReached(spentUsd: number, capUsd: number): AiHttpError {
    return new AiHttpError(
        402,
        'AI_CAP_REACHED',
        `This month's AI spend ($${spentUsd.toFixed(2)}) has reached your cap ($${capUsd.toFixed(2)}). Raise it in Settings, or wait for next month.`
    );
}

/** 422: too little text to ask about. */
export function noContent(): AiHttpError {
    return new AiHttpError(422, 'NO_CONTENT', 'This has too little in it to ask about yet. Add your notes first.');
}

/** 502: the model call failed, was declined, or returned something unusable. */
export function aiFailed(message = 'The AI could not answer just now. Try again.', code = 'AI_FAILED'): AiHttpError {
    return new AiHttpError(502, code, message);
}

export const aiNotFound = (message = 'Not found'): AiHttpError => new AiHttpError(404, 'NOT_FOUND', message);
export const aiBadRequest = (message: string, code = 'INVALID_INPUT'): AiHttpError => new AiHttpError(400, code, message);
export const aiConflict = (message: string, code: string): AiHttpError => new AiHttpError(409, code, message);
