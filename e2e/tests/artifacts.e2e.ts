import { expect, test } from 'vitest';

import { qualflare } from '../../dist/index.js';

// A real PNG header, not arbitrary bytes: the CLI's upload endpoint
// cross-checks the extension against the MIME type it is handed, so the
// verifier asserts the written file really is a PNG rather than merely named
// one.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('attaches a screenshot, which travels out of band', () => {
  // This repo has no framework-level screenshot capture -- browser-mode
  // artifacts come through TestCase.artifacts(), which is experimental and
  // 4.x-only and deliberately not read yet. The metadata API is the image
  // source that exists today, and it takes the same localImagePath route.
  qualflare.attachment('screenshot', PNG_MAGIC.toString('base64'), {
    encoding: 'base64',
    mimeType: 'image/png',
  });
  expect(PNG_MAGIC.byteLength).toBe(8);
});
