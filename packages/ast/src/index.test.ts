import { Node, Project, SyntaxKind, type CallExpression } from "ts-morph";
import { describe, expect, it } from "vitest";
import {
  buildMountPrefixMap,
  DEFAULT_VALIDATION_MIDDLEWARE_PATTERNS,
  extractDeclaredExamples,
  extractDeclaredResponseSchemas,
  extractDeprecated,
  extractDescription,
  extractExplicitGroup,
  extractMiddlewareNames,
  extractSummary,
  findMongooseRequestSchemaForRoute,
  findRequestSchemaForRoute,
  inferGroup,
  joinMountedPath,
  pathSegmentsMatch,
} from "./index.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all"]);

/** Finds the first `router.<method>(...)` call in a snippet — a minimal
 * stand-in for @vayo/ast's own (unexported) findRouteRegistrations, just
 * enough to hand a real CallExpression to extractMiddlewareNames. */
function firstRouteRegistration(source: string): CallExpression {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile("/route.ts", source);
  const call = file.getDescendantsOfKind(SyntaxKind.CallExpression).find((c) => {
    const expr = c.getExpression();
    return Node.isPropertyAccessExpression(expr) && HTTP_METHODS.has(expr.getName());
  });
  if (!call) throw new Error("no route registration found in test fixture");
  return call;
}

/** Same idea as `firstRouteRegistration`, but across multiple files (an
 * imported Zod schema, not one declared inline) — returns the route
 * registration call found in whichever file actually contains one. */
function firstRouteRegistrationAcrossFiles(files: Record<string, string>): CallExpression {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  for (const [filePath, content] of Object.entries(files)) {
    project.createSourceFile(filePath, content);
  }
  for (const file of project.getSourceFiles()) {
    const call = file.getDescendantsOfKind(SyntaxKind.CallExpression).find((c) => {
      const expr = c.getExpression();
      return Node.isPropertyAccessExpression(expr) && HTTP_METHODS.has(expr.getName());
    });
    if (call) return call;
  }
  throw new Error("no route registration found across test fixture files");
}

describe("pathSegmentsMatch", () => {
  it("matches identical paths (today's flat app.get(full path) style)", () => {
    expect(pathSegmentsMatch("/api/orders", "/api/orders")).toBe(true);
  });

  it("matches a router's relative path as a suffix of the runtime path", () => {
    expect(pathSegmentsMatch("/:id", "/api/admin/products/:id")).toBe(true);
  });

  it("matches through two levels of router nesting", () => {
    expect(pathSegmentsMatch("/:id", "/api/v1/super-admin/admins/:id")).toBe(true);
  });

  it("does not falsely suffix-match a segment inside a longer segment", () => {
    expect(pathSegmentsMatch("/id", "/api/users/userid")).toBe(false);
  });

  it("does not match an unrelated path", () => {
    expect(pathSegmentsMatch("/api/orders", "/api/products")).toBe(false);
  });
});

describe("joinMountedPath", () => {
  it("resolves a router's own root path to exactly the mount prefix", () => {
    expect(joinMountedPath("/api/v1/admin/products", "/")).toBe("/api/v1/admin/products");
  });

  it("appends a relative sub-path onto the prefix", () => {
    expect(joinMountedPath("/api/v1/admin/products", "/:id")).toBe("/api/v1/admin/products/:id");
  });

  it("is a no-op with an empty prefix (registration found directly on app)", () => {
    expect(joinMountedPath("", "/api/orders")).toBe("/api/orders");
  });
});

