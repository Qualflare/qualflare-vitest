import { expect, test } from 'vitest';

import { qualflare } from '../../../../../src/index.js';

test('records metadata through task.meta', async () => {
  qualflare.label('team', 'platform');
  qualflare.link('https://tracker/QF-1', { type: 'tms', name: 'QF-1' });
  qualflare.tag('smoke');
  qualflare.description('Exercises the metadata API end to end.');
  qualflare.priority('high');
  qualflare.parameter('plan', 'pro');
  qualflare.attachment('note', 'hello from the fixture');

  await qualflare.step('outer', async () => {
    qualflare.parameter('amount', '42');
    await qualflare.step('inner', () => {
      expect(true).toBe(true);
    });
  });
});
