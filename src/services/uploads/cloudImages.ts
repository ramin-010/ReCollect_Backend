// Cloudinary image bookkeeping for docs (pure functions, no database).
//
// Docs list the Cloudinary images they use in a Json column `cloudImages`:
// [{ imageId, cloudUrl, cloudPublicId, resourceType? }]. `imageId` is the editor's id for the image (the TipTap
// node attr `imageId`). On save the client sends the ids it still uses; stored images missing
// from that list are orphans and get deleted from Cloudinary.
//
// Since 11-27 a doc's File block's file is listed too (the notes' upload with the doc's id): `imageId` is then its public
// id and `resourceType` the store's kind for it ("raw" for most files, "image" or "video"), which deleting needs.

/** One entry of a `cloudImages` Json column. (A type alias, so it is assignable to Prisma's Json input.) */
export type CloudImage = { imageId: string; cloudUrl: string; cloudPublicId: string; resourceType?: string };

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
        const { imageId, cloudUrl, cloudPublicId, resourceType } = item as Record<string, unknown>;
        if (typeof imageId === 'string' && typeof cloudPublicId === 'string') {
            images.push({ imageId, cloudUrl: typeof cloudUrl === 'string' ? cloudUrl : '', cloudPublicId, ...(typeof resourceType === 'string' && resourceType ? { resourceType } : {}) });
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

/** A URL as text compares: decoded where it can be (a Markdown link writes spaces and parentheses encoded). */
function urlKey(url: string): string {
    try {
        return decodeURI(url);
    } catch {
        return url;
    }
}

/** Split stored images into the ones still in use (`keepIds`) and the orphans to delete. */
export function partitionCloudImages(
    existing: readonly CloudImage[],
    keepIds: Iterable<string>
): { retain: CloudImage[]; orphaned: CloudImage[] } {
    const keep = keepIds instanceof Set ? (keepIds as Set<string>) : new Set(keepIds);
    const keepUrls = new Set([...keep].map(urlKey));
    const retain: CloudImage[] = [];
    const orphaned: CloudImage[] = [];
    for (const image of existing) {
        // The new editor's image and file blocks (and links in its text) are found by URL (they carry no imageId); a
        // URL counts however it is encoded, so a file still linked is never taken for an orphan.
        const used = keep.has(image.imageId) || (!!image.cloudUrl && (keep.has(image.cloudUrl) || keepUrls.has(urlKey(image.cloudUrl))));
        (used ? retain : orphaned).push(image);
    }
    return { retain, orphaned };
}

/** Public ids to delete, grouped by the store's kind (images first; an entry without a kind is an image). */
export function publicIdsByType(images: readonly CloudImage[]): Array<[string, string[]]> {
    const groups = new Map<string, string[]>();
    for (const image of images) {
        const type = image.resourceType || 'image';
        groups.set(type, [...(groups.get(type) ?? []), image.cloudPublicId]);
    }
    return [...groups].sort(([a], [b]) => (a === b ? 0 : a === 'image' ? -1 : b === 'image' ? 1 : a.localeCompare(b)));
}
