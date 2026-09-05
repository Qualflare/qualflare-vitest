import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import QualflareReporter from "../../src/reporter/reporter.js";

/**
 * A relative `outputDir` resolves against the Vitest ROOT's directory,
 * not the shell's cwd — and it must resolve to the SAME place for the report
 * and for every artifact beside it.
 *
 * This is a regression test. `resolveOutputDir` was applied only where the JSON
 * was written; the video, trace and screenshot writers each took the raw config
 * string, which resolves against the cwd. Running
 * `vitest run --config e2e/vitest.config.ts` from a repo root with
 * `outputDir: '../e2e-results'` put the report inside the repo and every
 * artifact one directory ABOVE it, leaving localVideoPath / localImagePath
 * pointing at files the CLI cannot find. Nothing failed; the report just
 * referenced absent files.
 *
 * The existing integration suites could not catch it: they pass an ABSOLUTE
 * mkdtempSync path, where both resolutions agree.
 */
describe('outputDir resolution', () => {
  const begin = (reporter: QualflareReporter, root: string) => {
    reporter.onInit({ config: { root } } as never);
    return (reporter as never as { config: { outputDir: string } }).config.outputDir;
  };

  it('resolves a relative outputDir against the Vitest root, not the cwd', () => {
    const reporter = new QualflareReporter({ outputDir: '../e2e-results' });
    expect(begin(reporter, '/repo/e2e')).toBe(path.resolve('/repo/e2e', '../e2e-results'));
  });

  it('leaves an absolute outputDir alone', () => {
    const reporter = new QualflareReporter({ outputDir: '/tmp/somewhere' });
    expect(begin(reporter, '/repo/e2e')).toBe('/tmp/somewhere');
  });

  it('resolves once, so a second pass is a no-op', () => {
    // The bug was two resolutions disagreeing. Whatever else changes, resolving
    // an already-resolved value must not move it.
    const reporter = new QualflareReporter({ outputDir: '../e2e-results' });
    const once = begin(reporter, '/repo/e2e');
    expect(path.resolve(once)).toBe(once);
    expect(path.isAbsolute(once)).toBe(true);
  });
});
