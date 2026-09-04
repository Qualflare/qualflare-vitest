import type { TestCase } from 'vitest/node';

import type { ResolvedReporterConfig } from '../config/resolve-config.js';
import {
  MAX_LABELS_PER_CASE,
  MAX_LINKS_PER_CASE,
  MAX_STEPS_PER_TEST_ATTEMPT,
  MAX_TAGS_PER_CASE,
  MAX_TAG_LENGTH,
  QUALFLARE_META_KEY,
} from '../shared/constants.js';
import { msToNs } from '../shared/duration.js';
import { logger } from '../shared/logger.js';
import type { Attachment, Case, CaseStatus, Label, Link, Parameter, Step } from '../shared/types.js';
import type { RuntimeMessage } from '../runtime/message-types.js';
import { AttachmentBudget, inlineFromBuffer, inlineFromFile } from './attachment-reader.js';
import { buildParameter, propertyValue } from '../shared/parameters.js';

/**
 * Maps Vitest's result states onto the wire contract's vocabulary.
 *
 * `qualflare-cli` accepts exactly 7 values and turns anything it does not
 * recognize into `error` — NOT into a pass — so each state is mapped
 * explicitly rather than passed through and hoped for.
 *
 * Vitest has fewer states than Playwright: there is no `timedOut` or
 * `interrupted`. A timeout surfaces as `failed` carrying a timeout message, so
 * this reporter never produces `timeout` or `aborted`. `pending` cannot reach
 * us — `onTestRunEnd` runs after every test has resolved — but it is mapped
 * rather than left to the default so the switch stays exhaustive.
 */
function mapStatus(state: 'passed' | 'failed' | 'skipped' | 'pending'): CaseStatus {
  switch (state) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'pending':
      return 'error';
    default:
      return 'error';
  }
}

// Matches ANSI SGR escapes. Written as a unicode escape rather than a literal
// control character, so this source stays copy-pasteable and greppable.
// eslint-disable-next-line no-control-regex -- matching ANSI escapes requires the escape byte itself
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Renders Vitest's errors into one text block.
 *
 * Vitest reports an ARRAY of errors rather than a single one — `expect.soft()`
 * lets one test accumulate several — so all are rendered, not just the first.
 * Assertion errors also carry `diff`, the rendered expected/actual comparison
 * that the terminal reporter prints and that is usually the most useful part
 * of a Vitest failure. It arrives ANSI-coloured, which would render as escape
 * soup in a web UI.
 */
function formatErrors(
  errors: ReadonlyArray<{ message?: string; stack?: string; diff?: string }> | undefined,
): string | undefined {
  if (!errors || errors.length === 0) {
    return undefined;
  }
  const blocks: string[] = [];
  for (const err of errors) {
    const parts = [stripAnsi(err.message ?? 'test failed')];
    if (err.diff) {
      parts.push('', stripAnsi(err.diff));
    }
    if (err.stack && !(err.message ?? '').includes(err.stack)) {
      parts.push('', stripAnsi(err.stack));
    }
    blocks.push(parts.join('\n'));
  }
  return blocks.join('\n\n');
}

interface ReplayedMetadata {
  labels: Label[];
  links: Link[];
  tags: string[];
  description?: string;
  priority?: Case['priority'];
  caseParameters: Parameter[];
  attachments: Attachment[];
  steps: Step[];
}

/**
 * Replays the `qualflare.*()` calls a test made, read from
 * `task.meta[QUALFLARE_META_KEY]` (see runtime/qualflare-api.ts).
 *
 * Steps are SYNTHESIZED here from the step_start/step_stop pairs, which is the
 * one place this differs materially from `@qualflare/playwright`. There,
 * `qualflare.step()` delegates to Playwright's own `test.step()`, so the step
 * already exists natively and the messages serve only to bracket parameters —
 * synthesizing a second one would double-report every manual step. Vitest has
 * no `test.step()` to delegate to, so if this function does not build the step,
 * nothing does. Timing is therefore exact: real `Date.now()` deltas around the
 * awaited body.
 *
 * `parameter()` placement follows the rule shared with the sibling packages:
 * inside an open `step()` it belongs to that step, outside any step it belongs
 * to the case's properties.
 */
