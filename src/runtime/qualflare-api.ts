import { getCurrentTest } from 'vitest/suite';

import { QUALFLARE_META_KEY } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { CasePriority, LinkType } from '../shared/types.js';
import type { RuntimeMessage } from './message-types.js';

/**
 * Ships one structured message from the test process to the reporter.
 *
 * Vitest runs tests in worker processes and reporters in the main process,
 * with no shared memory. The channel between them is `task.meta`: anything
 * written there is serialized over Vitest's RPC after the test finishes and
 * read back in the reporter as `testCase.meta()`.
 *
 * That is a genuinely better channel than the sibling packages have.
 * `@qualflare/playwright` has to smuggle these messages through
 * `testInfo.attach()` under a reserved content type and then filter them back
 * out of the real attachment list, and `@qualflare/cucumberjs` does the same
 * through `World.attach()`. Here the messages are simply metadata, so there is
 * no reserved media type, nothing to filter, and — because `task.meta` is a
 * plain object — no promise, which means no unhandled rejection able to take
 * the user's run down with it.
 *
 * `getCurrentTest()` returns undefined outside a running test (module scope, a
 * `globalSetup`, a stray import). Warn and drop: a metadata call is never
 * worth failing somebody's suite over.
 */
function send(message: RuntimeMessage): void {
  try {
    const task = getCurrentTest();
    if (!task) {
      logger.warn(`qualflare.${message.type}() was called outside a running test; the call was ignored.`);
      return;
    }
    // `meta` is typed as an empty interface Vitest expects consumers to
    // augment. One array under one namespaced key keeps every message in
    // arrival order and cannot collide with another reporter's metadata.
    const meta = task.meta as { [QUALFLARE_META_KEY]?: RuntimeMessage[] };
    (meta[QUALFLARE_META_KEY] ??= []).push(message);
  } catch (err) {
    logger.warn(`qualflare.${message.type}() could not be recorded: ${(err as Error).message}`);
  }
}

/**
 * Author-facing metadata API. Import it in a test file and annotate tests with
 * business context Vitest itself has no concept of:
 *
 * ```ts
 * import { qualflare } from '@qualflare/vitest';
 *
 * test('checks out', async () => {
 *   qualflare.label('epic', 'Billing');
 *   qualflare.link('https://tracker/QF-1', { type: 'issue', name: 'QF-1' });
 *   await qualflare.step('pay', async () => { ... });
 * });
 * ```
 */
export const qualflare = {
  /** Arbitrary name/value metadata (epic, feature, story, owner, severity). */
  label(name: string, value: string): void {
    send({ type: 'label', name, value });
  },

  /** A typed external reference. `type` defaults to `custom`. */
  link(url: string, opts?: { type?: LinkType; name?: string }): void {
    send({ type: 'link', url, linkType: opts?.type, name: opts?.name });
  },

  /** One or more free-text tags. These are additive to Vitest's own
   * `TestCase.tags`, which the reporter already reads; use this for tags that
   * are computed at runtime rather than declared in the test signature. */
  tag(...tags: string[]): void {
    send({ type: 'tag', tags });
  },

  /** Markdown description shown on the case. */
  description(text: string): void {
    send({ type: 'description', text });
  },

  /** Case priority (low | medium | high | critical). */
  priority(value: CasePriority): void {
    send({ type: 'priority', value });
  },

  /** A named input. Inside an open `step()` it attaches to that step;
   * outside any step it lands in the case's properties. `masked` is a
   * display hint for the UI only — the server does not redact the value. */
  parameter(name: string, value?: string, opts?: { masked?: boolean }): void {
    send({ type: 'parameter', name, value, masked: opts?.masked });
  },

  /** Attach in-memory content. Subject to `maxAttachmentBytes` and the
   * run-wide `maxTotalAttachmentBytes` budget when the reporter replays it. */
  attachment(name: string, content: string, opts?: { encoding?: 'utf8' | 'base64'; mimeType?: string }): void {
    const contentBase64 = opts?.encoding === 'base64' ? content : Buffer.from(content, 'utf8').toString('base64');
    send({ type: 'attachment', name, contentBase64, mimeType: opts?.mimeType });
  },

  /** Attach a file from disk. The reporter stats it before reading, so an
   * oversized file is skipped rather than read into memory. */
  attachmentFromFile(name: string, path: string, opts?: { mimeType?: string }): void {
    send({ type: 'attachment_from_file', name, path, mimeType: opts?.mimeType });
  },

  /**
   * Records a named step around `fn`.
   *
   * Unlike `@qualflare/playwright`, this does not delegate to a framework
   * step API, because Vitest has no `test.step()`. Steps therefore exist in
   * Qualflare only. Timing is exact: real `Date.now()` deltas around the
   * awaited body.
   */
  async step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    send({ type: 'step_start', name, timestamp: Date.now() });
    try {
      const result = await fn();
      send({ type: 'step_stop', status: 'passed', timestamp: Date.now() });
      return result;
    } catch (err) {
      send({
        type: 'step_stop',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
      throw err;
    }
  },
};
