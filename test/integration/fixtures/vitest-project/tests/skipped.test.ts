import { test } from 'vitest';

test.skip('is skipped', () => {
  throw new Error('never runs');
});
