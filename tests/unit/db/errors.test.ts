// Prisma error → HTTP mapping, and the Express error handler that uses it. No database needed:
// the error objects are built by hand with the shapes Prisma 7 + @prisma/adapter-pg produce.
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { isRecordNotFound, isUniqueViolation, mapPrismaError, uniqueViolationFields } from '../../../src/db/errors';
import errorHandler from '../../../src/middlwares/errorHandler';
import ErrorResponse from '../../../src/utils/errorResponse';

const known = (code: string, meta?: Record<string, unknown>, message = 'Prisma error') =>
    new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: '7.8.0', ...(meta ? { meta } : {}) });

const adapterUnique = (fields: string[]) =>
    known('P2002', {
        modelName: 'User',
        driverAdapterError: { name: 'DriverAdapterError', cause: { kind: 'UniqueConstraintViolation', constraint: { fields } } },
    });

describe('mapPrismaError', () => {
    it('P2002 → 400 "Duplicate field value entered: <fields>" (Mongo 11000)', () => {
        expect(mapPrismaError(adapterUnique(['email']))).toEqual({ statusCode: 400, message: 'Duplicate field value entered: email' });
        expect(mapPrismaError(known('P2002', { target: ['userId', 'docId'] }))).toEqual({
            statusCode: 400,
            message: 'Duplicate field value entered: userId,docId',
        });
        expect(uniqueViolationFields(known('P2002', undefined, 'Unique constraint failed on the fields: (`slug`)'))).toEqual(['slug']);
    });

    it('P2025 / P2003 → 404 (Mongo CastError / unknown id)', () => {
        expect(mapPrismaError(known('P2025', { modelName: 'Doc', operation: 'an update' }))).toEqual({ statusCode: 404, message: 'Resource not found' });
        expect(mapPrismaError(known('P2003'))).toEqual({ statusCode: 404, message: 'Related resource not found' });
    });

    it('P2000 and validation errors → 400 (Mongoose ValidationError)', () => {
        expect(mapPrismaError(known('P2000'))?.statusCode).toBe(400);
        const validation = new Prisma.PrismaClientValidationError(
            'Invalid `prisma.todo.findMany()` invocation:\n\n  { where: { status: "bogus" } }\n\nInvalid value for argument `status`. Expected TodoStatus.',
            { clientVersion: '7.8.0' }
        );
        expect(mapPrismaError(validation)).toEqual({ statusCode: 400, message: 'Invalid value for argument `status`. Expected TodoStatus.' });
    });

    it('other Prisma codes → 500 without leaking the raw message; non-Prisma errors → null', () => {
        expect(mapPrismaError(known('P2034', undefined, 'secret query details'))).toEqual({ statusCode: 500, message: 'Database error (P2034)' });
        expect(mapPrismaError(new Error('boom'))).toBeNull();
        expect(mapPrismaError(new ErrorResponse(400, 'x'))).toBeNull();
    });

    it('helpers', () => {
        expect(isUniqueViolation(adapterUnique(['email']), 'email')).toBe(true);
        expect(isUniqueViolation(adapterUnique(['email']), 'reminderEmail')).toBe(false);
        expect(isRecordNotFound(known('P2025'))).toBe(true);
        expect(isRecordNotFound(known('P2002'))).toBe(false);
    });
});

describe('errorHandler', () => {
    function run(err: unknown) {
        const res: any = { statusCode: 0, body: undefined };
        res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
        res.json = vi.fn((body: unknown) => { res.body = body; return res; });
        errorHandler(err, {} as any, res, vi.fn());
        return { status: res.statusCode, body: res.body };
    }

    it('keeps ErrorResponse status/message', () => {
        expect(run(new ErrorResponse(403, 'Only admins can invite members'))).toEqual({ status: 403, body: { message: 'Only admins can invite members' } });
    });

    it('maps Prisma errors', () => {
        expect(run(adapterUnique(['email']))).toEqual({ status: 400, body: { message: 'Duplicate field value entered: email' } });
        expect(run(known('P2025'))).toEqual({ status: 404, body: { message: 'Resource not found' } });
    });

    it('still maps Mongo errors for modules that are not ported yet', () => {
        expect(run(Object.assign(new Error('cast'), { name: 'CastError', value: 'abc' }))).toEqual({
            status: 404,
            body: { message: 'Resource not found with id of abc' },
        });
        expect(run(Object.assign(new Error('dup'), { code: 11000, keyValue: { email: 'a@b.c' } }))).toEqual({
            status: 400,
            body: { message: 'Duplicate field value entered: email' },
        });
        expect(
            run(Object.assign(new Error('val'), { name: 'ValidationError', errors: { a: { message: 'A bad' }, b: { message: 'B bad' } } }))
        ).toEqual({ status: 400, body: { message: 'A bad, B bad' } });
    });

    it('defaults to 500 with the error message', () => {
        expect(run(new Error('Unexpected'))).toEqual({ status: 500, body: { message: 'Unexpected' } });
    });
});
