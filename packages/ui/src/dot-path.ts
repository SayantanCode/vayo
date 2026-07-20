// @vayo/ui — resolves a dot-separated path (e.g. "response.body.token")
// against a plain object context — what a FlowStep.extractVariables value
// means (docs/03-data-model.md "Flows").

export function resolveDotPath(context: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), context);
}
