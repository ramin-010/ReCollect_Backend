import ErrorResponse from "../utils/errorResponse";
import { Request, Response, NextFunction } from "express";
import { mapPrismaError } from "../db/errors";
import { mapLearningError } from "../services/learning/http";
import { AiHttpError } from "../services/claude/errors";

const errorHandler = (err : any, req : Request, res : Response, next: NextFunction) =>{
  // AI routes (/api/recall, /api/ai): { success: false, code, message }. The services log 5xx causes.
  if (err instanceof AiHttpError) {
    res.status(err.statusCode).json({ success: false, code: err.code, message: err.message });
    return;
  }


  // Learning endpoints (LEARNING_SPEC §2): { message, code } with the engine's code → HTTP mapping.
  const learningError = mapLearningError(err);
  if (learningError) {
    if (learningError.statusCode >= 500) console.error(err.stack);
    res.status(learningError.statusCode).json({ message: learningError.message, code: learningError.code });
    return;
  }

    let error = {...err}
   error.message = err.message;

  // Prisma (ported modules): same status codes/messages the Mongo errors below produced.
  // P2002 → 400 duplicate, P2025 → 404, P2003 → 404, validation → 400. See src/db/errors.ts.
  const prismaError = mapPrismaError(err);
  if (prismaError) {
    error = new ErrorResponse(prismaError.statusCode, prismaError.message);
  }

  // Mongoose (modules not ported yet)
  // Mongoose Bad ObjectId
  else if (err.name === 'CastError') {
    const message = `Resource not found with id of ${err.value}`;
    error = new ErrorResponse( 404, message);
  }
  // Mongoose Validation Error
  else if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map((val : any) => val.message);
    error = new ErrorResponse(400,  message.join(", "));
  }
  // Mongoose Duplicate Key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue);
    const message = `Duplicate field value entered: ${field}`;
    error = new ErrorResponse(400, message);
  }

  const statusCode = error.statusCode || 500;
  if (process.env.NODE_ENV === 'production') {
    // Hosting P1-7: a failure's kind and where it happened, never its message (a database error can
    // quote what was sent) and never the request; the request log already has the 4xx.
    if (statusCode >= 500) {
      const frames = String(err?.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 8).join('\n');
      console.error(`[error] ${statusCode} ${req.method} ${(req.originalUrl || '').split('?')[0]} ${err?.name ?? 'Error'}${typeof err?.code === 'string' ? ` ${err.code}` : ''}\n${frames}`);
    }
  } else if (process.env.NODE_ENV !== 'test' || statusCode >= 500) {
    // Tests: keep the output readable; expected 4xx errors are not logged.
    console.error(err.stack);
  }

  // Send response
  res.status(statusCode).json({
    message: error.message || 'Server Error'
  });
}

export default errorHandler;
