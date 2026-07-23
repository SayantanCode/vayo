// @vayo/server — spec resolution (GET /api/spec), API version lifecycle
// (docs/07-api-versioning.md), and the breaking-change diff between two
// versions.
import { Router } from "express";
import { z } from "zod";
import { resolveEndpoint } from "@vayo/schema-engine";
import { compile, diffSpecs, type CompileOptions } from "@vayo/openapi-compiler";
import type { ExampleDoc, ResolvedEndpoint, VayoDbAdapter } from "@vayo/types";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

/** `compile()`'s `title`/`description`/`servers`/pinned examples, sourced
 * from `vayo_settings`/`vayo_environments`/`vayo_examples`
 * (docs/03-data-model.md) — the equivalent of swagger-jsdoc's static
 * `options.definition`, just editable through the docs UI instead. Only
 * environments with a non-empty `baseUrl` variable become a Server Object
 * (the well-known convention Try It Now/DetailsTab/the Postman export
 * already rely on); only `pinned` examples are compiled in, matching the
 * Postman export's own existing filter — auto-captured rolling-window
 * examples are ephemeral by design, not meant for a permanent export. */
async function compileOptionsFromDb(db: VayoDbAdapter, resolved: ResolvedEndpoint[]): Promise<CompileOptions> {
  const [settings, environments] = await Promise.all([db.getSettings(), db.listEnvironments()]);
  const servers = environments
    .filter((env) => env.variables.baseUrl)
    .map((env) => ({ url: env.variables.baseUrl!, description: env.name }));

  const pinnedExamplesByVayoId = new Map<string, ExampleDoc[]>();
  await Promise.all(
    resolved.map(async (endpoint) => {
      const pinned = (await db.listExamples(endpoint.vayoId)).filter((example) => example.pinned);
      if (pinned.length > 0) pinnedExamplesByVayoId.set(endpoint.vayoId, pinned);
    }),
  );

  return {
    title: settings.title,
    description: settings.description ?? undefined,
    servers,
    pinnedExamplesByVayoId,
  };
}

const apiVersionBodySchema = z.object({
  version: z.string().min(1),
  basePathPattern: z.string().min(1),
});

const apiVersionPatchSchema = z.object({
  status: z.enum(["active", "deprecated", "sunset"]).optional(),
  basePathPattern: z.string().min(1).optional(),
  deprecatedAt: z.string().nullable().optional(),
  sunsetAt: z.string().nullable().optional(),
});

export function createVersionsRouter({ db, io }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/spec", requireRole("viewer"), async (req, res) => {
    const version = typeof req.query.version === "string" ? req.query.version : "v1";
    const endpoints = await db.listEndpoints(version);
    const resolved = await Promise.all(
      endpoints.map(async (endpoint) => resolveEndpoint(endpoint, await db.listOverrides(endpoint.vayoId))),
    );
    try {
      const doc = await compile(resolved, version, await compileOptionsFromDb(db, resolved));
      res.json(doc);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "compile failed" });
    }
  });

  // ---- API versions (docs/07-api-versioning.md) ----
  router.get("/api/versions", requireRole("viewer"), async (_req, res) => {
    res.json(await db.listApiVersions());
  });

  router.post("/api/versions", requireRole("editor"), async (req, res) => {
    const parsed = apiVersionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const created = await db.createApiVersion({
      version: parsed.data.version,
      basePathPattern: parsed.data.basePathPattern,
      status: "active",
      deprecatedAt: null,
      sunsetAt: null,
    });
    res.status(201).json(created);
  });

  router.patch("/api/versions/:version", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const parsed = apiVersionPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const updated = await db.updateApiVersion(req.params.version!, parsed.data);
    if (!updated) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (parsed.data.status) {
      await db.createNotification({
        type: "version_status",
        vayoId: null,
        actorId: req.vayoAuth!.memberId,
        message: `marked ${updated.version} as ${parsed.data.status}`,
        mentionedMemberIds: [],
        targetId: null,
        createdAt: new Date().toISOString(),
      });
      io.to("project").emit("notification:new", { type: "version_status", vayoId: null });
    }
    res.json(updated);
  });

  router.get("/api/diff", requireRole("viewer"), async (req, res) => {
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;
    if (!from || !to) {
      res.status(400).json({ error: "both 'from' and 'to' query params are required" });
      return;
    }

    const versions = await db.listApiVersions();
    const fromVersion = versions.find((v) => v.version === from);
    const toVersion = versions.find((v) => v.version === to);

    async function compileVersion(version: string) {
      const endpoints = await db.listEndpoints(version);
      const resolved = await Promise.all(
        endpoints.map(async (endpoint) => resolveEndpoint(endpoint, await db.listOverrides(endpoint.vayoId))),
      );
      return compile(resolved, version);
    }

    try {
      const [specFrom, specTo] = await Promise.all([compileVersion(from), compileVersion(to)]);
      const diff = diffSpecs(specFrom, specTo, {
        stripPrefixA: fromVersion?.basePathPattern,
        stripPrefixB: toVersion?.basePathPattern,
      });
      res.json(diff);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "diff failed" });
    }
  });

  return router;
}
