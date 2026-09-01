# Metadata API

`qualflare` is the author-facing runtime API — the thing Vitest's own JSON output has no equivalent
of, and the main reason this package exists rather than parsing that file.

```ts
import { expect, test } from 'vitest';
import { qualflare } from '@qualflare/vitest';
```

Every call attaches to the **currently running test**, wherever it is made: the test body, a
`beforeEach`, or a helper several frames deep. Calling one outside a running test (at module load,
from `globalSetup`, or after a test has finished) logs a warning and is ignored — a metadata call
must never fail somebody's suite.

## How it works

Vitest runs tests in worker processes and reporters in the main process, with no shared memory. The
channel back is `task.meta`: the API resolves the running task with `getCurrentTest()` and pushes
each call onto one namespaced key, which Vitest serialises over RPC. The reporter reads it back as
`testCase.meta()` and replays it.

This is a cleaner channel than the sibling packages get. `@qualflare/playwright` and
`@qualflare/cucumberjs` both have to smuggle these messages through an attachment under a reserved
media type and then filter them back out of the real attachment list. Here they are simply metadata,
so there is nothing to filter — and because `task.meta` is a plain object rather than a promise,
there is no unhandled rejection able to take your run down with it.

Anything you pass must survive JSON: `task.meta` crosses a process boundary, so unserialisable
values are silently lost rather than rejected.

---

## `qualflare.label(name, value)`

Arbitrary name/value metadata. This is how Allure-style `epic`/`feature`/`story`/`owner`/`severity`
are expressed.

```ts
qualflare.label('epic', 'Billing');
qualflare.label('owner', 'payments-team');
```

Capped at 100 labels per case (the server's limit); further labels are dropped.

**Requires `@qualflare/cli >= v0.1.18`.** Earlier CLI versions parsed the report but silently
discarded `labels` and `links`, so they never reached the server.

## `qualflare.link(url, opts?)`

A typed external reference.

```ts
qualflare.link('https://tracker.example/QF-42', { type: 'issue', name: 'QF-42' });
qualflare.link('https://wiki.example/runbook');            // type defaults to 'custom'
```

`opts.type` is `'issue' | 'tms' | 'custom'`. Capped at 20 links per case.

## `qualflare.tag(...tags)`

```ts
qualflare.tag('smoke');
qualflare.tag('billing', 'regression');
```

Merged with Vitest's own `TestCase.tags`. Use this for tags computed at runtime; declare static ones
in the test signature. Capped at 64 tags per case, each truncated to 255 characters.

## `qualflare.description(text)`

```ts
qualflare.description('Signs a user in and asserts the greeting renders.');
```

Markdown. Last call wins within a test.

## `qualflare.priority(value)`

```ts
qualflare.priority('high');
```

One of `'low' | 'medium' | 'high' | 'critical'`. Last call wins.

## `qualflare.parameter(name, value?, opts?)`

Records a named input.

```ts
qualflare.parameter('sku', 'BOOK-1');
qualflare.parameter('password', secret, { masked: true });
```

**Placement matters.** Inside an open `qualflare.step()`, the parameter attaches to that step.
Outside any step it becomes a `Case.properties` entry instead, because the wire contract has no
case-level `Parameter[]`.

`masked` is a **display hint for the UI only**. Neither this reporter nor the server redacts the
value — do not pass a real secret expecting it to be protected.

## `qualflare.attachment(name, content, opts?)`

Attach in-memory content.

```ts
qualflare.attachment('request', JSON.stringify(body), { mimeType: 'application/json' });
qualflare.attachment('thumbnail', pngBase64, { encoding: 'base64', mimeType: 'image/png' });
```

`opts.encoding` is `'utf8'` (default) or `'base64'`. Subject to the same size caps as any other
inline attachment — see [`CONFIGURATION.md`](./CONFIGURATION.md).

## `qualflare.attachmentFromFile(name, path, opts?)`

Attach a file from disk, read at report time.

```ts
qualflare.attachmentFromFile('har', 'artifacts/session.har', { mimeType: 'application/json' });
```

An unreadable path is skipped with a warning rather than failing the test.

## `qualflare.step(name, fn)`

Records a named step around `fn`, capturing its duration and whether it threw.

```ts
await qualflare.step('add an item to the cart', async () => {
  qualflare.parameter('sku', 'BOOK-1');
  expect(cart.items).toHaveLength(1);
});
```

Always `await` it — it returns a promise resolving to whatever `fn` returns, and a rejection is
re-thrown after the failure is recorded, so control flow is unchanged.

**Vitest has no `test.step()`**, so this is the only way to get step structure into a report — and
the step exists in Qualflare only, not in Vitest's terminal or HTML output. The sibling Playwright
package does delegate to a native step API, so its steps appear in both.

Timing is exact: real elapsed time around the awaited body, not an approximation.

Steps nest, and nesting is preserved in the report via `parentIndex`. A single test may record at
most 300 steps; past that they are dropped with a warning rather than risking the server rejecting
the whole case.

## Vitest's own annotations are captured automatically

`task.annotate()` annotations that carry an attachment are picked up as ordinary attachments, so you
do not need `qualflare.attachment()` for them.

This needs **Vitest 3.2+**, where `task.annotate()` was introduced. The reporter feature-detects, so
on 3.0/3.1 annotations are simply not read and `qualflare.attachment()` remains the way to attach.
See [`LIMITATIONS.md`](./LIMITATIONS.md).

Both paths draw on the same run-wide attachment budget: an oversized or over-budget attachment is
skipped with a warning, never inlined, because a request over `/collect`'s 10MB limit loses every
result in the run.
