import type { Platform } from '../shared/types.js';
import { detectCi, type CiMetadata } from './ci-detect.js';
import { detectGit, type GitInfo } from './git-detect.js';

/** Options for the reporter, passed as the second element of its entry in
 * `vitest.config.ts`'s `test.reporters` array:
 * `[['@qualflare/vitest/reporter', { ... }]]`. Every field here also has an
 * environment-variable override — see the precedence table in
 * `docs/CONFIGURATION.md`. */
export interface QualflareVitestOptions {
  environment?: string;
  language?: string;
  milestone?: number | null;
  branch?: string | null;
  commit?: string | null;
  platform?: Platform;
  framework?: string;
  os?: string;
  browser?: string;
  properties?: Record<string, string>;
  /** Max 64 chars. Free text, no enum — an unrecognized CI provider must
   * never be rejected. Auto-detected via `ci-detect.ts` when omitted. */
  ciProvider?: string;
  ciBuildNumber?: string;
  ciRunUrl?: string;
  ciPrNumber?: number;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  debug?: boolean;
  /** `false` fully disables accumulation/upload (a complete no-op) but the
   * reporter still no-ops cleanly rather than throwing. */
  enabled?: boolean;
  /** Directory `onEnd()` writes this process's report file (and any
   * video attachments) into. Default `./qualflare-results`. Always active —
   * this reporter never uploads anything itself; `qualflare-cli` reads
   * whatever ends up in this directory. Every JSON file this process writes
   * is uniquely named, so multiple shards can safely share one `outputDir`
   * without colliding — see docs/LIMITATIONS.md. */
  outputDir?: string;
  /** This process's 0-based position among parallel shards of the same CI
   * run, stamped onto every case it reports. Purely a label: `qualflare-cli`
   * merges by "every file in the directory", not by this value, so an
   * unset shardIndex costs attribution, never correctness.
   *
   * Auto-detected, in order: `QUALFLARE_SHARD_INDEX`, then Vitest's own
   * `--shard i/N`, which the resolved config exposes as
   * `vitest.config.shard` ({ index, count }) and the reporter reads in
   * `onInit`. That `index` is 1-BASED, matching the `--shard=2/3` CLI form,
   * so the reporter converts it before passing it here as
   * `deps.detectedShardIndex`.
   *
   * Vitest and Playwright both hand this to the reporter directly. Cypress
   * has no shard concept at all, and cucumber-js hides its `--shard` from
   * formatters entirely, forcing an argv scrape. */
  shardIndex?: number;
}

