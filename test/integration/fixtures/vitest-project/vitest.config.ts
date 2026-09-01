import { defineConfig } from 'vitest/config';

// The reporter is loaded from the BUILT dist/, not src/, so the integration
// suite exercises what actually ships — a broken exports map or a build that
// drops a file fails here rather than after publishing.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: [
      ['default'],
      [
        new URL('../../../../dist/reporter/index.js', import.meta.url).pathname,
        { environment: 'staging', outputDir: process.env['QF_OUT'] ?? './qualflare-results' },
      ],
    ],
    // One retry, so the flaky fixture can pass on its second attempt and prove
    // diagnostic().flaky and retryCount are read correctly.
    retry: 1,
  },
});
