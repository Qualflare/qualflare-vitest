import { defineConfig } from 'vitest/config';
import { qualflareReporter } from '@qualflare/vitest';

export default defineConfig({
  test: {
    // `qualflareReporter()` is a typed helper for the same tuple Vitest
    // accepts by hand: ['@qualflare/vitest/reporter', { ... }]. Writing it by
    // hand gives no autocomplete and silently accepts typos, because Vitest
    // types a custom reporter's options as Record<string, unknown>.
    reporters: [['default'], qualflareReporter({ environment: 'staging' })],
    retry: 1,
  },
});
