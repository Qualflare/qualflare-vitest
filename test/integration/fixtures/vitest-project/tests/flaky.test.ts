import { expect, test } from 'vitest';

// Fails on the first attempt and passes on the retry, so the report must show
// retryCount=1 and isFlaky=true — both read straight from diagnostic(), which
// is what removes the per-attempt bookkeeping the Playwright reporter needs.
let attempts = 0;

test('passes on the second attempt', () => {
  attempts += 1;
  expect(attempts).toBeGreaterThan(1);
});
