import { expect, test } from 'vitest';

import { qualflare } from '../../../../../src/index.js';

// The regression this whole path exists for: an uncapped attachment produced a
// >10MB body, /collect returned 413, and the ENTIRE launch was lost — not just
// the attachment. The run must still produce a valid report with this skipped.
test('an oversized attachment is skipped, not fatal', () => {
  qualflare.attachment('huge', 'x'.repeat(5_000_000));
  expect(true).toBe(true);
});