describe("extractMiddlewareNames", () => {
  it("returns an empty chain for a route with no middleware", () => {
    const call = firstRouteRegistration(`router.get("/", (req, res) => res.json([]));`);
    expect(extractMiddlewareNames(call)).toEqual([]);
  });

  it("extracts a plain identifier middleware, excluding the handler", () => {
    const call = firstRouteRegistration(`router.post("/", requireAuth, (req, res) => res.status(201).send());`);
    expect(extractMiddlewareNames(call)).toEqual(["requireAuth"]);
  });

  it("extracts a middleware factory call by its callee name, in order", () => {
    const call = firstRouteRegistration(
      `router.patch("/:id", requireAuth, requireRole("admin"), (req, res) => res.json({}));`,
    );
    expect(extractMiddlewareNames(call)).toEqual(["requireAuth", "requireRole"]);
  });

  it("gives a different chain per method sharing the same path — the actual bug this works around", () => {
    // express-list-endpoints (7.x) merges GET/POST on the same literal path
    // into one endpoint and silently keeps only the first-registered
    // method's middlewares for both. Reading each registration's own call
    // node individually keeps them correctly distinct.
    const getCall = firstRouteRegistration(`router.get("/", (req, res) => res.json([]));`);
    const postCall = firstRouteRegistration(`router.post("/", requireAuth, (req, res) => res.status(201).send());`);
    expect(extractMiddlewareNames(getCall)).toEqual([]);
    expect(extractMiddlewareNames(postCall)).toEqual(["requireAuth"]);
  });
});

describe("inferGroup", () => {
  it("infers a single-level group from a routes/<name>/ file convention", () => {
    expect(inferGroup("/api/v1/orders/:id", "/app/src/routes/orders/index.ts")).toBe("Orders");
  });

  it("infers a nested group from multiple routes/ directory levels", () => {
    expect(inferGroup("/api/v1/admin/users/:id", "/app/src/routes/admin/users/index.ts")).toBe("Admin/Users");
  });

  it("infers a three-level nested group", () => {
    expect(inferGroup("/api/v1/x", "/app/src/routes/api/admin/users/index.ts")).toBe("Api/Admin/Users");
  });

  it("falls back to the first meaningful URL segment when there's no routes/ convention", () => {
    expect(inferGroup("/api/v1/widgets/:id", "/app/src/app.ts")).toBe("Widgets");
  });

  it("falls back to 'General' when nothing meaningful can be inferred", () => {
    expect(inferGroup("/", "/app/src/app.ts")).toBe("General");
  });
});

