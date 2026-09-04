# @qualflare/vitest

[![npm version](https://img.shields.io/npm/v/%40qualflare%2Fvitest.svg)](https://www.npmjs.com/package/@qualflare/vitest)
[![CI](https://github.com/Qualflare/qualflare-vitest/actions/workflows/ci.yml/badge.svg)](https://github.com/Qualflare/qualflare-vitest/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

A native Vitest reporter for [Qualflare](https://qualflare.com) — captures test results directly
from your `vitest run`: status, real retry counts and flakiness, assertion diffs, nested steps, and
author-facing metadata (labels, links, tags, priority, custom attachments).

Without it, Vitest results reach Qualflare through the Jest-compatible JSON file, which carries
pass/fail and duration and nothing else — no retries, no flakiness, no attachments, no metadata.

The reporter itself makes **no network calls**. It writes a report directory, and
[`qualflare-cli`](https://github.com/Qualflare/qualflare-cli) uploads it — which is what lets any
number of sharded CI jobs merge into a single Launch.

## Install

```sh
npm install --save-dev @qualflare/vitest
```

Requires `vitest` `>=3.0.0` (installed separately as a peer dependency) and Node `>=18` (Vitest 4
itself requires Node `>=20`). You also need
[`@qualflare/cli`](https://github.com/Qualflare/qualflare-cli) **v0.1.18 or newer** — that is the
first release that recognises `vitest` as a framework; an older CLI silently labels your suites
`generic`.

The peer range is deliberately open-ended rather than capped at a known-good version, so a new
Vitest release never hard-blocks `npm install` for you. 3.0, 3.2 and 4.x are exercised in CI against
a real `vitest run`; newer versions are untested but not refused — please
[open an issue](https://github.com/Qualflare/qualflare-vitest/issues) if one misbehaves.

Vitest 2 and earlier are **not** supported: the reporter is built on the Reported Tasks API
(`onTestCaseResult`, `onTestRunEnd`, `TestCase`), which does not exist before 3.0.

## Quickstart

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { qualflareReporter } from '@qualflare/vitest';

export default defineConfig({
  test: {
    reporters: [['default'], qualflareReporter({ environment: 'staging' })],
  },
});
```

`qualflareReporter()` is a typed helper. Vitest types a custom reporter's options as
`Record<string, unknown>`, so the hand-written tuple form silently accepts typos — but it works too,
if you prefer it:

```ts
reporters: [['default'], ['@qualflare/vitest/reporter', { environment: 'staging' }]],
```

Then run your tests and upload the results — two steps, and no token needed for the first:

```sh
# 1. Run. Writes ./qualflare-results. Zero network calls.
npx vitest run

# 2. Upload. `qf login <identifier> <token>` stores the credential once.
qf <your-project-identifier> collect ./qualflare-results
```

### Sharded CI

Point every shard at the **same** `outputDir` and collect once at the end. Each process writes its
own uniquely-named file, so shards never overwrite each other, and `qf collect` merges every file in
the directory into a single Launch:

```sh
# in each parallel job — all writing to the same directory
npx vitest run --shard="$SHARD_INDEX/$SHARD_TOTAL"

# once, after all shards finish (e.g. with the directory restored from CI artifacts)
qf <your-project-identifier> collect ./qualflare-results
```

Nothing needs configuring for this: Vitest hands reporters its own `--shard` value, so each case is
stamped with the shard that ran it automatically. (Vitest's shard index is 1-based — `--shard=1/3`
is the first shard — and Qualflare's is 0-based; the conversion is handled for you.)

## Enriching your tests

```ts
import { expect, test } from 'vitest';
import { qualflare } from '@qualflare/vitest';

test('a user can check out', async () => {
  qualflare.label('epic', 'Billing');
  qualflare.link('https://tracker.example/QF-42', { type: 'issue', name: 'QF-42' });
  qualflare.tag('smoke');
  qualflare.priority('high');

  await qualflare.step('add an item to the cart', () => {
    qualflare.parameter('sku', 'BOOK-1');
    expect(cart.items).toHaveLength(1);
  });

  expect(cart.total).toBe('10.00');
});
```

Metadata travels on `task.meta`, the channel Vitest serialises from the test worker back to the
reporter, so these calls are ordinary synchronous function calls with nothing to await and no
promise that can reject into your run. Full reference in
[`docs/METADATA-API.md`](./docs/METADATA-API.md).

Vitest has no `test.step()` of its own, so `qualflare.step()` is the only way to get step structure
into a report. Steps nest, and timing is exact — real elapsed time around the awaited body.

## Configuration

Every option has an environment-variable override, and everything has a sensible default — see
[`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md). There is no `token` option: this reporter makes
no requests, so it has no credential.

One option is worth calling out because it fails late: `environment` is matched against the
environment's **uid (slug)**, not its display name, so **Staging** in the UI is `staging` here. A
wrong value cannot fail at test time — the reporter makes no requests — so the run succeeds and
`collect` 404s afterwards. See
[the note in the configuration docs](./docs/CONFIGURATION.md#environment-is-matched-by-uid-not-display-name).

## Known limitations

- **Browser-mode screenshots and traces are not attached.** They reach a reporter through
  `TestCase.artifacts()`, which is experimental and 4.x-only, so it is deliberately not read until
  it stabilises.
- **A masked `parameter()` value is redacted, not recoverable** — `{ masked: true }` now drops the
  value before the report is written, so the secret never leaves the machine. Outside a step it
  becomes `••••••` in the case's `properties`, which is a flat map with nowhere to put the flag.
  There is no way to read the real value back afterwards. See
  [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md#parameter-masking-redacts-the-value).
- **Attachment caps are two budgets, not one pool** — `maxAttachmentBytes` bounds a single
  attachment and `maxTotalAttachmentBytes` the whole run; anything over either is dropped
  outright rather than truncated. Raising them is the easiest way to push a request past
  `/collect`'s body limit. See
  [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md#per-attachment-and-whole-run-caps-are-independent-not-pooled).

Full details in [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md).

## Development

```sh
npm run typecheck        # tsc --noEmit
npm run lint             # eslint .
npm run build            # tsup -> dist/ (ESM + CJS + d.ts)
npm test                 # unit tests
npm run test:integration # spawns a REAL `vitest run` against test/integration/fixtures/
```

The integration suite loads the reporter from the built `dist/`, not `src/`, so it exercises the
real package `exports` map — run `npm run build` first.

## License

Apache-2.0
