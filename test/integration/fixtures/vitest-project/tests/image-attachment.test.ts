import { test } from 'vitest';

import { qualflare } from '../../../../../src/index.js';

// A REAL PNG header, not arbitrary bytes. The reporter derives the MIME type
// from the declared type here (a buffer has no filename), but the CLI's upload
// endpoint cross-checks the extension it is given, so the assertion verifies
// the written file really is a PNG.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('attaches a screenshot through the metadata API', () => {
  qualflare.attachment('shot', PNG_MAGIC.toString('base64'), {
    encoding: 'base64',
    mimeType: 'image/png',
  });
});
