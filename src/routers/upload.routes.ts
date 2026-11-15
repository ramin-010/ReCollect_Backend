// POST /api/collab/upload — image upload from the live (collaborative) doc editor. The image goes
// to Cloudinary (upfly); when docId + imageId are sent, it is also recorded in Doc.cloudImages so the
// Hocuspocus cleanup can delete it once the doc no longer uses it (src/services/docs/docs.service.ts).
import express, { RequestHandler } from 'express';
import { upflyUpload } from 'upfly';
import authMiddleware, { requireUser } from '../middlwares/auth';
import { appendDocCloudImage } from '../services/docs/docs.service';
import type { UploadedFiles } from '../services/uploads/cloudImages';

const router = express.Router();

const cloud_name = process.env.CLOUDINARY_CLOUD_NAME || '';
const cloud_key = process.env.CLOUDINARY_API_KEY || '';
const cloud_secret = process.env.CLOUDINARY_API_SECRET || '';

const upload = upflyUpload({
  fields: {
    "image": {
      output: 'memory',
      format: 'webp',
      quality: 50,
      cloudStorage: true,
      cloudProvider: "cloudinary",
      cloudConfig: {
        cloud_name: cloud_name,
        api_key: cloud_key,
        api_secret: cloud_secret,
        folder: 'recollect-collab-uploads-temp'
      }
    },
  },
});

router.post('/', authMiddleware, upload as RequestHandler, (async (req, res, next) => {
  try {
    const user = requireUser(req);
    const files = req.files as unknown as UploadedFiles | undefined;
    const imageFiles = files?.['image'];
    const docId: unknown = req.body?.docId;
    const imageId: unknown = req.body?.imageId;

    if (!imageFiles || imageFiles.length === 0) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    const { cloudUrl, cloudPublicId, cloudProvider } = imageFiles[0]!;
    // upfly skips a file it can't convert (a broken or unsupported image): that is the sender's
    // file, not a server failure.
    const meta = (imageFiles[0] as { _metadata?: { isSkipped?: boolean } })._metadata;
    if (!cloudUrl && meta?.isSkipped) {
      return res.status(400).json({ error: 'The image could not be read. Try another file (PNG, JPEG, WebP or GIF).' });
    }

    if (!cloudUrl) {
      console.error('[Upload] Cloud URL missing in file object:', imageFiles[0]);
      return res.status(500).json({ error: 'Upload provider failed to return URL' });
    }

    if (typeof docId === 'string' && docId && typeof imageId === 'string' && imageId && cloudPublicId) {
      try {
        // Recorded only when the user may edit the doc (the Mongo route let anyone append).
        const recorded = await appendDocCloudImage(docId, user.id, { imageId, cloudUrl, cloudPublicId });
        if (!recorded) console.warn(`[Upload] Image ${imageId} not recorded on doc ${docId} (not found or no edit access)`);
      } catch (err) {
        console.error('[Upload] Failed to update cloudImages:', err);
      }
    }

    return res.status(200).json({
      url: cloudUrl,
      publicId: cloudPublicId,
      provider: cloudProvider,
      imageId: imageId,
    });
  } catch (err) {
    next(err);
  }
}) as RequestHandler);

export default router;
