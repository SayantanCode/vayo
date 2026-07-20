import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";

/** Validates req.body against a Zod schema before the route handler runs.
 * Named `validateBody` deliberately — @vayo/ast's static scanner recognizes
 * this exact name (see DEFAULT_VALIDATION_MIDDLEWARE_PATTERNS) and extracts
 * the schema's shape as the endpoint's documented request body. */
export function validateBody(schema: ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: "invalid body", details: result.error.issues });
      return;
    }
    req.body = result.data;
    next();
  };
}
