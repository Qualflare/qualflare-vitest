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

### A leftover report does not need clearing

Each report carries `metadata.runId` — the identifier every shard of one run shares and different
runs do not (`GITHUB_RUN_ID`, `CI_PIPELINE_ID`, and so on; a per-process UUID outside CI). When
`collect` finds files from more than one run it uploads the run that just finished and says what it
left out:

```
ignored 1 file(s) from 1 earlier run(s) (--allow-mixed-runs to include them)
Processing 2 test result file(s)...
OK Test results collected successfully
```

Nothing is deleted — the older files stay on disk, they are simply not uploaded.
`--allow-mixed-runs` merges every run into one launch instead, which is occasionally what you want
when several tools write into one directory.

There was a period where this was stricter than it needed to be: `collect` refused the whole upload
and left you to clear the directory by hand. Before that it merged the stale file silently, which
produced a launch that looked entirely plausible and contained results nobody ran.

**On `@qualflare/cli` older than v0.1.21 you get one of those two older behaviours** — a refusal on
v0.1.19–v0.1.20, and a silent merge before that.

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

## Not limitations of this reporter

Things Vitest itself does not do. They are recorded here because people ask why a Vitest launch
looks different from a Playwright or Cypress one — not because anything is being withheld. There is
nothing to fix on this side; each would need a change in Vitest.

**No per-attempt retry history.** A retried test reports `retryCount` and a native `flaky` flag,
both accurate, but no per-attempt breakdown. `TestCase.diagnostic()` exposes aggregates only, the
runner keeps earlier attempts' errors in one flat list with nothing marking where an attempt ends,
and the public `Reporter` interface has no retry-level hook. Per-attempt statuses and durations
exist nowhere in the API, so the `Case.attempts` structure the Playwright, Cypress and CucumberJS
reporters send cannot be built here without inventing the timings.

**Four statuses, not seven.** Vitest has `passed`, `failed`, `skipped` and `pending`. A test that
exceeds `testTimeout` surfaces as `failed` carrying a timeout message — Vitest does not distinguish
it — so no `timeout` or `aborted` ever reaches a report. Playwright does distinguish them and its
reporter maps them.

**No video, anywhere.** Vitest records none, in browser mode or otherwise.
