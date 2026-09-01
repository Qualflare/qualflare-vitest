import type { QualflareVitestOptions } from './config/resolve-config.js';

export { qualflare } from './runtime/qualflare-api.js';

export type { QualflareVitestOptions, ResolvedReporterConfig } from './config/resolve-config.js';

export type {
  Attachment,
  Case,
  CasePriority,
  CaseStatus,
  Collect,
  FrameworkCategory,
  Label,
  Link,
  LinkType,
  Metadata,
  NanosecondDuration,
  Parameter,
  Platform,
  Step,
  Suite,
} from './shared/types.js';

/** The tuple form Vitest accepts in `test.reporters`: a module specifier and
 * its options. Vitest types this as `[ReporterName, Record<string, unknown>]`,
 * where the options are unchecked. */
export type QualflareReporterDescription = ['@qualflare/vitest/reporter', QualflareVitestOptions];

/**
 * Typed helper for registering the reporter.
 *
 * Vitest types a custom reporter's options as `Record<string, unknown>`, so
 * writing the tuple by hand gives no autocomplete and silently accepts typos.
 * This returns the same tuple with the options checked:
 *
 * ```ts
 * import { defineConfig } from 'vitest/config';
 * import { qualflareReporter } from '@qualflare/vitest';
 *
 * export default defineConfig({
 *   test: {
 *     reporters: [['default'], qualflareReporter({ environment: 'staging' })],
 *   },
 * });
 * ```
 */
export function qualflareReporter(options: QualflareVitestOptions = {}): QualflareReporterDescription {
  return ['@qualflare/vitest/reporter', options];
}
