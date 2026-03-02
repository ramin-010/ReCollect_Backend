import { Request, Response, NextFunction } from 'express';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import ErrorResponse from '../utils/errorResponse';
import SlideDeck from '../models/slideSchema';

export const getLiveKitToken = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const { room } = req.query; // e.g., ?room=deck_12345
    const userId = req.user?._id?.toString();
    const userName = req.user?.name || 'Anonymous User';

    if (!userId) {
      throw new ErrorResponse(401, 'Unauthorized');
    }

    if (!room || typeof room !== 'string') {
      throw new ErrorResponse(400, 'Room name is required');
    }

    // 1. Fetch the Deck to determine ownership
    const deck = await SlideDeck.findById(room).populate('collaborators.user');
    if (!deck) {
      throw new ErrorResponse(404, 'Slide deck not found');
    }

    // 2. Determine if requester is the literal Owner of the deck
    const isOwner = deck.user.toString() === userId;

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: userId,
        name: userName,
      }
    );

    const isAdmitted = deck.admittedViewers?.includes(userId);

    if (isOwner) {
      // 3a. Owner is fully admitted instantly
      at.addGrant({ 
        roomJoin: true, 
        room, 
        canPublish: true, 
        canSubscribe: true 
      });
    } else if (isAdmitted) {
      // 3b. Viewer has already been admitted by the host. Upgrade their token permanently.
      at.addGrant({ 
        roomJoin: true, 
        room, 
        canPublish: false, 
        canSubscribe: true 
      });
    } else {
      // 3c. Viewers are NOT admitted by default in this endpoint.
      // They must use a waiting room signaling process. We generate a token
      // with no roomJoin rights just to establish an identity if needed, 
      // but usually the waiting room handles signaling externally.
      // To keep things clean, we will just return a role flag. Wait for the admit endpoint to give a real token.
      res.status(200).json({ 
         success: true, 
         role: 'viewer', 
         message: 'Waiting for host to admit you.' 
      });
      return;
    }

    const token = await at.toJwt();

    res.status(200).json({ success: true, token, role: isOwner ? 'owner' : 'viewer' });
  } catch (err) {
    next(err);
  }
};

export const admitViewer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { room, viewerIdentity, viewerName } = req.body;
    const userId = req.user?._id?.toString();

    if (!userId || !room || !viewerIdentity) {
      throw new ErrorResponse(400, 'Missing required fields for admission');
    }

    // 1. Verify the requester is actually the Owner/Admin of this room
    const deck = await SlideDeck.findById(room).populate('collaborators.user');
    if (!deck) {
      throw new ErrorResponse(404, 'Slide deck not found');
    }

    const isOwner = deck.user.toString() === userId || 
                    deck.collaborators?.some((c: any) => c.user?.toString() === userId);

    if (!isOwner) {
       throw new ErrorResponse(403, 'Only the presenter can admit viewers');
    }

    // 2. Generate a valid Subscribe-Only token for the Viewer
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: viewerIdentity,
        name: viewerName || 'Guest Viewer',
      }
    );

    // Viewers can join and subscribe, but CANNOT publish video/audio
    at.addGrant({ 
      roomJoin: true, 
      room, 
      canPublish: false, 
      canSubscribe: true 
    });

    // 3. Save their admission status to the DB so future polling requests see it
    await SlideDeck.findByIdAndUpdate(room, { $addToSet: { admittedViewers: viewerIdentity } });

    const token = await at.toJwt();

    res.status(200).json({ success: true, token });
  } catch (err) {
    next(err);
  }
};

export const knockOnRoom = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
   try {
     const { room } = req.body;
     const userId = req.user?._id?.toString();
     const userName = req.user?.name || 'Guest Viewer';
 
     if (!userId || !room) {
       throw new ErrorResponse(400, 'Missing required fields to knock');
     }
 
     // We assume LIVEKIT_URL exists. The backend .env should have LIVEKIT_URL=wss://...
     const livekitUrl = process.env.LIVEKIT_URL;
     if (!livekitUrl) {
       throw new ErrorResponse(500, 'Backend is missing LIVEKIT_URL configuration');
     }
 
     const roomService = new RoomServiceClient(
       livekitUrl,
       process.env.LIVEKIT_API_KEY,
       process.env.LIVEKIT_API_SECRET
     );
 
     // Construct the payload expected by the PresenterControls
     const payload = JSON.stringify({
       type: 'KNOCK',
       identity: userId,
       name: userName
     });
     
     const encoder = new TextEncoder();
     const data = encoder.encode(payload);
 
     // DataPacket_Kind.RELIABLE = 0
     await roomService.sendData(room, data, 0, { topic: 'admissions' });
 
     res.status(200).json({ success: true, message: 'Knock sent successfully' });
   } catch (err) {
     next(err);
   }
};
