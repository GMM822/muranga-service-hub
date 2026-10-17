import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { RequestUploadUrlBody, RequestUploadUrlResponse } from "@workspace/api-zod";
import { db, requestUploadsTable } from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";
import { requireIdentity } from "../lib/identity";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

router.post(
  "/storage/uploads/request-url",
  requireIdentity,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { name, size, contentType } = parsed.data;
    if (size > MAX_IMAGE_BYTES || !ALLOWED_CONTENT_TYPES.has(contentType)) {
      res.status(400).json({
        error: "Choose a JPEG, PNG, or WebP image up to 5 MB.",
      });
      return;
    }
    if (!process.env.PRIVATE_OBJECT_DIR) {
      res.status(503).json({
        error:
          "Image storage is not configured yet. You can still submit a request without an image.",
      });
      return;
    }

    try {
      const uploadURL = await storage.getObjectEntityUploadURL();
      const objectPath = storage.normalizeObjectEntityPath(uploadURL);
      if (!objectPath.startsWith("/objects/uploads/")) {
        req.log.error({ objectPath }, "Storage returned an unexpected upload path");
        res.status(500).json({ error: "Unable to prepare this image upload." });
        return;
      }

      await db.insert(requestUploadsTable).values({
        objectPath,
        ownerUserId: req.appUser!.id,
        originalName: name.replace(/[\\/]/g, "").slice(0, 180),
        contentType,
        size,
      });
      res.json(RequestUploadUrlResponse.parse({ uploadURL, objectPath }));
    } catch (error) {
      req.log.error({ err: error }, "Unable to create image upload URL");
      res.status(503).json({
        error:
          "Image storage is temporarily unavailable. You can still submit a request without an image.",
      });
    }
  },
);

router.get(
  "/storage/objects/*path",
  requireIdentity,
  async (req: Request, res: Response): Promise<void> => {
    const raw = req.params.path;
    const suffix = Array.isArray(raw) ? raw.join("/") : raw;
    if (
      !suffix ||
      suffix.split("/").some((part) => part === ".." || part === "." || !part)
    ) {
      res.status(400).json({ error: "Invalid image path." });
      return;
    }
    const objectPath = `/objects/${suffix}`;
    const [upload] = await db
      .select()
      .from(requestUploadsTable)
      .where(eq(requestUploadsTable.objectPath, objectPath));
    if (!upload) {
      res.status(404).json({ error: "Image not found." });
      return;
    }
    if (
      req.appUser!.role !== "admin" &&
      req.appUser!.id !== upload.ownerUserId
    ) {
      res.status(403).json({ error: "You do not have access to this image." });
      return;
    }

    try {
      const objectFile = await storage.getObjectEntityFile(objectPath);
      const [metadata] = await objectFile.getMetadata();
      const actualSize = Number(metadata.size ?? 0);
      if (
        actualSize > MAX_IMAGE_BYTES ||
        !ALLOWED_CONTENT_TYPES.has(upload.contentType)
      ) {
        res.status(415).json({ error: "This image is not supported." });
        return;
      }
      const response = await storage.downloadObject(objectFile, 0);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.setHeader("Content-Type", upload.contentType);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; sandbox",
      );

      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Image not found." });
        return;
      }
      req.log.error({ err: error }, "Unable to serve request image");
      res.status(503).json({ error: "Image storage is temporarily unavailable." });
    }
  },
);

export default router;
