import { Request, Response } from 'express';
import { requireUser } from '../middlwares/auth';
import { serializeRecentVisit } from '../db/serializers/recentVisit';
import {
  isRecentVisitItemType,
  listRecentVisits,
  removeVisit as removeVisitRow,
  trackVisit as trackVisitRow,
} from '../services/recentVisits/recentVisits.service';

/**
 * POST /api/recent-visits
 * Track a visit (upsert: update visitedAt + title if revisiting the same item)
 */
export const trackVisit = async (req: Request, res: Response) => {
  try {
    const user = requireUser(req);
    const { itemId, itemType, title, route } = req.body ?? {};

    if (!itemId || !itemType || !route) {
      return res.status(400).json({ success: false, message: 'itemId, itemType, and route are required' });
    }
    // Mongo stored any string here (update validators were off); the Postgres column is an enum.
    if (!isRecentVisitItemType(itemType)) {
      return res.status(400).json({ success: false, message: 'Invalid itemType' });
    }

    await trackVisitRow(user.id, {
      itemId: String(itemId),
      itemType,
      title: title ? String(title) : undefined,
      route: String(route),
    });

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
    const user = requireUser(req);
    const visits = await listRecentVisits(user.id);
    return res.status(200).json({ success: true, data: visits.map(serializeRecentVisit) });
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
    const user = requireUser(req);
    await removeVisitRow(user.id, String(req.params.itemId));
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Error removing visit:', error);
    return res.status(500).json({ success: false, message: 'Failed to remove visit' });
  }
};
