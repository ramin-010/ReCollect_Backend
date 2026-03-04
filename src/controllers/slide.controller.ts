import { Request, Response, NextFunction } from 'express';
import SlideDeck from '../models/slideSchema';
import ErrorResponse from '../utils/errorResponse';
import cloudinary from '../utils/cloudinary';
import puppeteer from 'puppeteer';

interface CloudFileOutput {
  cloudUrl: string;
  cloudProvider: string;
  cloudPublicId: string;
}

const deleteFromCloud = async (publicId: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.destroy(publicId, { invalidate: true }, (err: any, result: any) => {
      if (err) {
        console.error("[slide] Cloud deletion error:", err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

const batchDeleteFromCloud = async (publicIds: string[]): Promise<void> => {
  if (publicIds.length === 0) return;
  const deletePromises = publicIds.map(id =>
    deleteFromCloud(id).catch(err => {
      console.error(`[slide] Failed to delete ${id}:`, err);
    })
  );
  await Promise.allSettled(deletePromises);
};

function parseJson<T>(data: any, fallback: T): T {
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return fallback; }
  }
  if (Array.isArray(data)) return data as unknown as T;
  return fallback;
}

/**
 * Extract the first slide + its blocks + connections from full content.
 * Returns a JSON string suitable for preview rendering.
 */
function generateSlidePreview(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (!parsed.slides || !Array.isArray(parsed.slides) || parsed.slides.length === 0) {
      return '';
    }

    // Get first slide by order
    const sortedSlides = [...parsed.slides].sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
    const firstSlide = sortedSlides[0];

    // Get blocks belonging to the first slide
    const firstSlideBlocks = (parsed.blocks || []).filter(
      (b: any) => b.slideId === firstSlide.slideId
    );

    // Get connections belonging to the first slide
    const firstSlideBlockIds = new Set(firstSlideBlocks.map((b: any) => b.blockId));
    const firstSlideConnections = (firstSlide.connections || []).filter(
      (c: any) => firstSlideBlockIds.has(c.fromBlock) || firstSlideBlockIds.has(c.toBlock)
    );

    return JSON.stringify({
      slides: [{ ...firstSlide, connections: firstSlideConnections }],
      blocks: firstSlideBlocks,
    });
  } catch {
    return '';
  }
}

/**
 * Get all slide decks for current user (without content for performance)
 */
export const getAllDecks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    // Use aggregate to exclude heavy 'content' field, return previewContent instead
    const decks = await SlideDeck.aggregate([
      {
        $match: {
          $or: [{ user: userId }, { 'collaborators.user': userId }],
        },
      },
      {
        $project: {
          name: 1,
          previewContent: 1,
          cloudImages: 1,
          isPinned: 1,
          deckType: 1,
          createdAt: 1,
          updatedAt: 1,
          user: 1,
          collaborators: 1,
          shareEnabled: 1,
        },
      },
      { $sort: { updatedAt: -1 } },
    ]);

    // Add role info
    const withRoles = decks.map((deck: any) => ({
      ...deck,
      role: deck.user.toString() === userId.toString() ? 'owner' : 'collaborator',
    }));

    res.status(200).json({ success: true, data: withRoles });
  } catch (err) {
    next(err);
  }
};

/**
 * Get single deck with full content
 */
