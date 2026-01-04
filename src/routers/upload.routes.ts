
import express, { RequestHandler } from 'express';
import { upflyUpload } from 'upfly';
import authMiddleware from '../middlwares/auth';

const router = express.Router();

const cloud_name = process.env.CLOUDINARY_CLOUD_NAME || '';
const cloud_key = process.env.CLOUDINARY_API_KEY || '';
const cloud_secret = process.env.CLOUDINARY_API_SECRET || '';

// Upfly middleware standalone for uploads
const upload = upflyUpload({
  fields: {
    "image": {
      output: 'memory',
      format: 'webp',
      quality: 60,
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

// POST /api/upload
// Accepts multipart/form-data with field 'image'
router.post('/', authMiddleware, upload as RequestHandler, ((req, res) => {
    // Upfly likely adds the URL to the body with the field name
    // Or if output is memory, it might behave differently.
    // Based on usage in other files, it seems to work.
    // Assuming upfly puts url in req.body.image (string)
    
    // Upfly (via Multer) adds 'files' to request.
    // The configured field is "image".
    const files = req.files as Record<string, any[]>;
    const imageFiles = files?.['image'];
    
    console.log('Files:', files);
    console.log('Image Files:', imageFiles);
    
    if (!imageFiles || imageFiles.length === 0) {
        return res.status(400).json({ error: 'No image file uploaded' });
    }
    
    // Upfly adds cloudUrl to the file object
    const uploadedFile = imageFiles[0];
    const imageUrl = uploadedFile.cloudUrl;

    if (!imageUrl) {
        console.error('[Upload] Cloud URL missing in file object:', uploadedFile);
        return res.status(500).json({ error: 'Upload provider failed to return URL' });
    }

    return res.status(200).json({ url: imageUrl });
}) as RequestHandler);

export default router;
