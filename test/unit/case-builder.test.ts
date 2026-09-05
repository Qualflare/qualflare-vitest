import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCase } from '../../src/reporter/case-builder.js';
import { AttachmentBudget } from '../../src/reporter/attachment-reader.js';
import { QUALFLARE_META_KEY } from '../../src/shared/constants.js';
import type { ResolvedReporterConfig } from '../../src/config/resolve-config.js';
import type { RuntimeMessage } from '../../src/runtime/message-types.js';

function config(over: Partial<ResolvedReporterConfig> = {}): ResolvedReporterConfig {
  return {
    maxAttachmentBytes: 100_000,
    maxTotalAttachmentBytes: 500_000,
    ...over,
  } as ResolvedReporterConfig;
}

/**
 * A stand-in for Vitest's `TestCase`, carrying only what `buildCase` reads.
 *
 * Hand-rolled rather than constructed through Vitest, because building a real
 * `TestCase` requires a running Vitest instance — and every field asserted
 * here was read off the shipped v4 type definitions, so a drift in the real
 * shape would surface as a typecheck failure in `buildCase` itself rather than
 * silently here.
 */
function fakeTestCase(over: {
  state?: 'passed' | 'failed' | 'skipped';
  errors?: { message?: string; stack?: string; diff?: string }[];
  meta?: RuntimeMessage[];
  tags?: string[];
  retryCount?: number;
  flaky?: boolean;
  duration?: number;
  annotations?: unknown;
} = {}) {
  const base = {
    id: 'test-1',
    fullName: 'suite > does a thing',
    module: { moduleId: '/repo/src/example.test.ts' },
    tags: over.tags ?? [],
    result: () => ({ state: over.state ?? 'passed', errors: over.errors }),
    diagnostic: () => ({
      duration: over.duration ?? 5,
      startTime: 1_700_000_000_000,
      retryCount: over.retryCount ?? 0,
      flaky: over.flaky ?? false,
      slow: false,
      heap: undefined,
      repeatCount: 0,
    }),
    meta: () => (over.meta ? { [QUALFLARE_META_KEY]: over.meta } : {}),
  } as Record<string, unknown>;
  if (over.annotations !== undefined) {
    base['annotations'] = over.annotations;
  }
  return base as never;
}

describe('buildCase — result mapping', () => {
  it('maps Vitest states onto the wire vocabulary', () => {
    expect(buildCase(fakeTestCase({ state: 'passed' }), config(), new AttachmentBudget(0))!.status).toBe('passed');
    expect(buildCase(fakeTestCase({ state: 'failed' }), config(), new AttachmentBudget(0))!.status).toBe('failed');
    expect(buildCase(fakeTestCase({ state: 'skipped' }), config(), new AttachmentBudget(0))!.status).toBe('skipped');
  });

  it('reports duration in NANOseconds, not the milliseconds Vitest gives', () => {
    const built = buildCase(fakeTestCase({ duration: 5 }), config(), new AttachmentBudget(0))!;
    expect(built.duration).toBe(5_000_000);
  });

  it('takes retryCount and flakiness from diagnostic(), not by inferring them', () => {
    // The whole reason this reporter needs no per-attempt bookkeeping: Vitest
    // reports both directly, unlike Playwright where flakiness has to be
    // derived from test.outcome() after every retry has run.
    const built = buildCase(fakeTestCase({ retryCount: 2, flaky: true }), config(), new AttachmentBudget(0))!;
    expect(built.retryCount).toBe(2);
    expect(built.isFlaky).toBe(true);
  });

  it('renders every error, not only the first — expect.soft() accumulates several', () => {
    const built = buildCase(
      fakeTestCase({
        state: 'failed',
        errors: [{ message: 'first failed' }, { message: 'second failed' }],
      }),
      config(),
      new AttachmentBudget(0),
    )!;
    expect(built.error).toContain('first failed');
    expect(built.error).toContain('second failed');
  });

  it('includes the assertion diff, which is the useful part of a Vitest failure', () => {
    const built = buildCase(
      fakeTestCase({ state: 'failed', errors: [{ message: 'nope', diff: '- 1\n+ 2' }] }),
      config(),
      new AttachmentBudget(0),
    )!;
    expect(built.error).toContain('- 1');
  });
});

