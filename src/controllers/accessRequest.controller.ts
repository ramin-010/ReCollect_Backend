// Access requests to docs (Postgres). DB access + emails: src/services/docs/docSharing.service.ts.
// Routes, status codes, messages and JSON shapes are the same as the Mongo version.
import { Request, Response, NextFunction } from 'express';
import ErrorResponse from '../utils/errorResponse';
import { requireUser } from '../middlwares/auth';
import { serializeAccessRequest } from '../db/serializers/docSharing';
import {
  approveDocAccessRequest,
  listPendingAccessRequestsForOwner,
  listPendingDocAccessRequests,
  rejectDocAccessRequest,
  requestDocAccess,
} from '../services/docs/docSharing.service';

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new ErrorResponse(404, 'Document not found');
  return value;
}

export const createAccessRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const outcome = await requestDocAccess(
      routeParam(req, 'id'),
      { id: user.id, name: user.name, email: user.email },
      req.body?.shareLinkSlug
    );

    if (outcome === 'already-pending') {
      return void res.status(200).json({
        success: true,
        message: 'You have already requested access. Please wait for approval.',
        status: 'pending'
      });
    }

    res.status(201).json({
      success: true,
      message: 'Access request sent. The owner will be notified.',
      status: 'pending'
    });
  } catch (err) {
    next(err);
  }
};

export const listAccessRequests = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const requests = await listPendingDocAccessRequests(routeParam(req, 'id'), user.id);

    res.status(200).json({
      success: true,
      data: requests.map(serializeAccessRequest)
    });
  } catch (err) {
    next(err);
  }
};

export const approveAccessRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    await approveDocAccessRequest(routeParam(req, 'id'), routeParam(req, 'reqId'), { id: user.id, name: user.name });

    res.status(200).json({
      success: true,
      message: 'Access request approved'
    });
  } catch (err) {
    next(err);
  }
};

export const rejectAccessRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    await rejectDocAccessRequest(routeParam(req, 'id'), routeParam(req, 'reqId'), user.id);

    res.status(200).json({
      success: true,
      message: 'Access request rejected'
    });
  } catch (err) {
    next(err);
  }
};

export const getAllPendingRequests = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const requests = await listPendingAccessRequestsForOwner(user.id);

    res.status(200).json({
      success: true,
      data: requests.map(serializeAccessRequest)
    });
  } catch (err) {
    next(err);
  }
};