describe("extractExplicitGroup", () => {
  it("reads an explicit @group tag when the comment carries the @vayo sentinel", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @group Orders
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractExplicitGroup(call)).toBe("Orders");
  });

  it("supports a nested @group path with the same '/'-separator inferGroup uses", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @group Admin/Users
       */
      router.get("/admin/users/:id", (req, res) => res.json({}));
    `);
    expect(extractExplicitGroup(call)).toBe("Admin/Users");
  });

  it("trims a trailing '- description' suffix some swagger-jsdoc tools also allow", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @group Orders - order management
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractExplicitGroup(call)).toBe("Orders");
  });

  it("returns null when there's no @group tag at all", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * Fetch a single order by ID.
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractExplicitGroup(call)).toBeNull();
  });

  it("returns null when there's no leading comment at all", () => {
    const call = firstRouteRegistration(`router.get("/orders/:id", (req, res) => res.json({}));`);
    expect(extractExplicitGroup(call)).toBeNull();
  });

  it("ignores an @group-looking line when the comment has no @vayo sentinel — an unrelated comment must never be misread as a declaration", () => {
    const call = firstRouteRegistration(`
      /**
       * Routes moved out of the old @group of helper utilities below.
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractExplicitGroup(call)).toBeNull();
  });
});

describe("extractSummary", () => {
  it("strips the @group tag line and the @vayo sentinel out of the shown summary, keeping the description", () => {
    const call = firstRouteRegistration(`
      /**
       * Fetch a single order by ID.
       * @vayo
       * @group Orders
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractSummary(call)).toBe("Fetch a single order by ID.");
  });

  it("leaves a plain description with no tags untouched", () => {
    const call = firstRouteRegistration(`
      /**
       * Fetch a single order by ID.
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractSummary(call)).toBe("Fetch a single order by ID.");
  });

  it("strips the @deprecated tag line out of the shown summary, keeping the description", () => {
    const call = firstRouteRegistration(`
      /**
       * Fetch a single order by ID.
       * @vayo
       * @deprecated
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractSummary(call)).toBe("Fetch a single order by ID.");
  });

  it("strips @vayo, @group, and @deprecated tag lines, keeping only the description", () => {
    const call = firstRouteRegistration(`
      /**
       * Fetch a single order by ID.
       * @vayo
       * @group Orders
       * @deprecated
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractSummary(call)).toBe("Fetch a single order by ID.");
  });

  it("does not require @vayo at all — a plain, untagged comment still becomes the summary (zero-annotation M1 behavior)", () => {
    const call = firstRouteRegistration(`
      // Just an ordinary implementation note, not written for API docs.
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractSummary(call)).toBe("Just an ordinary implementation note, not written for API docs.");
  });

  it("excludes a multi-line @description block's continuation lines, not just the @description line itself", () => {
    const call = firstRouteRegistration(`
      /**
       * Fetch a single order by ID.
       * @vayo
       * @description
       * Returns the full order record including line items.
       * Use include=customer to also embed customer info.
       * @group Orders
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractSummary(call)).toBe("Fetch a single order by ID.");
  });
});

describe("extractDescription", () => {
  it("captures inline text right after the tag on the same line", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @description Returns the full order record.
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDescription(call)).toBe("Returns the full order record.");
  });

  it("joins multiple continuation lines into one multi-line description", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @description
       * Returns the full order record including line items.
       * Use include=customer to also embed customer info.
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDescription(call)).toBe(
      "Returns the full order record including line items.\nUse include=customer to also embed customer info.",
    );
  });

  it("stops at the next recognized tag rather than consuming the rest of the comment", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @description Returns the full order record.
       * @group Orders
       * @deprecated
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDescription(call)).toBe("Returns the full order record.");
  });

  it("returns null without the @vayo sentinel", () => {
    const call = firstRouteRegistration(`
      /**
       * @description Returns the full order record.
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDescription(call)).toBeNull();
  });

  it("returns null when there's no @description tag at all", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @group Orders
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDescription(call)).toBeNull();
  });
});

describe("extractDeprecated", () => {
  it("returns true for a bare @deprecated tag when the comment carries the @vayo sentinel", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @deprecated
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeprecated(call)).toBe(true);
  });

  it("returns true for @deprecated alongside a description and other tags", () => {
    const call = firstRouteRegistration(`
      /**
       * Fetch a single order by ID.
       * @vayo
       * @group Orders
       * @deprecated
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeprecated(call)).toBe(true);
  });

  it("returns false when there's no @deprecated tag", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * Fetch a single order by ID.
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeprecated(call)).toBe(false);
  });

  it("returns false when there's no leading comment at all", () => {
    const call = firstRouteRegistration(`router.get("/orders/:id", (req, res) => res.json({}));`);
    expect(extractDeprecated(call)).toBe(false);
  });

  it("ignores an @deprecated-looking line when the comment has no @vayo sentinel", () => {
    const call = firstRouteRegistration(`
      /**
       * The @deprecated flag was removed from the old validator; see PR #123.
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeprecated(call)).toBe(false);
  });

  it("does not flip on for a stray '@deprecated ...' sentence even inside a @vayo-tagged block, since the whole line must be exactly the tag", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @group Orders
       * TODO: the @deprecated tag needs cleanup once the new gateway ships.
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeprecated(call)).toBe(false);
  });
});

describe("extractDeclaredResponseSchemas", () => {
  it("resolves a @response tag to the named Zod schema, declared inline", () => {
    const call = firstRouteRegistration(`
      const OrderSchema = z.object({ id: z.string(), total: z.number() });
      /**
       * @vayo
       * @response 200 OrderSchema
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeclaredResponseSchemas(call)).toEqual({
      "200": {
        type: "object",
        properties: { id: { type: "string" }, total: { type: "number" } },
        required: ["id", "total"],
      },
    });
  });

  it("resolves a schema declared inside a createApp()-style wrapping function, not just at the file's top level", () => {
    const call = firstRouteRegistration(`
      function createApp() {
        const OrderSchema = z.object({ id: z.string(), total: z.number() });
        /**
         * @vayo
         * @response 200 OrderSchema
         */
        router.get("/orders/:id", (req, res) => res.json({}));
      }
    `);
    expect(extractDeclaredResponseSchemas(call)).toEqual({
      "200": {
        type: "object",
        properties: { id: { type: "string" }, total: { type: "number" } },
        required: ["id", "total"],
      },
    });
  });

  it("resolves multiple @response lines, one per status code", () => {
    const call = firstRouteRegistration(`
      const OrderSchema = z.object({ id: z.string() });
      const ErrorSchema = z.object({ message: z.string() });
      /**
       * @vayo
       * @response 200 OrderSchema
       * @response 404 ErrorSchema
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeclaredResponseSchemas(call)).toEqual({
      "200": { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      "404": { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    });
  });

  it("resolves a schema imported from a different file, not just one declared inline", () => {
    const call = firstRouteRegistrationAcrossFiles({
      "\\schemas\\order.schema.ts": `
        import { z } from "zod";
        export const OrderSchema = z.object({ id: z.string() });
      `,
      "\\routes\\orders.routes.ts": `
        import { OrderSchema } from "../schemas/order.schema.js";
        /**
         * @vayo
         * @response 200 OrderSchema
         */
        router.get("/orders/:id", (req, res) => res.json({}));
      `,
    });
    expect(extractDeclaredResponseSchemas(call)).toEqual({
      "200": { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    });
  });

  it("resolves a schema destructured from a CommonJS require", () => {
    const call = firstRouteRegistrationAcrossFiles({
      "\\schemas\\order.schema.js": `
        const OrderSchema = z.object({ id: z.string() });
        module.exports = { OrderSchema };
      `,
      "\\routes\\orders.routes.js": `
        const { OrderSchema } = require("../schemas/order.schema.js");
        /**
         * @vayo
         * @response 200 OrderSchema
         */
        router.get("/orders/:id", (req, res) => res.json({}));
      `,
    });
    expect(extractDeclaredResponseSchemas(call)).toEqual({
      "200": { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    });
  });

  it("silently skips a status whose named schema doesn't resolve, rather than throwing", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @response 200 SomethingNotDeclaredAnywhere
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeclaredResponseSchemas(call)).toEqual({});
  });

  it("returns an empty object without the @vayo sentinel", () => {
    const call = firstRouteRegistration(`
      /**
       * @response 200 OrderSchema
       */
      const OrderSchema = z.object({ id: z.string() });
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeclaredResponseSchemas(call)).toEqual({});
  });
});

