import { describe, expect, it } from 'vitest';
import { getCurrentTest } from 'vitest/suite';

import { qualflare } from '../../src/runtime/qualflare-api.js';
import { QUALFLARE_META_KEY } from '../../src/shared/constants.js';
import type { RuntimeMessage } from '../../src/runtime/message-types.js';

/**
 * These tests exercise the runtime API against a REAL running task rather than
 * a mock, because they are themselves Vitest tests — `getCurrentTest()` inside
 * one returns that test's own task, and `task.meta` is the very channel the
 * reporter reads. So this asserts the actual mechanism end to end, not a
 * stand-in for it.
 */
function recorded(): RuntimeMessage[] {
  const task = getCurrentTest();
  const meta = task?.meta as { [QUALFLARE_META_KEY]?: RuntimeMessage[] } | undefined;
  return meta?.[QUALFLARE_META_KEY] ?? [];
}

describe('qualflare runtime API', () => {
  it('records a label onto the running task', () => {
    qualflare.label('team', 'platform');
    expect(recorded()).toContainEqual({ type: 'label', name: 'team', value: 'platform' });
  });

  it('defaults a link type to custom, and keeps an explicit one', () => {
    qualflare.link('https://a.example');
    qualflare.link('https://b.example', { type: 'tms', name: 'QF-1' });
    const links = recorded().filter((m) => m.type === 'link');
    expect(links[0]).toMatchObject({ url: 'https://a.example', linkType: undefined });
    expect(links[1]).toMatchObject({ url: 'https://b.example', linkType: 'tms', name: 'QF-1' });
  });

  it('base64-encodes attachment content by default', () => {
    qualflare.attachment('note', 'hello');
    const att = recorded().find((m) => m.type === 'attachment');
    expect(att).toMatchObject({ contentBase64: Buffer.from('hello').toString('base64') });
  });

  it('passes base64 content through untouched when told it already is', () => {
    const already = Buffer.from('hello').toString('base64');
    qualflare.attachment('note', already, { encoding: 'base64' });
    const atts = recorded().filter((m) => m.type === 'attachment');
    expect(atts[atts.length - 1]).toMatchObject({ contentBase64: already });
  });

  it('brackets a step with start and stop, and returns the body value', async () => {
    const out = await qualflare.step('pay', () => 'receipt');
    expect(out).toBe('receipt');
    const types = recorded().map((m) => m.type);
    expect(types).toContain('step_start');
    expect(types).toContain('step_stop');
  });

  it('marks a throwing step failed and rethrows — the test must still fail', async () => {
    await expect(
      qualflare.step('explode', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const stop = recorded().filter((m) => m.type === 'step_stop').pop();
    expect(stop).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('accumulates messages in call order', () => {
    qualflare.label('a', '1');
    qualflare.label('b', '2');
    const labels = recorded().filter((m) => m.type === 'label');
    expect(labels.map((l) => (l as { name: string }).name)).toEqual(['a', 'b']);
  });
});