function replayMetadata(
  testCase: TestCase,
  config: ResolvedReporterConfig,
  budget: AttachmentBudget,
): ReplayedMetadata {
  const meta: ReplayedMetadata = {
    labels: [],
    links: [],
    tags: [],
    caseParameters: [],
    attachments: [],
    steps: [],
  };

  const raw = (testCase.meta() as { [QUALFLARE_META_KEY]?: RuntimeMessage[] })[QUALFLARE_META_KEY];
  if (!Array.isArray(raw)) {
    return meta;
  }

  // A stack, so nested qualflare.step() calls attribute parameters to the
  // innermost open step and produce a parentIndex chain.
  const openSteps: { name: string; startedAt: number; index: number }[] = [];
  let stepsDropped = 0;

  for (const message of raw) {
    switch (message.type) {
      case 'label':
        meta.labels.push({ name: message.name, value: message.value });
        break;
      case 'link':
        meta.links.push({
          type: message.linkType ?? 'custom',
          ...(message.name ? { name: message.name } : {}),
          url: message.url,
        });
        break;
      case 'tag':
        meta.tags.push(...message.tags);
        break;
      case 'description':
        meta.description = message.text;
        break;
      case 'priority':
        meta.priority = message.value;
        break;
      case 'parameter': {
        const param: Parameter = buildParameter(message.name, message.value, message.masked);
        const open = openSteps[openSteps.length - 1];
        if (open === undefined) {
          meta.caseParameters.push(param);
        } else {
          const step = meta.steps[open.index]!;
          step.parameters = [...(step.parameters ?? []), param];
        }
        break;
      }
      case 'attachment': {
        // Decoded back to bytes rather than trusting the base64 length, so the
        // cap applies to the real payload size the server will receive.
        const inlined = inlineFromBuffer(
          message.name,
          Buffer.from(message.contentBase64, 'base64'),
          message.mimeType,
          config,
          budget,
        );
        if (inlined) {
          meta.attachments.push(inlined);
        }
        break;
      }
      case 'attachment_from_file': {
        const fromFile = inlineFromFile(message.name, message.path, message.mimeType, config, budget);
        if (fromFile) {
          meta.attachments.push(fromFile);
        }
        break;
      }
      case 'step_start': {
        if (meta.steps.length >= MAX_STEPS_PER_TEST_ATTEMPT) {
          stepsDropped += 1;
          break;
        }
        const parent = openSteps[openSteps.length - 1];
        const index = meta.steps.length;
        meta.steps.push({
          name: message.name,
          status: 'passed',
          duration: 0,
          ...(parent ? { parentIndex: parent.index } : {}),
        });
        openSteps.push({ name: message.name, startedAt: message.timestamp, index });
        break;
      }
      case 'step_stop': {
        const open = openSteps.pop();
        if (!open) {
          // A stop with no matching start means the cap dropped its start.
          break;
        }
        const step = meta.steps[open.index]!;
        step.duration = msToNs(Math.max(0, message.timestamp - open.startedAt));
        step.status = message.status;
        if (message.error) {
          step.error = stripAnsi(message.error);
        }
        break;
      }
    }
  }

  if (stepsDropped > 0) {
    logger.warn(
      `${stepsDropped} step(s) were dropped: a single test may record at most ${MAX_STEPS_PER_TEST_ATTEMPT}.`,
    );
  }

  return meta;
}

/** Truncates and caps tags to the server's limits, so a runaway loop in a
 * test can't get a whole launch rejected at validation. */
function capTags(tags: string[]): string[] {
  const unique = [...new Set(tags.map((t) => t.slice(0, MAX_TAG_LENGTH)))];
  return unique.slice(0, MAX_TAGS_PER_CASE);
}