describe('buildCase — metadata replay', () => {
  it('replays labels, links and tags off task.meta', () => {
    const built = buildCase(
      fakeTestCase({
        tags: ['native'],
        meta: [
          { type: 'label', name: 'team', value: 'platform' },
          { type: 'link', url: 'https://tracker/QF-1', linkType: 'tms', name: 'QF-1' },
          { type: 'tag', tags: ['runtime'] },
        ],
      }),
      config(),
      new AttachmentBudget(0),
    )!;
    expect(built.labels).toEqual([{ name: 'team', value: 'platform' }]);
    expect(built.links).toEqual([{ type: 'tms', name: 'QF-1', url: 'https://tracker/QF-1' }]);
    // Vitest's own tags and qualflare.tag() are merged, not one or the other.
    expect(built.tags).toEqual(['native', 'runtime']);
  });

  it('synthesizes a step from a start/stop pair, with real elapsed time', () => {
    // Vitest has no test.step() to delegate to, so if replayMetadata does not
    // build the step, nothing does.
    const built = buildCase(
      fakeTestCase({
        meta: [
          { type: 'step_start', name: 'pay', timestamp: 1000 },
          { type: 'step_stop', status: 'passed', timestamp: 1025 },
        ],
      }),
      config(),
      new AttachmentBudget(0),
    )!;
    expect(built.steps).toHaveLength(1);
    expect(built.steps![0]).toMatchObject({ name: 'pay', status: 'passed', duration: 25_000_000 });
  });

  it('nests steps via parentIndex', () => {
    const built = buildCase(
      fakeTestCase({
        meta: [
          { type: 'step_start', name: 'outer', timestamp: 0 },
          { type: 'step_start', name: 'inner', timestamp: 1 },
          { type: 'step_stop', status: 'passed', timestamp: 2 },
          { type: 'step_stop', status: 'passed', timestamp: 3 },
        ],
      }),
      config(),
      new AttachmentBudget(0),
    )!;
    expect(built.steps!.map((s) => [s.name, s.parentIndex])).toEqual([
      ['outer', undefined],
      ['inner', 0],
    ]);
  });

  it('records a failed step with its error', () => {
    const built = buildCase(
      fakeTestCase({
        meta: [
          { type: 'step_start', name: 'pay', timestamp: 0 },
          { type: 'step_stop', status: 'failed', error: 'card declined', timestamp: 5 },
        ],
      }),
      config(),
      new AttachmentBudget(0),
    )!;
    expect(built.steps![0]).toMatchObject({ status: 'failed', error: 'card declined' });
  });

  it('puts a parameter inside the open step, and outside any step into properties', () => {
    const built = buildCase(
      fakeTestCase({
        meta: [
          { type: 'parameter', name: 'plan', value: 'pro' },
          { type: 'step_start', name: 'pay', timestamp: 0 },
          { type: 'parameter', name: 'amount', value: '42' },
          { type: 'step_stop', status: 'passed', timestamp: 1 },
        ],
      }),
      config(),
      new AttachmentBudget(0),
    )!;
    expect(built.properties!['plan']).toBe('pro');
    expect(built.steps![0]!.parameters).toEqual([{ name: 'amount', value: '42' }]);
  });

  it('ignores meta that is absent or not ours', () => {
    expect(buildCase(fakeTestCase({}), config(), new AttachmentBudget(0))!.steps).toBeUndefined();
  });
});

describe('buildCase — attachments draw on the shared budget', () => {
  it('inlines a metadata attachment and charges the budget', () => {
    const budget = new AttachmentBudget(1000);
    const built = buildCase(
      fakeTestCase({
        meta: [
          { type: 'attachment', name: 'note', contentBase64: Buffer.from('hello').toString('base64') },
        ],
      }),
      config(),
      budget,
    )!;
    expect(built.attachments).toHaveLength(1);
    expect(budget.usedBytes).toBe(5);
  });

  it('skips an over-budget attachment rather than losing the whole launch', () => {
    // /collect rejects a body over 10MB outright, and a rejected request loses
    // every result in the run — not just the oversized attachment.
    const budget = new AttachmentBudget(2);
    const built = buildCase(
      fakeTestCase({
        meta: [
          { type: 'attachment', name: 'big', contentBase64: Buffer.alloc(50).toString('base64') },
        ],
      }),
      config(),
      budget,
    )!;
    expect(built.attachments).toBeUndefined();
    expect(budget.usedBytes).toBe(0);
  });
});

