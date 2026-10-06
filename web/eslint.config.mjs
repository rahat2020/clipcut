import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Client components ("use client") must not import VALUES from the "@/shared" index: it
 * pulls Mongoose into the browser bundle and the page fails with "Can't resolve
 * 'async_hooks'" — typecheck can't see it. Types are fine (`import type`), and values come
 * from "@/shared/enums". Broke /admin/ai on 2026-09-30.
 */
const noSharedBarrelInClient = {
  meta: { type: "problem", messages: { barrel: 'Client component imports a value from "@/shared" (pulls in Mongoose). Use `import type`, or import from "@/shared/enums".' } },
  create(context) {
    const isClient = context.sourceCode.ast.body.some(
      (node) => node.type === "ExpressionStatement" && node.directive === "use client",
    );
    if (!isClient) return {};
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "@/shared" || node.importKind === "type") return;
        const hasValue = node.specifiers.some((s) => s.type !== "ImportSpecifier" || s.importKind !== "type");
        if (hasValue) context.report({ node, messageId: "barrel" });
      },
    };
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { local: { rules: { "no-shared-barrel-in-client": noSharedBarrelInClient } } },
    rules: { "local/no-shared-barrel-in-client": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Screenshots and the headless Chrome profile (its extensions are minified JS).
    ".scratch/**",
  ]),
]);

export default eslintConfig;