describe("extractDeclaredExamples", () => {
  it("parses a single-line JSON @example for a status code", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @example 200 {"id": "abc123", "total": 42.5}
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeclaredExamples(call)).toEqual({ "200": { id: "abc123", total: 42.5 } });
  });

  it("parses multiple @example lines for different status codes", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @example 200 {"id": "abc123"}
       * @example 404 {"message": "not found"}
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeclaredExamples(call)).toEqual({
      "200": { id: "abc123" },
      "404": { message: "not found" },
    });
  });

  it("silently skips a line with invalid JSON, rather than throwing", () => {
    const call = firstRouteRegistration(`
      /**
       * @vayo
       * @example 200 {not valid json}
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeclaredExamples(call)).toEqual({});
  });

  it("returns an empty object without the @vayo sentinel", () => {
    const call = firstRouteRegistration(`
      /**
       * @example 200 {"id": "abc123"}
       */
      router.get("/orders/:id", (req, res) => res.json({}));
    `);
    expect(extractDeclaredExamples(call)).toEqual({});
  });
});

describe("allowJs dependency resolution (scanProject's own Project config)", () => {
  it("follows imports into plain .js files, not just the entry file", () => {
    // Reproduces the bug found live: a project written in plain JavaScript
    // (not TypeScript — e.g. vayo.config.js itself, or any real Express app
    // that isn't using TS) needs allowJs, or ts-morph's own module
    // resolution silently refuses to follow .js imports at all and
    // resolveSourceFileDependencies() only ever finds the entry file.
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true },
    });
    project.createSourceFile(
      "/widgets.routes.js",
      `import express from "express";
       const router = express.Router();
       router.get("/", (req, res) => res.json([]));
       export default router;`,
    );
    const entry = project.createSourceFile(
      "/entry.js",
      `import express from "express";
       import widgetsRouter from "./widgets.routes.js";
       const app = express();
       app.use("/api/v1/widgets", widgetsRouter);
       export default app;`,
    );
    project.resolveSourceFileDependencies();
    const paths = project.getSourceFiles().map((f) => f.getFilePath());
    expect(paths).toContain(entry.getFilePath());
    expect(paths).toContain("/widgets.routes.js");
  });
});

describe("buildMountPrefixMap", () => {
  function projectWithFiles(files: Record<string, string>): Project {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
    for (const [filePath, content] of Object.entries(files)) {
      project.createSourceFile(filePath, content);
    }
    return project;
  }

  it("maps a default-exported router's file to its mount prefix", () => {
    const project = projectWithFiles({
      "/routes/products.routes.ts": `
        import express from "express";
        const router = express.Router();
        router.get("/", (req, res) => res.json([]));
        export default router;
      `,
      "/loaders/routes.ts": `
        import express from "express";
        import productsRouter from "../routes/products.routes.js";
        const app = express();
        app.use("/api/v1/products", productsRouter);
      `,
    });
    const map = buildMountPrefixMap(project);
    expect(map.get("/routes/products.routes.ts")).toBe("/api/v1/products");
  });

  it("does not map a router file that's never mounted via a recognized app.use(prefix, identifier) call", () => {
    const project = projectWithFiles({
      "/routes/orphan.routes.ts": `
        import express from "express";
        const router = express.Router();
        router.get("/", (req, res) => res.json([]));
        export default router;
      `,
    });
    const map = buildMountPrefixMap(project);
    expect(map.size).toBe(0);
  });
});

describe("findRequestSchemaForRoute", () => {
  it("extracts an object schema from a validation-middleware call, including .describe() text", () => {
    const call = firstRouteRegistration(`
      const CreateOrderSchema = z.object({
        productId: z.string().describe("The product being ordered"),
        quantity: z.number().int().min(1),
      });
      router.post("/", requireAuth, validateBody(CreateOrderSchema), (req, res) => res.status(201).json({}));
    `);
    const schema = findRequestSchemaForRoute(call, DEFAULT_VALIDATION_MIDDLEWARE_PATTERNS);
    expect(schema).toEqual({
      type: "object",
      properties: {
        productId: { type: "string", description: "The product being ordered" },
        quantity: { type: "integer", minimum: 1 },
      },
      required: ["productId", "quantity"],
    });
  });

  it("extracts a schema from Schema.parse(req.body) called inside the handler, with no validation middleware at all", () => {
    const call = firstRouteRegistration(`
      const UpdateProfileSchema = z.object({
        email: z.string().email().optional(),
      });
      router.patch("/me", (req, res) => {
        const body = UpdateProfileSchema.parse(req.body);
        res.json(body);
      });
    `);
    const schema = findRequestSchemaForRoute(call, DEFAULT_VALIDATION_MIDDLEWARE_PATTERNS);
    expect(schema).toEqual({
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
      },
      // email is .optional() — must not appear in `required`
    });
  });

  it("resolves a schema imported from a different file, not just one declared inline", () => {
    const call = firstRouteRegistrationAcrossFiles({
      "/schemas/order.schema.ts": `
        import { z } from "zod";
        export const CreateOrderSchema = z.object({ productId: z.string() });
      `,
      "/routes/orders.routes.ts": `
        import { CreateOrderSchema } from "../schemas/order.schema.js";
        router.post("/", validateBody(CreateOrderSchema), (req, res) => res.status(201).json({}));
      `,
    });
    const schema = findRequestSchemaForRoute(call, DEFAULT_VALIDATION_MIDDLEWARE_PATTERNS);
    expect(schema).toEqual({
      type: "object",
      properties: { productId: { type: "string" } },
      required: ["productId"],
    });
  });

  it("returns an array-of-objects schema for z.array(z.object({...}))", () => {
    const call = firstRouteRegistration(`
      const BulkSchema = z.object({
        items: z.array(z.object({ sku: z.string(), qty: z.number() })),
      });
      router.post("/bulk", validateBody(BulkSchema), (req, res) => res.status(201).json({}));
    `);
    const schema = findRequestSchemaForRoute(call, DEFAULT_VALIDATION_MIDDLEWARE_PATTERNS);
    expect(schema).toEqual({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { sku: { type: "string" }, qty: { type: "number" } },
            required: ["sku", "qty"],
          },
        },
      },
      required: ["items"],
    });
  });

  it("returns null (never a guess) when no recognized validation convention is present", () => {
    const call = firstRouteRegistration(`router.get("/", (req, res) => res.json([]));`);
    expect(findRequestSchemaForRoute(call, DEFAULT_VALIDATION_MIDDLEWARE_PATTERNS)).toBeNull();
  });

  it("returns null for schema composition it deliberately doesn't model (.extend()), rather than a wrong guess", () => {
    const call = firstRouteRegistration(`
      const Base = z.object({ id: z.string() });
      const Extended = Base.extend({ name: z.string() });
      router.post("/", validateBody(Extended), (req, res) => res.status(201).json({}));
    `);
    expect(findRequestSchemaForRoute(call, DEFAULT_VALIDATION_MIDDLEWARE_PATTERNS)).toBeNull();
  });
});

describe("findMongooseRequestSchemaForRoute", () => {
  it("extracts the model's schema from a direct req.body passthrough (Model.create), inline handler", () => {
    const call = firstRouteRegistration(`
      const customerSchema = mongoose.Schema({
        fname: { type: String, required: true },
        age: { type: Number },
      });
      const customerModel = mongoose.model("customer", customerSchema);
      router.post("/", (req, res) => {
        customerModel.create(req.body);
      });
    `);
    expect(findMongooseRequestSchemaForRoute(call)).toEqual({
      type: "object",
      properties: { fname: { type: "string" }, age: { type: "number" } },
      required: ["fname"],
    });
  });

  it("resolves new Model(req.body), a Schema declared with `new`, and a required:[true, message] tuple", () => {
    const call = firstRouteRegistration(`
      const orderSchema = new mongoose.Schema({
        sku: { type: String, required: [true, "sku is required"] },
      });
      const orderModel = mongoose.model("order", orderSchema);
      router.post("/", (req, res) => {
        new orderModel(req.body);
      });
    `);
    expect(findMongooseRequestSchemaForRoute(call)).toEqual({
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
    });
  });

  it("recognizes findByIdAndUpdate/findOneAndUpdate/updateOne with req.body as the update argument", () => {
    for (const [method, args] of [
      ["findByIdAndUpdate", "req.params.id, req.body"],
      ["findOneAndUpdate", "{ _id: req.params.id }, req.body"],
      ["updateOne", "{ _id: req.params.id }, req.body"],
    ] as const) {
      const call = firstRouteRegistration(`
        const productSchema = mongoose.Schema({ name: { type: String } });
        const productModel = mongoose.model("product", productSchema);
        router.put("/:id", (req, res) => {
          productModel.${method}(${args});
        });
      `);
      expect(findMongooseRequestSchemaForRoute(call)).toEqual({
        type: "object",
        properties: { name: { type: "string" } },
      });
    }
  });

  it("recurses into nested subdocuments (an object with no 'type' key) and arrays", () => {
    const call = firstRouteRegistration(`
      const customerSchema = mongoose.Schema({
        personalInfo: {
          address: {
            city: { type: String },
          },
        },
        tags: [String],
      });
      const customerModel = mongoose.model("customer", customerSchema);
      router.post("/", (req, res) => {
        customerModel.create(req.body);
      });
    `);
    expect(findMongooseRequestSchemaForRoute(call)).toEqual({
      type: "object",
      properties: {
        personalInfo: {
          type: "object",
          properties: {
            address: { type: "object", properties: { city: { type: "string" } } },
          },
        },
        tags: { type: "array", items: { type: "string" } },
      },
    });
  });

  it("maps enum and Schema.Types.ObjectId, and supports shorthand `field: Type` with no options object", () => {
    const call = firstRouteRegistration(`
      const orderSchema = mongoose.Schema({
        status: { type: String, enum: ["pending", "paid"] },
        customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
        note: String,
      });
      const orderModel = mongoose.model("order", orderSchema);
      router.post("/", (req, res) => {
        orderModel.create(req.body);
      });
    `);
    expect(findMongooseRequestSchemaForRoute(call)).toEqual({
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "paid"] },
        customer: { type: "string" },
        note: { type: "string" },
      },
    });
  });

  it("resolves the model across files: route -> named-imported, HOC-wrapped controller export -> imported model", () => {
    const call = firstRouteRegistrationAcrossFiles({
      "/models/customerModel.js": `
        import mongoose from "mongoose";
        const customerSchema = mongoose.Schema({ fname: { type: String, required: true } });
        const customerModel = mongoose.model("customer", customerSchema);
        export default customerModel;
      `,
      "/controllers/customerController.js": `
        import expressAsyncHandler from "express-async-handler";
        import customerModel from "../models/customerModel.js";
        export const addCustomer = expressAsyncHandler(async (req, res) => {
          await customerModel.create(req.body);
        });
      `,
      "/routes/customerRoutes.js": `
        import { addCustomer } from "../controllers/customerController.js";
        router.post("/add", authenticate, addCustomer);
      `,
    });
    expect(findMongooseRequestSchemaForRoute(call)).toEqual({
      type: "object",
      properties: { fname: { type: "string" } },
      required: ["fname"],
    });
  });

  it("resolves a model imported via CommonJS require()/module.exports, not just ES import/export", () => {
    const call = firstRouteRegistrationAcrossFiles({
      "/models/userModel.js": `
        const mongoose = require("mongoose");
        const userSchema = mongoose.Schema({ name: { type: String, required: true } });
        module.exports = mongoose.model("user", userSchema);
      `,
      "/routes/userRoutes.js": `
        const User = require("../models/userModel.js");
        router.post("/", async (req, res) => {
          await User.create(req.body);
        });
      `,
    });
    expect(findMongooseRequestSchemaForRoute(call)).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
  });

  it("resolves a handler through a destructured require() (CommonJS's answer to a named ES import)", () => {
    const call = firstRouteRegistrationAcrossFiles({
      "/models/userModel.js": `
        const mongoose = require("mongoose");
        const userSchema = mongoose.Schema({ name: { type: String, required: true } });
        module.exports = mongoose.model("user", userSchema);
      `,
      "/controllers/userController.js": `
        const User = require("../models/userModel.js");
        exports.addUser = async (req, res) => {
          await User.create(req.body);
        };
      `,
      "/routes/userRoutes.js": `
        const { addUser } = require("../controllers/userController.js");
        router.post("/", authenticate, addUser);
      `,
    });
    expect(findMongooseRequestSchemaForRoute(call)).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
  });

  it("falls back to destructure-and-cross-reference when req.body is reshaped field-by-field before the model call, typing each destructured name from the model when it matches", () => {
    const call = firstRouteRegistration(`
      const customerSchema = mongoose.Schema({
        fname: { type: String, required: true },
        age: { type: Number },
      });
      const customerModel = mongoose.model("customer", customerSchema);
      router.post("/", async (req, res) => {
        const { fname, age, notOnTheModel } = req.body;
        const existing = await customerModel.findOne({ fname });
        const doc = new customerModel({ fname, age, extra: notOnTheModel });
        await doc.save();
      });
    `);
    expect(findMongooseRequestSchemaForRoute(call)).toEqual({
      type: "object",
      properties: {
        fname: { type: "string" },
        age: { type: "number" },
        notOnTheModel: { type: "string" }, // not a real schema field -> generic string fallback
      },
      required: ["fname"],
    });
  });

  it("returns null (never a guess) when the handler references no resolvable Mongoose model at all", () => {
    const call = firstRouteRegistration(`router.get("/", (req, res) => res.json([]));`);
    expect(findMongooseRequestSchemaForRoute(call)).toBeNull();
  });

  it("returns null when req.body is reshaped into a new object literal rather than passed directly or simply destructured", () => {
    const call = firstRouteRegistration(`
      const productSchema = mongoose.Schema({ name: { type: String } });
      const productModel = mongoose.model("product", productSchema);
      router.post("/", (req, res) => {
        productModel.create({ ...req.body, extra: 1 });
      });
    `);
    expect(findMongooseRequestSchemaForRoute(call)).toBeNull();
  });
});
