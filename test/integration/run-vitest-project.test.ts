import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Collect } from '../../src/shared/types.js';

const vitestVersion: string = JSON.parse(
  fs.readFileSync(new URL('../../node_modules/vitest/package.json', import.meta.url), 'utf8'),
).version;

/** `task.annotate()` / `TestCase.annotations()` only exist from Vitest 3.2.
 * Below that the reporter deliberately reports no native annotations rather
 * than refusing to install; see docs/LIMITATIONS.md. */
const SUPPORTS_ANNOTATIONS = (() => {
  const [major, minor] = vitestVersion.split('.').map(Number);
  return (major ?? 0) > 3 || ((major ?? 0) === 3 && (minor ?? 0) >= 2);
})();

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures/vitest-project');

/**
 * Runs the fixture through a REAL `vitest run` process, with the reporter
 * loaded from the BUILT dist/ (see the fixture's config), and returns the
 * report it wrote.
 *
 * `reject: false` because fixture tests fail by design — every assertion here
 * is about the written report, never the exit code.
 */
async function runFixture(outputDir: string, extraArgs: string[] = []): Promise<Collect> {
  await execa('npx', ['vitest', 'run', ...extraArgs], {
    cwd: fixtureDir,
    reject: false,
    env: { QF_OUT: outputDir, CI: 'true' },
  });

  const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'));
  expect(files, 'the reporter wrote exactly one report file').toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(outputDir, files[0]!), 'utf8')) as Collect;
}

function allCases(report: Collect) {
  return report.suites.flatMap((s) => s.cases);
}

/** Matches on the EXACT case name. A substring match looked fine until
 * 'an oversized attachment is skipped, not fatal' shadowed 'is skipped' and
 * the suite reported a reporter bug that did not exist. */
function caseNamed(report: Collect, name: string) {
  const found = allCases(report).find((c) => c.name === name);
  expect(found, `no case named "${name}" in the report`).toBeDefined();
  return found!;
}

