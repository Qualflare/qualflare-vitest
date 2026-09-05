import { defineConfig } from 'vitest/config';

/**
 * The dogfood suite: qualflare-vitest reporting on tests of itself.
 *
 * This repo is the one case where the dogfood suite runs on the SAME runner as
 * the repo's own tests, so the separation is deliberate and threefold:
 *
 *  1. Its own config file. The root vitest.config.ts never loads this one and
 *     never registers the Qualflare reporter, so `npm test` and
 *     `npm run test:integration` do not report themselves.
 *  2. The `*.e2e.ts` extension, not `*.test.ts`. Even if someone later widens
 *     the root `include` to `test/**\/*.test.ts`, these files still do not match.
 *  3. A directory outside the root config's include globs, which scope to
 *     `test/**`.
 *
 * The reporter is loaded from BUILT dist/, so `npm run build` is a prerequisite
 * and the suite exercises what actually ships.
 */
export default defineConfig({
  // Anchored to THIS FILE's directory. Vitest resolves `include` (and the rest)
  // against `root`, which defaults to the CWD -- the repo root when the npm
  // script runs. Without this, `tests/**` would look for <repo>/tests and find
  // nothing. Each of the four reporters' runners uses a different base for
  // relative paths, so none of them is safe to assume.
  root: new URL('.', import.meta.url).pathname,
  test: {
    include: ['tests/**/*.e2e.ts'],
    // ZERO global retries, deliberately. The retry is scoped to the one
    // intentionally-flaky test via its own `retry` option; a global retry would
    // silently re-run and green a GENUINE regression, in the suite whose red is
    // meant to mean something.
    retry: 0,
    // Deterministic ordering; the report is asserted case by case afterwards.
    fileParallelism: false,
    reporters: [
      ['default'],
      [
        new URL('../dist/reporter/index.js', import.meta.url).pathname,
        {
          outputDir: process.env['QUALFLARE_OUTPUT_DIR'] ?? '../e2e-results',
          // Recorded in the report itself rather than passed at collect time,
          // so there is one source of truth for the environment.
          environment: 'production',
          branch: null,
          commit: null,
        },
      ],
    ],
  },
});
