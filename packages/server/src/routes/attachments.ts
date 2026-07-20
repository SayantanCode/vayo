// @vayo/server — vayo_attachments (Team Chat files/screen recordings),
// GridFS-backed in the user's own already-configured MongoDB (BYODB) —
// docs/03-data-model.md.
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { MAX_ATTACHMENT_BYTES } from "@vayo/types";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });

export function createAttachmentsRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/attachments", requireRole("viewer"), async (req, res) => {
    const vayoId = typeof req.query.vayoId === "string" ? req.query.vayoId : "";
    if (!vayoId) {
      res.status(400).json({ error: "vayoId is required" });
      return;
    }
    res.json(await db.listAttachments(vayoId));
  });

  // Uploaded before the comment exists (so multiple files can sit as
  // pending chips in the compose box) — `db.claimAttachments` links them
  // once the message is actually sent (routes/comments.ts's addComment).
  router.post(
    "/api/attachments",
    requireRole("viewer"),
    (req: Request, res: Response, next: NextFunction) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({ error: `file too large — max ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB` });
          return;
        }
        if (err) {
          res.status(400).json({ error: "upload failed" });
          return;
        }
        next();
      });
    },
    async (req: VayoAuthedRequest, res) => {
      if (!req.file) {
        res.status(400).json({ error: "no file uploaded" });
        return;
      }
      const vayoId = typeof req.body.vayoId === "string" ? req.body.vayoId : "";
      if (!vayoId) {
        res.status(400).json({ error: "vayoId is required" });
        return;
      }
      const kind = req.body.kind === "screen-recording" ? "screen-recording" : "file";
      const attachment = await db.uploadAttachment({
        vayoId,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        kind,
        uploadedBy: req.vayoAuth!.memberId,
        data: req.file.buffer,
      });
      res.status(201).json(attachment);
    },
  );

  router.get("/api/attachments/:id/download", requireRole("viewer"), async (req, res) => {
    const result = await db.downloadAttachment(req.params.id!);
    if (!result) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // Standard broad-compatibility pattern: an ASCII-safe quoted filename
    // plus the UTF-8-encoded form for names outside that range. `inline`
    // (not `attachment`) so an image/video can be previewed directly via
    // an <img>/<video> tag pointing at this same URL, not force-downloaded.
    const safeName = result.attachment.filename.replace(/["\r\n]/g, "");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(result.attachment.filename)}`,
    );
    res.setHeader("Content-Type", result.attachment.mimeType);
    // @vayo/types keeps this opaque (`unknown`) to stay dependency-free —
    // @vayo/server is where a real Node stream is actually expected.
    const stream = result.stream as NodeJS.ReadableStream;
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "failed to read attachment" });
      else res.destroy();
    });
    stream.pipe(res);
  });

  router.delete("/api/attachments/:id", requireRole("viewer"), async (req: VayoAuthedRequest, res) => {
    const deleted = await db.deleteUnclaimedAttachment(req.params.id!, req.vayoAuth!.memberId);
    if (!deleted) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(204).end();
  });

  return router;
}
