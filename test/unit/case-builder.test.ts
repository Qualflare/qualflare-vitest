import { describe, expect, it } from 'vitest';

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
