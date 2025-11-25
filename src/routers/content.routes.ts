import { addContent, updateContent, deleteContent } from '../controllers/content.controller';
import authMiddleware from '../middlwares/auth'
import express, { RequestHandler } from 'express';
import { upflyUpload } from 'upfly'
const router = express.Router();

const cloud_name = process.env.CLOUDINARY_CLOUD_NAME || '';
const cloud_key = process.env.CLOUDINARY_API_KEY || '';
const cloud_secret = process.env.CLOUDINARY_API_SECRET || '';


const upload = upflyUpload({
    fields: {
        "image_*": {
            output: 'memory',
            format: 'webp',
            quality: 50,
            cloudStorage: true,
            cloudProvider: "cloudinary",
            cloudConfig: {
                cloud_name: cloud_name,
                api_key: cloud_key,
                api_secret: cloud_secret,
                folder: 'test-uploads'
            }
        },

    },
});

router.post('/add-content', authMiddleware, upload as RequestHandler, addContent as unknown as RequestHandler);
router.patch('/update-content/:id', authMiddleware, updateContent)
router.delete('/delete-content/:id', authMiddleware, deleteContent)

export default router;