describe('buildCase — version tolerance', () => {
  it('survives a Vitest without annotations(), which only exists from 3.2', () => {
    // The peer floor is >=3.0.0. Calling annotations() unguarded on 3.0/3.1
    // would throw — the same trap as Playwright's TestCase.tags at 1.42 under
    // a declared 1.40 floor.
    const built = buildCase(fakeTestCase({ annotations: undefined }), config(), new AttachmentBudget(0));
    expect(built).toBeDefined();
    expect(built!.attachments).toBeUndefined();
  });

  it('reads annotations() when the Vitest version does provide it', () => {
    const built = buildCase(
      fakeTestCase({
        annotations: () => [
          { message: 'shot', type: 'attachment', attachment: { body: Buffer.from('x').toString('base64') } },
        ],
      }),
      config(),
      new AttachmentBudget(1000),
    )!;
    expect(built.attachments).toHaveLength(1);
    expect(built.attachments![0]!.name).toBe('shot');
  });
});

/**
 * The counts below are not invented — they were measured against vitest 3.2.7
 * by running a test that fails with a distinct message per attempt:
 *
 *   flaky (passes on the 3rd):  retryCount=2, errors=2
 *   never passes (retry: 3):    retryCount=3, errors=4
 *   never retried:              retryCount=0, errors=0
 *   two expect.soft() x 3 runs: retryCount=2, errors=6   <- ambiguous
 *
 * If a future Vitest changes how `result.errors` accumulates, these are the
 * assertions that should fail.
 */