/**
 * Turns Vitest's own `task.annotate()` annotations into attachments.
 *
 * `annotations()` landed in Vitest 3.2 but the peer floor is >=3.0.0, so it is
 * feature-detected rather than assumed. On 3.0/3.1 users simply get no native
 * annotations — a concept their Vitest does not have — while
 * `qualflare.attachment()` keeps working. This is the same defensive shape
 * `@qualflare/playwright` needs for `TestCase.tags`, which exists only from
 * Playwright 1.42 despite that package's 1.40 floor.
 */
function annotationsToAttachments(
  testCase: TestCase,
  config: ResolvedReporterConfig,
  budget: AttachmentBudget,
): Attachment[] {
  if (typeof testCase.annotations !== 'function') {
    return [];
  }
  const out: Attachment[] = [];
  for (const annotation of testCase.annotations()) {
    const file = annotation.attachment;
    if (!file) {
      continue;
    }
    const name = annotation.message || annotation.type || 'annotation';
    if (file.path) {
      const fromFile = inlineFromFile(name, file.path, file.contentType, config, budget);
      if (fromFile) {
        out.push(fromFile);
      }
      continue;
    }
    if (file.body !== undefined) {
      // A string body is base64 by default (bodyEncoding); a Uint8Array is
      // already raw bytes.
      const bytes = typeof file.body === 'string' ? Buffer.from(file.body, 'base64') : Buffer.from(file.body);
      const inlined = inlineFromBuffer(name, bytes, file.contentType, config, budget);
      if (inlined) {
        out.push(inlined);
      }
    }
  }
  return out;
}

/**
 * Builds one wire `Case` from a finished Vitest test.
 *
 * Called once per test from `onTestRunEnd`. Unlike the Playwright reporter
 * there is no per-attempt bookkeeping: `diagnostic()` already reports the final
 * `retryCount` and a native `flaky` flag, so flakiness needs no inference from
 * observing individual attempts.
 */
export function buildCase(
  testCase: TestCase,
  config: ResolvedReporterConfig,
  /** The run-wide inline budget. The metadata API's own attachments
   * (`qualflare.attachment()` / `attachmentFromFile()`) and Vitest's
   * annotations must draw on the SAME budget — an uncapped path can push the
   * request past `/collect`'s 10MB body limit and lose the entire launch. */
  budget: AttachmentBudget,
): Case | undefined {
  const result = testCase.result();
  if (!result) {
    return undefined;
  }

  const diagnostic = testCase.diagnostic();
  const meta = replayMetadata(testCase, config, budget);

  const properties: Record<string, string> = {
    file: testCase.module.moduleId,
  };
  for (const p of meta.caseParameters) {
    properties[p.name] = propertyValue(p.value, p.masked);
  }

  const attachments = [...annotationsToAttachments(testCase, config, budget), ...meta.attachments];

  // Vitest's own tags merged with anything qualflare.tag() added, read
  // defensively for the same reason annotations() is.
  const nativeTags = (testCase as { tags?: string[] }).tags ?? [];
  const tags = capTags([...nativeTags, ...meta.tags]);
  const error = formatErrors(result.errors);

  return {
    id: testCase.id,
    name: testCase.fullName,
    className: testCase.module.moduleId,
    status: mapStatus(result.state),
    duration: msToNs(diagnostic?.duration ?? 0),
    retryCount: diagnostic?.retryCount ?? 0,
    isFlaky: diagnostic?.flaky ?? false,
    ...(error ? { error } : {}),
    ...(meta.priority ? { priority: meta.priority } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    properties,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(meta.steps.length > 0 ? { steps: meta.steps } : {}),
    ...(meta.labels.length > 0 ? { labels: meta.labels.slice(0, MAX_LABELS_PER_CASE) } : {}),
    ...(meta.links.length > 0 ? { links: meta.links.slice(0, MAX_LINKS_PER_CASE) } : {}),
    ...(diagnostic ? { startedAt: new Date(diagnostic.startTime).toISOString() } : {}),
  };
}
