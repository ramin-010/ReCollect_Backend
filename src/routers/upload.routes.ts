
import express, { RequestHandler } from 'express';
import { upflyUpload } from 'upfly';
import authMiddleware from '../middlwares/auth';
import Doc from '../models/docSchema';

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

router.post('/', authMiddleware, upload as RequestHandler, (async (req, res) => {
    const files = req.files as Record<string, any[]>;
    const imageFiles = files?.['image'];
    const docId = req.body.docId;
    const imageId = req.body.imageId;
    
    if (!imageFiles || imageFiles.length === 0) {
        return res.status(400).json({ error: 'No image file uploaded' });
    }
    
    const uploadedFile = imageFiles[0];
    const { cloudUrl, cloudPublicId, cloudProvider } = uploadedFile;

    if (!cloudUrl) {
        console.error('[Upload] Cloud URL missing in file object:', uploadedFile);
        return res.status(500).json({ error: 'Upload provider failed to return URL' });
    }

    if (docId && imageId) {
        try {
            await Doc.findByIdAndUpdate(docId, {
                $push: {
                    cloudImages: {
                        imageId: imageId,
                        cloudUrl: cloudUrl,
                        cloudPublicId: cloudPublicId,
                    }
                }
            });
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
}) as RequestHandler);

export default router;