export interface ResolvedReporterConfig {
  environment: string;
  language: string;
  milestone: number | null;
  branch: string | null;
  commit: string | null;
  platform: Platform;
  framework: string;
  os?: string;
  browser?: string;
  properties?: Record<string, string>;
  ciProvider?: string;
  ciBuildNumber?: string;
  ciRunUrl?: string;
  ciPrNumber?: number;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  debug: boolean;
  enabled: boolean;
  outputDir: string;
  shardIndex?: number;
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

function envBool(...names: string[]): boolean | undefined {
  const raw = firstEnv(...names);
  if (raw === undefined) {
    return undefined;
  }
  return raw === 'true' || raw === '1';
}

function envInt(...names: string[]): number | undefined {
  const raw = firstEnv(...names);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}


/** Resolves the full reporter configuration from, in order: the explicit
 * `options` (the second element of the `vitest.config.ts` reporter
 * tuple, `['@qualflare/vitest', { ... }]`), then `QUALFLARE_*`
 * environment variables, then `QF_*` (compat alias with the existing Go
 * CLI, where an equivalent exists), then a hardcoded default.
 *
 * Branch/commit precedence: `options.branch`/`.commit` (including an
 * explicit `null`, which is respected as "no auto-detection wanted" rather
 * than triggering the fallback tiers below it) > `QUALFLARE_BRANCH`/
 * `QF_BRANCH` env (and the commit equivalent) > CI-provider env vars > a
 * local `git` subprocess (`git-detect.ts`) > `null`. The subprocess tier is
 * skipped entirely — no `git` process is forked — once both branch and
 * commit are already resolved from options/env, mirroring
 * `qualflare-cli/internal/config/config.go`'s `DetectGit`'s early return.
 *
 * CI-metadata precedence (`ciProvider`/`ciBuildNumber`/`ciRunUrl`/
 * `ciPrNumber`): the corresponding `options.ci*` field, else `ci-detect.ts`'s
 * auto-detection (per-provider extraction table, falling back to the
 * `ci-info` package's ~70-provider free-text name).
 *
 * `deps` lets tests inject fake `detectGit`/`detectCi` implementations
 * instead of the real ones (which shell out to `git` and read the real
 * `process.env`/`ci-info` module state) — defaults to the real detectors,
 * so every production call site (the reporter's constructor calls
 * `resolveConfig(options)` with no second argument) is unaffected.
 */
export function resolveConfig(
  options: QualflareVitestOptions,
  deps: { detectGit?: () => GitInfo; detectCi?: () => CiMetadata;
    /** Vitest's `config.shard.index`, already converted from its 1-based
     * `current` to our 0-based index by the reporter. */
    detectedShardIndex?: number;
  } = {},
): ResolvedReporterConfig {
  const doDetectGit = deps.detectGit ?? detectGit;
  const doDetectCi = deps.detectCi ?? detectCi;

  const enabled = options.enabled ?? envBool('QUALFLARE_ENABLED') ?? true;
  // `||`, not `??` — matching `environment`/`language` below: an explicit
  const outputDir = options.outputDir || firstEnv('QUALFLARE_OUTPUT_DIR') || './qualflare-results';
  const shardIndex = options.shardIndex ?? envInt('QUALFLARE_SHARD_INDEX') ?? deps.detectedShardIndex;

  const milestoneRaw = options.milestone !== undefined ? options.milestone : envInt('QUALFLARE_MILESTONE', 'QF_MILESTONE');
  const milestone = milestoneRaw !== undefined && milestoneRaw !== null && milestoneRaw >= 1 ? milestoneRaw : null;

  const envBranch = firstEnv('QUALFLARE_BRANCH', 'QF_BRANCH');
  const envCommit = firstEnv('QUALFLARE_COMMIT', 'QF_COMMIT');
  const needsGitDetection =
    (options.branch === undefined && envBranch === undefined) ||
    (options.commit === undefined && envCommit === undefined);
  const detectedGit = needsGitDetection ? doDetectGit() : {};

  const branch = options.branch !== undefined ? options.branch : (envBranch ?? detectedGit.branch ?? null);
  const commit = options.commit !== undefined ? options.commit : (envCommit ?? detectedGit.commit ?? null);

  const detectedCi = doDetectCi();
  const ciProvider = options.ciProvider ?? detectedCi.ciProvider;
  const ciBuildNumber = options.ciBuildNumber ?? detectedCi.ciBuildNumber;
  const ciRunUrl = options.ciRunUrl ?? detectedCi.ciRunUrl;
  const ciPrNumber = options.ciPrNumber ?? detectedCi.ciPrNumber;

  return {
    // `||` (truthy check), not `??`, for these three REQUIRED-non-empty wire
    // fields — an explicit `''` option must not silently win over the
    // default (the server rejects an empty `environment`). Ported verbatim from
    // qualflare-cypress, where this was found via deep adversarial review.
    environment: (options.environment || undefined) ?? firstEnv('QUALFLARE_ENVIRONMENT', 'QF_ENVIRONMENT') ?? 'development',
    language: (options.language || undefined) ?? firstEnv('QUALFLARE_LANGUAGE', 'QF_LANGUAGE') ?? 'en-US',
    milestone,
    branch,
    commit,
    platform: options.platform ?? 'web',
    framework: options.framework || 'vitest',
    os: options.os,
    browser: options.browser,
    properties: options.properties,
    ciProvider,
    ciBuildNumber,
    ciRunUrl,
    ciPrNumber,
    maxAttachmentBytes: options.maxAttachmentBytes ?? envInt('QUALFLARE_MAX_ATTACHMENT_BYTES') ?? 1_500_000,
    maxTotalAttachmentBytes:
      options.maxTotalAttachmentBytes ?? envInt('QUALFLARE_MAX_TOTAL_ATTACHMENT_BYTES') ?? 750_000,
    debug: options.debug ?? envBool('QUALFLARE_DEBUG', 'QF_DEBUG') ?? false,
    enabled,
    outputDir,
    shardIndex,
  };
}