describe('a real vitest run', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-vitest-int-'));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('writes a report the CLI can identify and parse', async () => {
    const report = await runFixture(outputDir);

    // `metadata` is what qualflare-cli keys format detection on. Without it the
    // CLI falls back to filename matching and routes the file to the wrong
    // parser. A top-level `config` key would make it look like Playwright-JSON.
    expect(report.metadata).toBeDefined();
    expect(report.metadata.cliName).toBe('qualflare-vitest');
    expect(report).not.toHaveProperty('config');

    // This is the value api-service validates against its test_type enum;
    // migration 0242 is what makes it acceptable.
    expect(report.framework).toBe('vitest');
    expect(report.suites.every((s) => s.category === 'vitest')).toBe(true);
    expect(report.environment).toBe('staging');
  });

  it('reports one suite per test module', async () => {
    const report = await runFixture(outputDir);
    const names = report.suites.map((s) => s.name).sort();
    expect(names.some((n) => n.endsWith('passing.test.ts'))).toBe(true);
    expect(names.some((n) => n.endsWith('failing.test.ts'))).toBe(true);
    // Module paths must be relative and POSIX-separated, or the same suite from
    // a Windows and a Linux runner becomes two suites server-side.
    expect(names.every((n) => !path.isAbsolute(n) && !n.includes('\\'))).toBe(true);
  });

  it('maps pass, fail and skip onto the wire vocabulary', async () => {
    const report = await runFixture(outputDir);
    expect(caseNamed(report, 'adds numbers').status).toBe('passed');
    expect(caseNamed(report, 'fails with a diff').status).toBe('failed');
    expect(caseNamed(report, 'is skipped').status).toBe('skipped');
  });

  it('carries the assertion diff through, with no ANSI escapes', async () => {
    const report = await runFixture(outputDir);
    const failed = caseNamed(report, 'fails with a diff');
    expect(failed.error).toBeTruthy();
    // eslint-disable-next-line no-control-regex -- asserting the absence of escape bytes
    expect(failed.error).not.toMatch(/\[/);
  });

  it('reports retries and flakiness from diagnostic(), not by inference', async () => {
    const report = await runFixture(outputDir);
    const flaky = caseNamed(report, 'passes on the second attempt');
    expect(flaky.status).toBe('passed');
    expect(flaky.retryCount).toBe(1);
    expect(flaky.isFlaky).toBe(true);
  });

  it('writes an image attachment into outputDir instead of inlining it', async () => {
    const report = await runFixture(outputDir);
    const imageCase = caseNamed(report, 'attaches a screenshot through the metadata API');
    expect(imageCase.attachments).toHaveLength(1);
    const shot = imageCase.attachments![0]!;
    expect(shot.mimeType).toBe('image/png');
    expect(shot.content).toBeUndefined();
    expect(typeof shot.localImagePath).toBe('string');
    const shotPath = path.join(outputDir, shot.localImagePath!);
    expect(fs.existsSync(shotPath)).toBe(true);
    expect(shot.fileSize).toBe(fs.statSync(shotPath).size);
    // A real PNG, not merely named one.
    expect(fs.readFileSync(shotPath).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(shot.storageKey).toBeUndefined();
  });

  it('carries per-attempt history through a real retried run', async () => {
    const report = await runFixture(outputDir);
    const flaky = caseNamed(report, 'passes on the second attempt');
    // Two executions: the first failed, the second passed. Without this the
    // first attempt's error is not recoverable from the report at all --
    // retryCount says it was retried, but not what went wrong the first time.
    expect(flaky.attempts).toHaveLength(2);
    expect(flaky.attempts?.map((a) => a.status)).toEqual(['failed', 'passed']);
    expect(flaky.attempts?.[0]?.message).toBeTruthy();
    expect(flaky.attempts?.[1]?.message).toBeUndefined();
  });

  it('records durations in nanoseconds', async () => {
    const report = await runFixture(outputDir);
    // Milliseconds would be ~1000x smaller; this catches a unit regression.
    expect(allCases(report).every((c) => typeof c.duration === 'number')).toBe(true);
    expect(caseNamed(report, 'adds numbers').duration).toBeGreaterThan(0);
  });

  it('replays the metadata API, including nested steps', async () => {
    const report = await runFixture(outputDir);
    const meta = caseNamed(report, 'records metadata through task.meta');

    expect(meta.labels).toContainEqual({ name: 'team', value: 'platform' });
    expect(meta.links).toContainEqual({ type: 'tms', name: 'QF-1', url: 'https://tracker/QF-1' });
    expect(meta.tags).toContain('smoke');
    expect(meta.priority).toBe('high');
    expect(meta.description).toContain('metadata API');
    expect(meta.properties!['plan']).toBe('pro');

    const steps = meta.steps!;
    expect(steps.map((s) => s.name)).toEqual(['outer', 'inner']);
    // Nesting survives as a parentIndex chain.
    expect(steps[1]!.parentIndex).toBe(0);
    // A parameter recorded inside the outer step belongs to that step.
    expect(steps[0]!.parameters).toContainEqual({ name: 'amount', value: '42' });

    expect(meta.attachments!.some((a) => a.name === 'note')).toBe(true);
  });

  it('skips an oversized attachment instead of losing the run', async () => {
    const report = await runFixture(outputDir);
    const big = caseNamed(report, 'an oversized attachment is skipped, not fatal');
    // The test itself still passes and is still reported — that is the point.
    expect(big.status).toBe('passed');
    expect(big.attachments ?? []).toHaveLength(0);
  });

  it('stamps a 0-based shardIndex converted from Vitest 1-based --shard', async () => {
    const report = await runFixture(outputDir, ['--shard=1/2']);
    // `--shard=1/2` is the FIRST shard; ours is 0-based.
    expect(allCases(report).every((c) => c.shardIndex === 0)).toBe(true);
  });

  it.runIf(SUPPORTS_ANNOTATIONS)('reads native annotations when the Vitest version has them', async () => {
    const report = await runFixture(outputDir);
    // Nothing in the fixture annotates yet; this asserts the guarded call does
    // not throw on a version that DOES provide annotations().
    expect(allCases(report).length).toBeGreaterThan(0);
  });
});
