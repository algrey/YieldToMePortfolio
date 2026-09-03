import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Orchestrator hygiene (2026-09-03): Claude Code may create nested git
    // worktrees under `.claude/worktrees/` for spawned sessions; ESLint must
    // never walk into another checkout's files (it reported that worktree's
    // own lint state as this repository's).
    ".claude/**",
  ]),
  // BRK-003/BRK-004 review: `domain/sharesight/transport.ts` is the
  // package's raw GET-only fetch primitive. It must never be imported
  // directly outside `domain/sharesight/` itself -- the typed client
  // (`domain/sharesight/index.ts`) is the only sanctioned public surface,
  // so a caller elsewhere can never obtain the raw fetcher and structurally
  // cannot smuggle a non-GET request past the transport's own enforcement.
  // `tests/brk-003.test.ts` is the one documented exception: it imports the
  // primitive directly to exercise the GET-only enforcement itself (see
  // that file's comment on the import).
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/sharesight/transport",
                "**/sharesight/transport.ts",
                "@/domain/sharesight/transport",
                "@/domain/sharesight/transport.ts",
              ],
              message:
                "domain/sharesight/transport is package-internal; import the typed client from domain/sharesight/index.ts instead.",
            },
          ],
        },
      ],
      // BRK-004: closes the carry-over gap the BRK-003/BRK-004 hardening
      // review recorded -- `no-restricted-imports` above only inspects
      // static `import`/`export … from` specifiers, not a dynamic
      // `import("...")` call, which is a second, reachable way to obtain
      // the same package-internal raw fetch primitive. This rule matches an
      // `ImportExpression` whose source argument is a STRING LITERAL ending
      // in `sharesight/transport` (optionally `.ts`), the same path shape
      // the specifier patterns above bar.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportExpression[source.type='Literal'][source.value=/sharesight\\/transport(\\.ts)?$/]",
          message:
            "domain/sharesight/transport is package-internal; import the typed client from domain/sharesight/index.ts instead (dynamic import() is covered by this rule too, not only static imports).",
        },
        {
          // Review follow-up: a plain (no-substitution) template-literal
          // specifier -- `import(\`../domain/sharesight/transport.ts\`)` --
          // is a DIFFERENT AST node shape (`TemplateLiteral`, not
          // `Literal`) and escaped the selector above. A no-substitution
          // template literal has exactly one quasi and zero expressions;
          // its single quasi's cooked text is checked the same way the
          // string-literal selector checks `source.value`. A template
          // literal WITH an interpolated expression is not statically
          // determinable and is intentionally out of scope here, same as
          // any other computed specifier.
          selector:
            "ImportExpression[source.type='TemplateLiteral'][source.expressions.length=0][source.quasis.length=1][source.quasis.0.value.cooked=/sharesight\\/transport(\\.ts)?$/]",
          message:
            "domain/sharesight/transport is package-internal; import the typed client from domain/sharesight/index.ts instead (dynamic import() with a template-literal specifier is covered by this rule too).",
        },
      ],
    },
  },
  {
    files: ["domain/sharesight/**/*.ts", "tests/brk-003.test.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off",
    },
  },
]);

export default eslintConfig;
