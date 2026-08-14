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
    },
  },
  {
    files: ["domain/sharesight/**/*.ts", "tests/brk-003.test.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
]);

export default eslintConfig;
