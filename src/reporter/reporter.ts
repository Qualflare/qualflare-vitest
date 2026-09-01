import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Reporter, TestModule, Vitest } from 'vitest/node';

import { resolveConfig, type QualflareVitestOptions, type ResolvedReporterConfig } from '../config/resolve-config.js';
import { logger } from '../shared/logger.js';
import { AttachmentBudget } from './attachment-reader.js';
import { buildCase } from './case-builder.js';
import { buildCollectPayload } from './collect-builder.js';
import { groupIntoSuites, relativizeFile, type CaseWithFile } from './suite-builder.js';

/**
 * The Qualflare Vitest reporter.
 *
 * Writes ONE uniquely-named JSON report per process into `outputDir` and makes
 * zero network calls. `qualflare-cli collect <outputDir>` uploads the result —
 * which is what lets any number of sharded jobs write into one directory and
 * merge into a single Launch.
 *
 * Registered in `vitest.config.ts`:
 *
 * ```ts
 * export default defineConfig({
 *   test: {
 *     reporters: [['default'], ['@qualflare/vitest/reporter', { environment: 'staging' }]],
 *   },
 * });
 * ```
 */
export default class QualflareReporter implements Reporter {
  private readonly options: QualflareVitestOptions;
  private config?: ResolvedReporterConfig;
  private rootDir = process.cwd();
  private budget = new AttachmentBudget(0);

  constructor(options: QualflareVitestOptions = {}) {
    this.options = options;
  }

  onInit(vitest: Vitest): void {
    this.guard('onInit', () => {
      this.rootDir = vitest.config.root || process.cwd();

      // Vitest's shard index is 1-BASED ("--shard=1/3" is the first shard);
      // ours is 0-based, matching every other Qualflare reporter.
      const shard = vitest.config.shard;
      const detectedShardIndex = shard ? shard.index - 1 : undefined;

      this.config = resolveConfig(this.options, { detectedShardIndex });
      this.budget = new AttachmentBudget(this.config.maxTotalAttachmentBytes);
    });
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    this.guard('onTestRunEnd', () => {
      const config = this.config;
      if (!config || !config.enabled) {
        return;
      }
      this.writeReport(config, testModules);
    });
  }

  /**
   * Everything is read here rather than per-test, and that is a deliberate
   * simplification over `@qualflare/playwright`.
   *
   * That reporter must resolve attachments in `onTestEnd`, because Playwright's
   * `use.preserveOutput` deletes a previous attempt's artifacts the moment a
   * retry passes — by its `onEnd` the screenshots and videos are simply gone.
   * It then needs per-attempt bookkeeping to discard superseded attempts so
   * their videos are not orphaned and their bytes not held against the budget.
   *
   * Vitest has none of that. It records no video, deletes no user files, and
   * hands `onTestRunEnd` the finished module tree with each test's annotations
   * and `task.meta` still attached. `TestCase.diagnostic()` also reports
   * `retryCount` and a native `flaky` flag, so there is no need to observe
   * individual attempts to work out flakiness. One pass over the tree is both
   * simpler and less able to go wrong.
   */
  private writeReport(config: ResolvedReporterConfig, testModules: ReadonlyArray<TestModule>): void {
    const cases: CaseWithFile[] = [];

    for (const testModule of testModules) {
      const file = relativizeFile(testModule.moduleId, this.rootDir);
      for (const testCase of testModule.children.allTests()) {
        const built = buildCase(testCase, config, this.budget);
        if (!built) {
          continue;
        }
        built.className = file;
        if (built.properties) {
          built.properties['file'] = file;
        }
        cases.push({ file, testCase: built });
      }
    }

    const suites = groupIntoSuites(cases);
    if (suites.length === 0) {
      logger.info('no test results were captured this run — skipping file write.');
      return;
    }

    const collect = buildCollectPayload(suites, config, []);

    if (config.shardIndex !== undefined) {
      for (const suite of collect.suites) {
        for (const testCase of suite.cases) {
          testCase.shardIndex = config.shardIndex;
        }
      }
    }

    const outputDir = this.resolveOutputDir(config.outputDir);

    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${randomUUID()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(collect));
    logger.info(`wrote Collect payload to ${outputPath} — run \`qualflare-cli collect ${outputDir}\` to upload it.`);
  }

  /** Relative `outputDir` resolves against the Vitest project root, not the
   * shell's cwd — a user running `vitest` from a monorepo root should still
   * write next to their config. */
  private resolveOutputDir(outputDir: string): string {
    return path.isAbsolute(outputDir) ? outputDir : path.resolve(this.rootDir, outputDir);
  }

  /**
   * A reporter that throws should not take the test run with it, and should
   * not vanish silently either. Every hook body runs through this so a bug
   * here says what broke and where, then lets the run finish.
   */
  private guard(hook: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      logger.error(`${hook} failed: ${(err as Error).message}`);
    }
  }
}
