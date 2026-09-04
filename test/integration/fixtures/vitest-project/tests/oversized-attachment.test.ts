import { expect, test } from 'vitest';

import { qualflare } from '../../../../../src/index.js';

// The regression this whole path exists for: an uncapped attachment produced a
// >10MB body, /collect returned 413, and the ENTIRE launch was lost — not just
// the attachment. The run must still produce a valid report with this skipped.
//
// Sized well clear of maxAttachmentBytes rather than just past it. This was
// 5_000_000 while the cap was 1.5MB; when the cap rose to exactly 5MB the fixture
// landed precisely ON the boundary and, since the check is `>`, stopped being
// oversized at all — the test then failed for a reason that had nothing to do
// with the behaviour it guards.
test('an oversized attachment is skipped, not fatal', () => {
  qualflare.attachment('huge', 'x'.repeat(8_000_000));
  expect(true).toBe(true);
});
