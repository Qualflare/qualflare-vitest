import { expect, test } from 'vitest';

// Retries are scoped to THIS test via its own option, with the global retry at
// 0. A global retry would re-run a genuine regression and quietly turn it green
// -- in a suite whose whole job is that red means something.
//
// A module-level counter, because Vitest exposes no attempt index to a test.
// The same approach the integration fixture uses, proven across 3.0/3.2/4.x.
// Its failure mode is "red every time", never flake. Deliberately NOT a marker
// file on disk: that survives an interrupted run and silently makes the next
// run's first attempt pass, turning this into a no-op that still looks green.
let attempts = 0;

test('fails once, then passes, producing per-attempt history', { retry: 1 }, () => {
  attempts += 1;
  expect(attempts, 'dogfood-intentional-retry-marker').toBeGreaterThan(1);
});
