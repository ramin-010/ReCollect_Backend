/**
 * Typed error for the learning engine.
 *
 * Every pure function in `services/learning` throws this (never a bare
 * Error) so the REST layer can map `code` to an HTTP status without string
 * matching: INVALID_* are 400s, *_NOT_FOUND is a 404, the state conflicts
 * (NOT_PENDING, NOT_DONE, LATER_CYCLE_DONE, ALREADY_STARTED, UNDO_MISMATCH)
 * are 409s.
 */
export type LearningErrorCode =
  | 'INVALID_DAY'
  | 'INVALID_TIME'
  | 'INVALID_TIMEZONE'
  | 'INVALID_INSTANT'
  | 'INVALID_RANGE'
  | 'REVISION_NOT_FOUND'
  | 'MIXED_CHAIN'
  | 'NOT_PENDING'
  | 'NOT_DONE'
  | 'LATER_CYCLE_DONE'
  | 'UNDO_MISMATCH'
  | 'ALREADY_STARTED'
  | 'CATCH_UP_INVALID'
  | 'DEBRIEF_INVALID';

export class LearningError extends Error {
  readonly code: LearningErrorCode;

  constructor(code: LearningErrorCode, message: string) {
    super(message);
    this.name = 'LearningError';
    this.code = code;
  }
}
