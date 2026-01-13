import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import AccessRequest from '../models/accessRequestSchema';
import DocModel from '../models/docSchema';
import shareLinkSchema from '../models/shareLinkSchema';
import UserModel from '../models/userSchema';
import ErrorResponse from '../utils/errorResponse';
import { sendAccessRequestEmail, sendAccessApprovedEmail } from '../utils/emailService';

export const createAccessRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: docId } = req.params;
    const { shareLinkSlug } = req.body;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

        const shareLink = await shareLinkSchema.findOne({
      slug: shareLinkSlug,
      doc: docId,
      expiresAt: { $gt: new Date() }
    });

    if (!shareLink) {
      throw new ErrorResponse(404, 'Share link is invalid or expired');
    }

        const doc = await DocModel.findById(docId).populate('user', 'name email');
    if (!doc) throw new ErrorResponse(404, 'Document not found');

        if (doc.user._id.toString() === userId.toString()) {
      throw new ErrorResponse(400, 'You are the owner of this document');
    }

        const isCollaborator = doc.collaborators?.some(c => c.user.toString() === userId.toString());
    if (isCollaborator) {
      throw new ErrorResponse(400, 'You are already a collaborator');
    }

        const isBanned = doc.bannedUsers?.some(b => b.user.toString() === userId.toString());
    if (isBanned) {
      throw new ErrorResponse(403, 'Your access to this document has been revoked');
    }

        const existingRequest = await AccessRequest.findOne({
      user: userId,
      doc: docId,
    });

    if (existingRequest) {
      if (existingRequest.status === 'pending') {
                return void res.status(200).json({
          success: true,
          message: 'You have already requested access. Please wait for approval.',
          status: 'pending'
        });
      }
      
            existingRequest.status = 'pending';
      existingRequest.shareLink = shareLink._id as mongoose.Types.ObjectId;
      existingRequest.role = shareLink.role || 'viewer';
      existingRequest.requestedAt = new Date();
      (existingRequest as any).respondedAt = undefined;       await existingRequest.save();

            const requester = await UserModel.findById(userId).select('name email');
      if (!requester) throw new ErrorResponse(404, 'User not found');

            const owner = doc.user as unknown as { _id: mongoose.Types.ObjectId; name: string; email: string };
      sendAccessRequestEmail(
        { name: owner.name, email: owner.email },
        { name: requester.name, email: requester.email },
        doc.title,
        docId || '',
        (existingRequest._id as mongoose.Types.ObjectId).toString()
      ).catch(err => console.error('Failed to send access request email:', err));

      return void res.status(201).json({
        success: true,
        message: 'Access request sent. The owner will be notified.',
        status: 'pending'
      });
    }

        const accessRequest = await AccessRequest.create({
      user: userId,
      doc: docId,
      shareLink: shareLink._id,
      role: shareLink.role || 'viewer',
      status: 'pending',
    });

        const requester = await UserModel.findById(userId).select('name email');
    if (!requester) throw new ErrorResponse(404, 'User not found');

        const owner = doc.user as unknown as { _id: mongoose.Types.ObjectId; name: string; email: string };
    sendAccessRequestEmail(
      { name: owner.name, email: owner.email },
      { name: requester.name, email: requester.email },
      doc.title,
      docId || '',
      (accessRequest._id as mongoose.Types.ObjectId).toString()
    ).catch(err => console.error('Failed to send access request email:', err));

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
    const { id: docId } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

        const doc = await DocModel.findOne({ _id: docId, user: userId });
    if (!doc) throw new ErrorResponse(403, 'Only the document owner can view access requests');

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

export const approveAccessRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: docId, reqId } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

        const doc = await DocModel.findOne({ _id: docId, user: userId });
    if (!doc) throw new ErrorResponse(403, 'Only the document owner can approve requests');

        const accessRequest = await AccessRequest.findOne({
      _id: reqId,
      doc: docId,
      status: 'pending'
    }).populate('user', 'name email');

    if (!accessRequest) throw new ErrorResponse(404, 'Access request not found or already processed');

        doc.collaborators.push({
      user: accessRequest.user._id,
      role: accessRequest.role,
      addedAt: new Date()
    });
    await doc.save();

        accessRequest.status = 'approved';
    accessRequest.respondedAt = new Date();
    await accessRequest.save();

        const owner = await UserModel.findById(userId).select('name');

        const requester = accessRequest.user as unknown as { _id: mongoose.Types.ObjectId; name: string; email: string };
    sendAccessApprovedEmail(
      { name: requester.name, email: requester.email },
      owner?.name || 'The owner',
      doc.title,
      docId || ''
    ).catch(err => console.error('Failed to send approval email:', err));

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
    const { id: docId, reqId } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

        const doc = await DocModel.findOne({ _id: docId, user: userId });
    if (!doc) throw new ErrorResponse(403, 'Only the document owner can reject requests');

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

export const getAllPendingRequests = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

        const ownedDocs = await DocModel.find({ user: userId }).select('_id');
    const docIds = ownedDocs.map(d => d._id);

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
