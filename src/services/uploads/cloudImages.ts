// Cloudinary image bookkeeping for docs (pure functions, no database).
//
// Docs list the Cloudinary images they use in a Json column `cloudImages`:
// [{ imageId, cloudUrl, cloudPublicId }]. `imageId` is the editor's id for the image (the TipTap
// node attr `imageId`). On save the client sends the ids it still uses; stored images missing
// from that list are orphans and get deleted from Cloudinary.

/** One entry of a `cloudImages` Json column. (A type alias, so it is assignable to Prisma's Json input.) */
export type CloudImage = { imageId: string; cloudUrl: string; cloudPublicId: string };

/** A file as upfly leaves it on req.files after uploading it to Cloudinary. */
export interface UploadedCloudFile {
    cloudUrl?: string | undefined;
    cloudPublicId?: string | undefined;
    cloudProvider?: string | undefined;
}

/** req.files of an upfly upload: field name → files. */
export type UploadedFiles = Record<string, UploadedCloudFile[] | undefined>;

/** Read a `cloudImages` Json value. Entries without string ids are skipped (they can't be matched or deleted). */
export function readCloudImages(value: unknown): CloudImage[] {
    if (!Array.isArray(value)) return [];
    const images: CloudImage[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const { imageId, cloudUrl, cloudPublicId } = item as Record<string, unknown>;
        if (typeof imageId === 'string' && typeof cloudPublicId === 'string') {
            images.push({ imageId, cloudUrl: typeof cloudUrl === 'string' ? cloudUrl : '', cloudPublicId });
        }
    }
    return images;
}

export interface CollectedUploads {
    /** imageId → { url, publicId } (the doc save points the uploaded image nodes at these URLs). */
    imageUrlMap: Record<string, { url: string; publicId: string }>;
    /** New `cloudImages` entries, one per uploaded image id. */
    uploaded: CloudImage[];
}

/**
 * For each image id, take the file upfly uploaded for the form field `image_<id>`. Ids without a
 * file, or whose upload returned no URL/public id, are skipped (as before).
 */
export function collectUploadedImages(files: UploadedFiles | undefined, imageIds: readonly string[]): CollectedUploads {
    const imageUrlMap: CollectedUploads['imageUrlMap'] = {};
    const uploaded: CloudImage[] = [];
    if (!files) return { imageUrlMap, uploaded };

    for (const imageId of imageIds) {
        if (Object.prototype.hasOwnProperty.call(imageUrlMap, imageId)) continue;
        const file = files[`image_${imageId}`]?.[0];
        if (file?.cloudUrl && file.cloudPublicId) {
            imageUrlMap[imageId] = { url: file.cloudUrl, publicId: file.cloudPublicId };
            uploaded.push({ imageId, cloudUrl: file.cloudUrl, cloudPublicId: file.cloudPublicId });
        }
    }
    return { imageUrlMap, uploaded };
}

/** Split stored images into the ones still in use (`keepIds`) and the orphans to delete. */
export function partitionCloudImages(
    existing: readonly CloudImage[],
    keepIds: Iterable<string>
): { retain: CloudImage[]; orphaned: CloudImage[] } {
    const keep = keepIds instanceof Set ? (keepIds as Set<string>) : new Set(keepIds);
    const retain: CloudImage[] = [];
    const orphaned: CloudImage[] = [];
    for (const image of existing) {
        // The new editor's image blocks are found by URL (they carry no imageId).
        const used = keep.has(image.imageId) || (!!image.cloudUrl && keep.has(image.cloudUrl));
        (used ? retain : orphaned).push(image);
    }
    return { retain, orphaned };
}