export const getDeck = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    const deck = await SlideDeck.findOne({
      _id: id,
      $or: [{ user: userId }, { 'collaborators.user': userId }, { admittedViewers: userId }],
    }).lean();

    if (!deck) throw new ErrorResponse(404, 'Slide deck not found');

    const isAdmittedViewer = deck.admittedViewers?.includes(userId.toString());
    const role = deck.user.toString() === userId.toString() ? 'owner' 
      : deck.collaborators?.find(c => c.user.toString() === userId.toString())?.role 
      || (isAdmittedViewer ? 'viewer' : 'viewer');

    res.status(200).json({
      success: true,
      data: { ...deck, role },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Create a new slide deck
 */
export const createDeck = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    const { name } = req.body;

    const newDeck = await SlideDeck.create({
      user: userId,
      name: name || 'Untitled Deck',
      content: '',
      cloudImages: [],
      collaborators: [],
    });

    res.status(201).json({
      success: true,
      data: newDeck.toObject(),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Save deck content with image handling
 */
export const saveDeck = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    const deck = await SlideDeck.findOne({
      _id: id,
      $or: [{ user: userId }, { 'collaborators.user': userId }],
    });

    if (!deck) throw new ErrorResponse(404, 'Slide deck not found');

    const isOwner = deck.user.toString() === userId.toString();
    const collaborator = deck.collaborators?.find(
      c => c.user.toString() === userId.toString()
    );

    if (!isOwner && collaborator?.role === 'viewer') {
      throw new ErrorResponse(403, 'Viewers cannot edit this deck');
    }

    let { content, name, imageFileIds, allImageIds } = req.body;

    imageFileIds = parseJson<string[]>(imageFileIds, []);
    allImageIds = parseJson<string[]>(allImageIds, []);

    console.log(`[Slide API] SAVE ${id} | images: ${imageFileIds.length} new, ${allImageIds.length} total`);

    // Process uploaded images
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const newCloudImages: { imageId: string; cloudUrl: string; cloudPublicId: string }[] = [];
    const imageUrlMap: Record<string, { url: string; publicId: string }> = {};

    if (files && imageFileIds.length > 0) {
      for (const imageId of imageFileIds) {
        const fieldName = `image_${imageId}`;
        const fileArray = files[fieldName];
        if (fileArray && fileArray.length > 0) {
          const file = fileArray[0] as unknown as CloudFileOutput;
          if (file.cloudUrl && file.cloudPublicId) {
            imageUrlMap[imageId] = {
              url: file.cloudUrl,
              publicId: file.cloudPublicId,
            };
            newCloudImages.push({
              imageId,
              cloudUrl: file.cloudUrl,
              cloudPublicId: file.cloudPublicId,
            });
          }
        }
      }
    }

    // Replace URLs in content
    if (content && Object.keys(imageUrlMap).length > 0) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.blocks && Array.isArray(parsed.blocks)) {
          let updated = false;
          parsed.blocks.forEach((block: any) => {
            if (block.type === 'image' && typeof block.imageId === 'string') {
              const imageData = imageUrlMap[block.imageId];
              if (imageData) {
                block.url = imageData.url;
                block.isUploaded = true;
                updated = true;
              }
            }
          });
          if (updated) {
            content = JSON.stringify(parsed);
          }
        }
      } catch (err) {
        console.error('[Slide API] Failed to parse content for image URL replacement:', err);
      }
    }

    // Cleanup orphaned images
    const currentImageIds = new Set(allImageIds);
    const existingCloudImages = deck.cloudImages || [];
    const imagesToDelete: typeof existingCloudImages = [];
    const imagesToRetain: typeof existingCloudImages = [];

    for (const img of existingCloudImages) {
      if (currentImageIds.has(img.imageId)) {
        imagesToRetain.push(img);
      } else {
        imagesToDelete.push(img);
      }
    }

    console.log(`[Slide API] SAVE ${id} | CLEANUP | existing: ${existingCloudImages.length}, retain: ${imagesToRetain.length}, delete: ${imagesToDelete.length}, new: ${newCloudImages.length}`);

    if (imagesToDelete.length > 0) {
      const publicIds = imagesToDelete.map(img => img.cloudPublicId);
      await batchDeleteFromCloud(publicIds);
      console.log(`[Slide API] SAVE ${id} | Deleted ${publicIds.length} orphaned images`);
    }

    const finalCloudImages = [...imagesToRetain, ...newCloudImages];

    // Build update
    const updateData: any = {
      updatedAt: new Date(),
      cloudImages: finalCloudImages,
    };
    if (content !== undefined) {
      updateData.content = content;
      // Generate lightweight preview from the first slide
      updateData.previewContent = generateSlidePreview(content);
    }
    if (name !== undefined) updateData.name = name;

    const updatedDeck = await SlideDeck.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).lean();

    if (!updatedDeck) throw new ErrorResponse(404, 'Slide deck not found');

    console.log(`[Slide API] SAVE ${id} | Success | cloudImages: ${finalCloudImages.length}`);

    res.status(200).json({
      success: true,
      data: updatedDeck,
      imageUrlMap,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Update deck metadata (name)
 */
export const updateDeck = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    const { name, isPinned, deckType } = req.body;

    const updates: any = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name;
    if (isPinned !== undefined) updates.isPinned = isPinned;
    if (deckType !== undefined) updates.deckType = deckType;

    const deck = await SlideDeck.findOneAndUpdate(
      { _id: id, user: userId },
      updates,
      { new: true, runValidators: true }
    ).lean();

    if (!deck) throw new ErrorResponse(404, 'Slide deck not found or not authorized');

    res.status(200).json({ success: true, data: deck });
  } catch (err) {
    next(err);
  }
};

