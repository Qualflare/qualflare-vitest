# Limitations

Known gaps and deliberate trade-offs in `@qualflare/vitest`. Everything here is a choice or a
constraint we ran into, not a bug list.

## Vitest 3.0 is the floor

The reporter is built on the Reported Tasks API — `onTestCaseResult`, `onTestRunEnd`, `TestCase`,
`TestModule` — which does not exist before Vitest 3.0. Vitest 2's `Reporter` interface offers only
`onFinished(files)` / `onTaskUpdate(packs)` over the raw task tree, and cannot supply a retry count,
a flaky flag, or annotations at all. Supporting it would mean a second implementation with strictly
less information, so `peerDependencies` declares `>=3.0.0` and npm refuses the install below that
rather than producing a silently poorer report.

## Native annotations need Vitest 3.2+

`task.annotate()` and `TestCase.annotations()` arrived in 3.2. The peer floor is 3.0, so the
reporter feature-detects rather than assuming:

```ts
if (typeof testCase.annotations !== 'function') return [];
```

On 3.0/3.1 you get no native annotations — a concept your Vitest does not have — while
`qualflare.attachment()` works throughout. CI runs a 3.0 leg specifically to prove the unguarded
call would have thrown there.

This is the same shape as the sibling Playwright package, which declares a 1.40 floor while
`TestCase.tags` only exists from 1.42.

## Browser-mode screenshots and traces are not attached

Vitest's browser mode produces failure screenshots (`browser.screenshotFailures`) and replayable
Playwright traces (`browser.trace` / `browser.traceView`). Neither is attached today: both reach a
reporter through `TestCase.artifacts()` / `recordArtifact`, which is 4.x-only and marked
`@experimental` in Vitest's own type definitions. Reading it would mean a third version branch on
top of the two above, for an API that may still change shape. Revisit once it stabilises.

There is no video to attach — Vitest records none, in browser mode or otherwise. That is a property
of Vitest rather than a gap in this reporter, which is why it is not listed as a limitation of its
own.

## No `timeout` or `aborted` status

The wire contract has seven statuses; Vitest reports four (`passed`, `failed`, `skipped`,
`pending`). A test that times out surfaces as `failed` carrying a timeout message, so this reporter
never emits `timeout` or `aborted`. Playwright distinguishes them and its reporter does map them.

## Step nesting is preserved, but the count is capped

`qualflare.step()` calls nest, and nesting survives as a `parentIndex` chain. A single test may
record at most 300 steps (`MAX_STEPS_PER_TEST_ATTEMPT`), well under the server's 1000-per-case hard
cap. Past that, further steps are dropped with a one-time warning rather than queued and truncated
server-side, where the whole case could be rejected instead.

## Steps exist only in Qualflare

Vitest has no `test.step()` to delegate to, so a `qualflare.step()` appears in the Qualflare report
and nowhere else — not in Vitest's terminal output, not in its HTML reporter. The Playwright sibling
does delegate, so its steps appear in both. Timing is exact either way: real elapsed time around the
awaited body.

## Sharded CI: point every shard at the same `outputDir`

Each process writes one uniquely-named file, so shards never overwrite one another and
`qf collect <dir>` merges them into a single Launch.

### Stale files are refused, not merged

Each report carries `metadata.runId` — the identifier every shard of one run shares and different
runs do not (`GITHUB_RUN_ID`, `CI_PIPELINE_ID`, and so on; a per-process UUID outside CI). If
`collect` finds files from more than one run it refuses to upload and names them:

```
Error: 2 different runs found in the report files:
    run 17244102887: 1 file(s)  (stale.json)
    run 17244981923: 2 file(s)  (shard-0.json, shard-1.json)
  A stale file from an earlier run would be merged into this launch.
  Clear the output directory before each run, or pass --allow-mixed-runs to upload anyway
```

Clearing `outputDir` at the start of each run is still the tidier habit — in CI it is usually free,
since the workspace is fresh — but forgetting now costs a failed upload rather than a launch
quietly containing results nobody ran.

Needs `@qualflare/cli` v0.1.19 or newer. An older CLI ignores `runId` and merges as before.

## No per-attempt history

The sibling reporters (`@qualflare/playwright`, `@qualflare/cypress`, `@qualflare/cucumberjs`) send
`Case.attempts`: each attempt's status, duration and error. This reporter does not, and the reason is
upstream rather than a gap here.

What Vitest gives a reporter about a retried test:

- `TestCase.diagnostic()` exposes aggregates only — `retryCount`, `repeatCount` and a native `flaky`
  flag. There is no per-attempt array.
- The final result keeps the earlier attempts' errors. The runner resets only `result.state` between
  attempts and never clears `result.errors`, and Vitest's own types say so: *"If test was retried
  successfully, errors will still be reported."* But it is one flat list, with nothing marking where
  one attempt ends and the next begins.
- There is no reporter hook for a retry. `updateTask("test-retried", …)` is an internal task update
  and appears nowhere in the public `Reporter` interface.

So the errors survive but the attempt boundaries do not, and neither do per-attempt statuses or
durations. Building `Case.attempts` from that would mean inventing the timings, which is worse than
omitting it — a wrong duration on an attempt reads as real data. `retryCount` and `isFlaky` are sent
and are accurate.

Revisit if Vitest adds a per-attempt structure or a retry-level reporter hook.

## `parameter()` outside a step has no masking

Inside an open `step()`, a parameter attaches to that step and its `masked` flag is carried through.
Outside any step it lands in the case's `properties`, which is a flat `Record<string, string>` with
nowhere to put the flag. `masked` is a display hint for the UI in either case — the server does not
redact the value, so never put a real secret in one.

## Per-attachment and whole-run caps are independent, not pooled

`maxAttachmentBytes` (1.5MB) rejects one oversized attachment; `maxTotalAttachmentBytes` (750KB)
is the whole-run budget. The second is deliberately smaller than the first: the run budget is what
keeps a request under `/collect`'s 10MB body limit, and a rejected request loses the ENTIRE launch —
every result in the run, not just the attachment. Both are configurable, and raising them is the
easiest way to lose a launch.

## Test identity

`Case.id` is Vitest's own task id, which is derived from the module path and the test's position
within it. Renaming a test, or moving it within its file, produces a different id. Qualflare
identifies cases by name within a suite as well, so history survives — but do not rely on the id
being stable across refactors.
