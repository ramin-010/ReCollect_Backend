const cloudinary = require('cloudinary').v2;
require('dotenv').config();

cloudinary.config({
    cloud_name : process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret : process.env.CLOUDINARY_API_SECRET
})

/**
 * Delete one asset from Cloudinary. Rejects if Cloudinary reports an error.
 * (Moved here unchanged from the cut content controller; used by user avatars and doc images.)
 */
export const deleteFromCloud = async (publicId: string): Promise<void> => {
    try {
        console.log("Deleting from cloud:", publicId);
        return new Promise((resolve, reject) => {
            cloudinary.uploader.destroy(publicId, { invalidate: true }, (err: any, result: any) => {
                if (err) {
                    console.error("Cloud deletion error:", err);
                    reject(err);
                } else {
                    console.log("Cloud deletion result:", result);
                    resolve();
                }
            });
        });
    } catch (error) {
        console.error("Failed to delete from cloud:", publicId, error);
        throw error;
    }
}

/** Delete many assets; individual failures are logged and never thrown. */
export const batchDeleteFromCloud = async (publicIds: string[]): Promise<void> => {
    if (publicIds.length === 0) return;

    const deletePromises = publicIds.map(id =>
        deleteFromCloud(id).catch(err => {
            console.error(`Failed to delete ${id}:`, err);
        })
    );

    await Promise.allSettled(deletePromises);
}

export default cloudinary;