describe('buildCase — per-attempt history', () => {
  const build = (over: Parameters<typeof fakeTestCase>[0]) =>
    buildCase(fakeTestCase(over), config(), new AttachmentBudget(0))!;

  it('omits attempts entirely for a test that was never retried', () => {
    const built = build({ state: 'passed', retryCount: 0 });
    expect(built.attempts).toBeUndefined();
  });

  it('reconstructs a flaky run: earlier attempts failed, the final one passed', () => {
    const built = build({
      state: 'passed',
      retryCount: 2,
      flaky: true,
      errors: [{ message: 'failure on attempt 1' }, { message: 'failure on attempt 2' }],
    });
    expect(built.attempts).toHaveLength(3);
    expect(built.attempts!.map((a) => a.status)).toEqual(['failed', 'failed', 'passed']);
    expect(built.attempts!.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(built.attempts![0]!.message).toBe('failure on attempt 1');
    expect(built.attempts![1]!.message).toBe('failure on attempt 2');
    // The final attempt passed, so it contributed no error and carries none.
    expect(built.attempts![2]!.message).toBeUndefined();
  });

  it('reconstructs a run where every attempt failed', () => {
    const built = build({
      state: 'failed',
      retryCount: 3,
      errors: [{ message: 'A-1' }, { message: 'A-2' }, { message: 'A-3' }, { message: 'A-4' }],
    });
    expect(built.attempts).toHaveLength(4);
    expect(built.attempts!.every((a) => a.status === 'failed')).toBe(true);
    expect(built.attempts!.map((a) => a.message)).toEqual(['A-1', 'A-2', 'A-3', 'A-4']);
  });

  it('sends nothing rather than guessing when expect.soft() blurs the boundaries', () => {
    // 3 executions x 2 soft failures. Nothing in the payload says which error
    // belongs to which attempt, and 6 could equally be 3+2+1.
    const built = build({
      state: 'failed',
      retryCount: 2,
      errors: Array.from({ length: 6 }, (_, i) => ({ message: `soft-${i}` })),
    });
    expect(built.attempts).toBeUndefined();
    // The Case still reports the retry aggregate and the combined error text,
    // exactly as it did before per-attempt history existed.
    expect(built.retryCount).toBe(2);
    expect(built.error).toContain('soft-0');
  });

  it('puts the stack in trace, not message, since Vitest keeps them separate', () => {
    const built = build({
      state: 'failed',
      retryCount: 1,
      errors: [
        { message: 'boom', stack: 'at foo (a.ts:1:1)' },
        { message: 'boom again', stack: 'at bar (b.ts:2:2)' },
      ],
    });
    expect(built.attempts![0]!.message).toBe('boom');
    expect(built.attempts![0]!.trace).toBe('at foo (a.ts:1:1)');
  });

  it('folds a diff into the message, where the server expects it', () => {
    const built = build({
      state: 'failed',
      retryCount: 1,
      errors: [
        { message: 'mismatch', diff: '- 1\n+ 2' },
        { message: 'mismatch', diff: '- 1\n+ 2' },
      ],
    });
    expect(built.attempts![0]!.message).toBe('mismatch\n\n- 1\n+ 2');
  });

  it('keeps the final attempt when trimming past the server cap', () => {
    const n = 60;
    const built = build({
      state: 'failed',
      retryCount: n - 1,
      errors: Array.from({ length: n }, (_, i) => ({ message: `e-${i}` })),
    });
    expect(built.attempts).toHaveLength(50);
    // First 49 plus the LAST one — a plain slice(0, 50) would drop the final
    // attempt, which is the one carrying the outcome.
    expect(built.attempts![48]!.message).toBe('e-48');
    expect(built.attempts![49]!.message).toBe(`e-${n - 1}`);
    expect(built.attempts![49]!.attempt).toBe(n);
  });

  it('truncates an oversized attempt message to the cap the server stores', () => {
    const built = build({
      state: 'failed',
      retryCount: 1,
      errors: [{ message: 'x'.repeat(20_000) }, { message: 'y' }],
    });
    expect(built.attempts![0]!.message).toHaveLength(8192);
  });

  it('never sets a per-attempt duration, which Vitest does not expose', () => {
    const built = build({
      state: 'passed',
      retryCount: 1,
      errors: [{ message: 'once' }],
    });
    // Filling these from the run-wide aggregate would claim each attempt took
    // the whole time.
    expect(built.attempts!.every((a) => a.duration === undefined)).toBe(true);
    expect(built.attempts!.every((a) => a.startedAt === undefined)).toBe(true);
  });
});

describe('buildCase — screenshots travel out of band', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'qf-cb-image-'));
  });

  afterEach(() => {
    nodeFs.rmSync(outDir, { recursive: true, force: true });
  });

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('writes a qualflare.attachment() image into outputDir instead of inlining it', () => {
    const built = buildCase(
      fakeTestCase({
        meta: [
          {
            type: 'attachment',
            name: 'shot',
            mimeType: 'image/png',
            contentBase64: PNG.toString('base64'),
          },
        ] as never,
      }),
      config({ outputDir: outDir }),
      new AttachmentBudget(500_000),
    )!;

    const shot = built.attachments!.find((a) => a.name === 'shot')!;
    expect(shot.content).toBeUndefined();
    expect(shot.mimeType).toBe('image/png');
    expect(typeof shot.localImagePath).toBe('string');
    expect(nodeFs.readFileSync(nodePath.join(outDir, shot.localImagePath!)).equals(PNG)).toBe(true);
    expect(shot.fileSize).toBe(PNG.length);
  });

  it('leaves a non-image attachment inline, unchanged', () => {
    const built = buildCase(
      fakeTestCase({
        meta: [
          { type: 'attachment', name: 'note', mimeType: 'text/plain', contentBase64: Buffer.from('hi').toString('base64') },
        ] as never,
      }),
      config({ outputDir: outDir }),
      new AttachmentBudget(500_000),
    )!;

    const note = built.attachments!.find((a) => a.name === 'note')!;
    expect(note.localImagePath).toBeUndefined();
    expect(note.content).toBe(Buffer.from('hi').toString('base64'));
  });

  it('an image no longer draws on the inline budget it does not use', () => {
    // The run budget exists to bound the /collect body. A copied screenshot is
    // not in that body, so charging it would starve the attachments that are.
    const budget = new AttachmentBudget(500_000);
    buildCase(
      fakeTestCase({
        meta: [
          { type: 'attachment', name: 'shot', mimeType: 'image/png', contentBase64: PNG.toString('base64') },
        ] as never,
      }),
      config({ outputDir: outDir }),
      budget,
    );
    expect(budget.usedBytes).toBe(0);
  });

  it('falls back to inlining when the image cannot be written, rather than dropping it', () => {
    // No outputDir: the offload is worth losing, the user's attachment is not.
    const built = buildCase(
      fakeTestCase({
        meta: [
          { type: 'attachment', name: 'shot', mimeType: 'image/png', contentBase64: PNG.toString('base64') },
        ] as never,
      }),
      config(),
      new AttachmentBudget(500_000),
    )!;

    const shot = built.attachments!.find((a) => a.name === 'shot')!;
    expect(shot.localImagePath).toBeUndefined();
    expect(shot.content).toBe(PNG.toString('base64'));
  });
});
