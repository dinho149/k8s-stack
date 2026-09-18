// @ts-check
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      // the adapters talk to loosely typed platform SDKs; `any` at those seams is deliberate
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
      // bracket access on our own records is not user-controlled injection; the real checks are the
      // typed parsers (parseJsonObject, zod) and are covered by tests
      "security/detect-object-injection": "off",
      // every fs path here comes from configuration (SESSION_FILE, IDENTITY_MAP_FILE, <NAME>_FILE, tmpdir), never
      // from chat input; the modes are what matter and are asserted in test/session-store.test.ts
      "security/detect-non-literal-fs-filename": "off",
    },
  },
);