/**
 * Delete deck with full cloud image cleanup
 */
export const deleteDeck = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    const deck = await SlideDeck.findOne({ _id: id, user: userId });
    if (!deck) throw new ErrorResponse(404, 'Slide deck not found or not authorized');

    // Cleanup all cloud images
    if (deck.cloudImages && deck.cloudImages.length > 0) {
      const publicIds = deck.cloudImages.map(img => img.cloudPublicId);
      console.log(`[Slide API] DELETE ${id} | Cleaning ${publicIds.length} cloud images`);
      await batchDeleteFromCloud(publicIds);
    }

    await SlideDeck.findByIdAndDelete(id);
    console.log(`[Slide API] DELETE ${id} | Complete`);

    res.status(200).json({
      success: true,
      message: 'Slide deck deleted successfully',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Export presentation deck as PDF using Puppeteer
 */
export const exportDeckPdf = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  let browser;
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    // 1. Verify access
    const deck = await SlideDeck.findOne({
      _id: id,
      $or: [{ user: userId }, { 'collaborators.user': userId }],
    }).lean();

    if (!deck) throw new ErrorResponse(404, 'Slide deck not found');

    // 2. Launch Puppeteer
    console.log(`[Slide API] EXPORT PDF ${id} | Launching headless browser...`);
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    // Inject auth cookie so the headless browser can authenticate backend GET requests
    const token = req.cookies?.token;
    if (token) {
      const frontendUrlStr = process.env.FRONTEND_URL || 'http://localhost:3005';
      const frontendUrlObject = new URL(frontendUrlStr);
      await page.setCookie({
        name: 'token',
        value: token,
        domain: frontendUrlObject.hostname,
        path: '/',
        httpOnly: true,
      });
      
      // Also inject for localhost if the backend is accessed via localhost
      await page.setCookie({
        name: 'token',
        value: token,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
      });
    }

    // Use desktop viewport to ensure standard slide width scaling
    await page.setViewport({ width: 1280, height: 800 });

    // 3. Navigate to dedicated frontend print route (no UI chrome)
    const frontendBase = process.env.FRONTEND_URL || 'http://localhost:3005';
    const frontendUrl = `${frontendBase}/print/slides/${id}`;
    console.log(`[Slide API] EXPORT PDF ${id} | Navigating to ${frontendUrl}`);
    
    await page.goto(frontendUrl, { 
      waitUntil: 'networkidle0', 
      timeout: 30000 
    });

    // 4. Wait extra time for the 150ms connection delay and internal fonts to fully settle
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 5. Generate PDF
    console.log(`[Slide API] EXPORT PDF ${id} | Generating PDF buffer...`);
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true, // Crucial for slide background colors and block colors
      landscape: true,       // Gamma-style slide layout
      margin: { top: 0, right: 0, bottom: 0, left: 0 } // Full bleed
    });

    console.log(`[Slide API] EXPORT PDF ${id} | Success! Sending ${pdfBuffer.length} bytes.`);

    // 6. Send as file attachment
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${deck.name || 'presentation'}.pdf"`);
    res.end(pdfBuffer);

  } catch (err) {
    console.error('[Slide API] EXPORT PDF Error:', err);
    next(new ErrorResponse(500, 'Failed to generate PDF export'));
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};
