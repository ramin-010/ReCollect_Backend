import { Request, Response } from 'express';
import RecentVisit from '../models/recentVisitSchema';

const MAX_RECENT_VISITS = 20;

/**
 * POST /api/recent-visits
 * Track a visit (upsert: update visitedAt + title if revisiting the same item)
 */
export const trackVisit = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { itemId, itemType, title, route } = req.body;

    if (!itemId || !itemType || !route) {
      return res.status(400).json({ success: false, message: 'itemId, itemType, and route are required' });
    }

    // Upsert: if item already visited, just update visitedAt and title
    await RecentVisit.findOneAndUpdate(
      { user: userId, itemId },
      {
        $set: {
          itemType,
          title: title || 'Untitled',
          route,
          visitedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    // Cap at MAX_RECENT_VISITS: delete oldest entries beyond the limit
    const count = await RecentVisit.countDocuments({ user: userId });
    if (count > MAX_RECENT_VISITS) {
      const oldest = await RecentVisit.find({ user: userId })
        .sort({ visitedAt: -1 })
        .skip(MAX_RECENT_VISITS)
        .select('_id');
      
      if (oldest.length > 0) {
        await RecentVisit.deleteMany({
          _id: { $in: oldest.map((v) => v._id) },
        });
      }
    }

    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Error tracking visit:', error);
    return res.status(500).json({ success: false, message: 'Failed to track visit' });
  }
};

/**
 * GET /api/recent-visits
 * Get the user's recent visits sorted by visitedAt desc
 */
export const getRecentVisits = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;

    const visits = await RecentVisit.find({ user: userId })
      .sort({ visitedAt: -1 })
      .limit(MAX_RECENT_VISITS)
      .lean();

    return res.status(200).json({ success: true, data: visits });
  } catch (error: any) {
    console.error('Error fetching recent visits:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch recent visits' });
  }
};

/**
 * DELETE /api/recent-visits/:itemId
 * Remove a specific visit (e.g. when item is deleted)
 */
export const removeVisit = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { itemId } = req.params;

    await RecentVisit.findOneAndDelete({ user: userId, itemId });

    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Error removing visit:', error);
    return res.status(500).json({ success: false, message: 'Failed to remove visit' });
  }
};
