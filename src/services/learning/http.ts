/**
 * HTTP mapping for learning errors (LEARNING_SPEC §2 "LearningError mapping").
 * Pure: no Express. `errorHandler` answers `{ message, code }` with
 * `learningErrorStatus(err.code)` for a LearningError, and with the given
 * status for a LearningHttpError (the DB layer's own 400/404/409s).
 */
import ErrorResponse from '../../utils/errorResponse';
import { LearningError, type LearningErrorCode } from './errors';

/** INVALID_* / CATCH_UP_INVALID / DEBRIEF_INVALID → 400, REVISION_NOT_FOUND → 404, state conflicts → 409, MIXED_CHAIN → 500. */
export function learningErrorStatus(code: LearningErrorCode): number {
  switch (code) {
    case 'INVALID_DAY':
    case 'INVALID_TIME':
    case 'INVALID_TIMEZONE':
    case 'INVALID_INSTANT':
    case 'INVALID_RANGE':
    case 'CATCH_UP_INVALID':
    case 'DEBRIEF_INVALID':
      return 400;
    case 'REVISION_NOT_FOUND':
      return 404;
    case 'NOT_PENDING':
    case 'NOT_DONE':
    case 'LATER_CYCLE_DONE':
    case 'ALREADY_STARTED':
    case 'UNDO_MISMATCH':
      return 409;
    case 'MIXED_CHAIN':
      return 500;
    default:
      return 500;
  }
}

/** An HTTP error from the learning endpoints that carries a machine-readable `code`. */
export class LearningHttpError extends ErrorResponse {
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(statusCode, message);
    this.code = code;
  }
}

/** Not-owned and missing ids are both 404 `Not found` (never 403). */
export function notFound(): LearningHttpError {
  return new LearningHttpError(404, 'NOT_FOUND', 'Not found');
}

export function badRequest(message: string, code = 'INVALID_INPUT'): LearningHttpError {
  return new LearningHttpError(400, code, message);
}

export function conflict(message: string, code: string): LearningHttpError {
  return new LearningHttpError(409, code, message);
}

/** `{ statusCode, message, code }` for a learning error, or null for anything else. */
export function mapLearningError(err: unknown): { statusCode: number; message: string; code: string } | null {
  if (err instanceof LearningError) return { statusCode: learningErrorStatus(err.code), message: err.message, code: err.code };
  if (err instanceof LearningHttpError) return { statusCode: err.statusCode, message: err.message, code: err.code };
  return null;
}
