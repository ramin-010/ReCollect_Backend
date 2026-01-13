import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import AccessRequest from '../models/accessRequestSchema';
import DocModel from '../models/docSchema';
import shareLinkSchema from '../models/shareLinkSchema';
import UserModel from '../models/userSchema';
import ErrorResponse from '../utils/errorResponse';
import { sendAccessRequestEmail, sendAccessApprovedEmail } from '../utils/emailService';

// POST /api/docs/:id/request-access
// Create a new access request (from share link)
export const createAccessRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: docId } = req.params;
    const { shareLinkSlug } = req.body;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    // Verify the share link is valid
    const shareLink = await shareLinkSchema.findOne({
      slug: shareLinkSlug,
      doc: docId,
      expiresAt: { $gt: new Date() }
    });

    if (!shareLink) {
      throw new ErrorResponse(404, 'Share link is invalid or expired');
    }

    // Get the document
    const doc = await DocModel.findById(docId).populate('user', 'name email');
    if (!doc) throw new ErrorResponse(404, 'Document not found');

    // Check if user is owner
    if (doc.user._id.toString() === userId.toString()) {
      throw new ErrorResponse(400, 'You are the owner of this document');
    }

    // Check if user is already a collaborator
    const isCollaborator = doc.collaborators?.some(c => c.user.toString() === userId.toString());
    if (isCollaborator) {
      throw new ErrorResponse(400, 'You are already a collaborator');
    }

    // Check if user is banned
    const isBanned = doc.bannedUsers?.some(b => b.user.toString() === userId.toString());
    if (isBanned) {
      throw new ErrorResponse(403, 'Your access to this document has been revoked');
    }

    // Use findOneAndUpdate with upsert to handle all cases atomically
    const existingRequest = await AccessRequest.findOne({
      user: userId,
      doc: docId,
    });

    if (existingRequest) {
      if (existingRequest.status === 'pending') {
        // Already pending, just return
        return void res.status(200).json({
          success: true,
          message: 'You have already requested access. Please wait for approval.',
          status: 'pending'
        });
      }
      
      // For approved/rejected requests, update to pending (fresh request)
      existingRequest.status = 'pending';
      existingRequest.shareLink = shareLink._id as mongoose.Types.ObjectId;
      existingRequest.role = shareLink.role || 'viewer';
      existingRequest.requestedAt = new Date();
      (existingRequest as any).respondedAt = undefined; // Clear respondedAt
      await existingRequest.save();

      // Get requester info for email
      const requester = await UserModel.findById(userId).select('name email');
      if (!requester) throw new ErrorResponse(404, 'User not found');

      // Send email to owner
      const owner = doc.user as unknown as { _id: mongoose.Types.ObjectId; name: string; email: string };
      await sendAccessRequestEmail(
        { name: owner.name, email: owner.email },
        { name: requester.name, email: requester.email },
        doc.title,
        docId || '',
        (existingRequest._id as mongoose.Types.ObjectId).toString()
      );

      return void res.status(201).json({
        success: true,
        message: 'Access request sent. The owner will be notified.',
        status: 'pending'
      });
    }

    // Create new access request
    const accessRequest = await AccessRequest.create({
      user: userId,
      doc: docId,
      shareLink: shareLink._id,
      role: shareLink.role || 'viewer',
      status: 'pending',
    });

    // Get requester info for email
    const requester = await UserModel.findById(userId).select('name email');
    if (!requester) throw new ErrorResponse(404, 'User not found');

    // Send email to owner
    const owner = doc.user as unknown as { _id: mongoose.Types.ObjectId; name: string; email: string };
    await sendAccessRequestEmail(
      { name: owner.name, email: owner.email },
      { name: requester.name, email: requester.email },
      doc.title,
      docId || '',
      (accessRequest._id as mongoose.Types.ObjectId).toString()
    );

    res.status(201).json({
      success: true,
      message: 'Access request sent. The owner will be notified.',
      status: 'pending'
    });

  } catch (err) {
    next(err);
  }
};

// GET /api/docs/:id/requests
// List pending access requests for a document (owner only)
export const listAccessRequests = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: docId } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    // Verify user is owner
    const doc = await DocModel.findOne({ _id: docId, user: userId });
    if (!doc) throw new ErrorResponse(403, 'Only the document owner can view access requests');

    // Get pending requests
    const requests = await AccessRequest.find({
      doc: docId,
      status: 'pending'
    })
    .populate('user', 'name email avatar')
    .sort({ requestedAt: -1 });

    res.status(200).json({
      success: true,
      data: requests
    });

  } catch (err) {
    next(err);
  }
};

// POST /api/docs/:id/requests/:reqId/approve
// Approve an access request
export const approveAccessRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: docId, reqId } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    // Verify user is owner
    const doc = await DocModel.findOne({ _id: docId, user: userId });
    if (!doc) throw new ErrorResponse(403, 'Only the document owner can approve requests');

    // Get the request
    const accessRequest = await AccessRequest.findOne({
      _id: reqId,
      doc: docId,
      status: 'pending'
    }).populate('user', 'name email');

    if (!accessRequest) throw new ErrorResponse(404, 'Access request not found or already processed');

    // Add user to collaborators
    doc.collaborators.push({
      user: accessRequest.user._id,
      role: accessRequest.role,
      addedAt: new Date()
    });
    await doc.save();

    // Update request status
    accessRequest.status = 'approved';
    accessRequest.respondedAt = new Date();
    await accessRequest.save();

    // Get owner info for email
    const owner = await UserModel.findById(userId).select('name');

    // Send approval email
    const requester = accessRequest.user as unknown as { _id: mongoose.Types.ObjectId; name: string; email: string };
    await sendAccessApprovedEmail(
      { name: requester.name, email: requester.email },
      owner?.name || 'The owner',
      doc.title,
      docId || ''
    );

    res.status(200).json({
      success: true,
      message: 'Access request approved'
    });

  } catch (err) {
    next(err);
  }
};

// POST /api/docs/:id/requests/:reqId/reject
// Reject an access request
export const rejectAccessRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: docId, reqId } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    // Verify user is owner
    const doc = await DocModel.findOne({ _id: docId, user: userId });
    if (!doc) throw new ErrorResponse(403, 'Only the document owner can reject requests');

    // Get and update the request
    const accessRequest = await AccessRequest.findOneAndUpdate(
      { _id: reqId, doc: docId, status: 'pending' },
      { status: 'rejected', respondedAt: new Date() },
      { new: true }
    );

    if (!accessRequest) throw new ErrorResponse(404, 'Access request not found or already processed');

    res.status(200).json({
      success: true,
      message: 'Access request rejected'
    });

  } catch (err) {
    next(err);
  }
};

// GET /api/docs/pending-requests
// Get all pending requests across all documents owned by current user
export const getAllPendingRequests = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    // Get all docs owned by user
    const ownedDocs = await DocModel.find({ user: userId }).select('_id');
    const docIds = ownedDocs.map(d => d._id);

    // Get pending requests for all owned docs
    const requests = await AccessRequest.find({
      doc: { $in: docIds },
      status: 'pending'
    })
    .populate('user', 'name email avatar')
    .populate('doc', 'title')
    .sort({ requestedAt: -1 });

    res.status(200).json({
      success: true,
      data: requests
    });

  } catch (err) {
    next(err);
  }
};
