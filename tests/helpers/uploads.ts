// Fake `upfly` for integration tests of routes with image uploads (docs, collab upload).
// The real middleware parses multipart bodies and uploads to Cloudinary; the fake does neither: it
// sets req.files to whatever the test registered with setUploadedFiles(). Send the other fields as
// JSON (multipart fields arrive as strings, so send JSON-encoded strings to mimic FormData).
//
//   vi.mock('upfly', async () => (await import('../helpers/uploads')).createUpflyMock());
export interface FakeCloudFile {
    fieldname?: string;
    cloudUrl?: string | undefined;
    cloudPublicId?: string | undefined;
    cloudProvider?: string | undefined;
}

const box = globalThis as unknown as { __testUploadFiles?: Record<string, FakeCloudFile[]> | undefined };

/** Files the next upload requests will see on req.files (until cleared). */
export function setUploadedFiles(files: Record<string, FakeCloudFile[]> | undefined): void {
    box.__testUploadFiles = files;
}

export function clearUploadedFiles(): void {
    box.__testUploadFiles = undefined;
}

/** A file as upfly reports it after a successful Cloudinary upload. */
export function fakeCloudFile(fieldname: string, name = fieldname): FakeCloudFile {
    return {
        fieldname,
        cloudUrl: `https://cdn.example.test/${name}.webp`,
        cloudPublicId: `test/${name}`,
        cloudProvider: 'cloudinary',
    };
}

export function createUpflyMock() {
    return {
        upflyUpload: () => (req: any, _res: any, next: any) => {
            if (box.__testUploadFiles) req.files = box.__testUploadFiles;
            next();
        },
    };
}
