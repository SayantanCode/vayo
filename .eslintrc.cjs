// Root ESLint config for the whole pnpm workspace (docs/08-packages-and-repo-structure.md).
// `pnpm check:boundaries` (scripts/check-boundaries.mjs) already enforces the
// framework-agnostic boundary as a cheap grep-based guard — the
// `no-restricted-imports` override below formalizes the identical rule as a
// real lint rule, per CONTRIBUTING.md's own note that the script was "not a
// full ESLint rule yet".
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { node: true, es2022: true, browser: true },
  ignorePatterns: [
    "**/dist/**",
    "**/dist-app/**",
    "**/node_modules/**",
    "**/*.d.ts",
    ".changeset/**",
  ],
  rules: {
    // Existing, deliberate patterns throughout this codebase that
    // @typescript-eslint's recommended preset would otherwise flag:
    // - Every DB adapter method signature destructures loosely-typed
    //   `unknown`/generic shapes on purpose (docs/03-data-model.md); a
    //   flagged-as-error `no-explicit-any` would fight that everywhere.
    // - Unused destructured variables that exist purely to document a
    //   shape (`const { _id: _ignored, ...rest } = doc`).
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-empty-function": "off",
    // `declare global { namespace Express { ... } }` (apps/demo-app's own
    // auth middleware, the standard way to augment Express's Request type)
    // is a legitimate TypeScript declaration-merging pattern, not the kind
    // of runtime namespace this rule exists to discourage.
    "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
    "no-empty": ["error", { allowEmptyCatch: true }],
  },
  overrides: [
    {
      // The framework-agnostic boundary (CLAUDE.md constraint #5): these
      // four packages must never import Express (or Vayo's own Express
      // capture adapter) — only capture-express and the CLI's
      // app-bootstrapping adapter may touch the user's web framework.
      // @vayo/server is deliberately exempt (its own doc comment in
      // scripts/check-boundaries.mjs explains why).
      files: [
        "packages/schema-engine/src/**/*.ts",
        "packages/openapi-compiler/src/**/*.ts",
        "packages/db-mongo/src/**/*.ts",
        "packages/ui/src/**/*.{ts,tsx}",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              { name: "express", message: "framework-agnostic boundary: this package must never import Express (docs/08-packages-and-repo-structure.md)." },
              { name: "@vayo/capture-express", message: "framework-agnostic boundary: this package must never import @vayo/capture-express (docs/08-packages-and-repo-structure.md)." },
            ],
          },
        ],
      },
    },
    {
      // The only package with React in the whole workspace.
      files: ["packages/ui/src/**/*.{ts,tsx}"],
      plugins: ["react", "react-hooks"],
      extends: ["plugin:react/recommended", "plugin:react/jsx-runtime", "plugin:react-hooks/recommended"],
      settings: { react: { version: "18.3" } },
      rules: {
        // Every route/component here already destructures props directly
        // (no React.FC-style typing) — this rule is about detecting props
        // that were only used for prop-types validation, which this
        // TypeScript-only codebase has no use for.
        "react/prop-types": "off",
        // A literal apostrophe/quote in JSX text ("doesn't", "the user's")
        // renders correctly in every real browser — this rule exists for
        // legacy XHTML-strict compliance, not a real issue here. Off by
        // default in most modern React setups (Next.js's own included) for
        // exactly this reason.
        "react/no-unescaped-entities": "off",
      },
    },
  ],
};
