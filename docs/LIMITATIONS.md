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

## `parameter()` masking redacts the value

`{ masked: true }` drops the value before the report is written. The secret never leaves this
process, so it is not stored server-side and cannot be read back through the API.

Inside a step, the parameter travels as `{ name, masked: true }` with no value, and the Qualflare UI
renders `••••••` from the flag. Outside any step it lands in the case's `properties`, a flat
`Record<string, string>` with nowhere to put the flag — so the value itself becomes `••••••`.
Either way the report carries no secret.

**The value is unrecoverable.** That is the point, but it is worth stating: masking is not a display
toggle you can undo later. Mask a value you may need to read back and it is gone.

This used to be a display hint only — the real value was sent, stored in plaintext and readable
through the API, while the UI drew dots over it. Anyone who trusted the name got no protection at
all, which is why the docs had to say "never put a real secret in one". They no longer do.

## Attachment caps need `@qualflare/cli` v0.1.22+

`maxAttachmentBytes` (5MB) and `maxTotalAttachmentBytes` (10MB) are configurable — see
[`CONFIGURATION.md`](./CONFIGURATION.md). Anything over either is skipped with a warning rather than
truncated; a half-written screenshot is worse than none.

The **version requirement is the real constraint**, and it is not something this reporter can detect
for you. From v0.1.22 the CLI uploads attachments through the presigned-URL flow and references a
`storageKey`, so they no longer occupy `/collect`'s 10MB request body. On an older CLI they are still
base64-inlined, and these limits are large enough to push a request past that body limit — which
fails the entire launch, not just the attachment.

That failure is what the pairing exists to remove. It used to happen without anyone changing a
setting: the caps are per process, `collect` merges every shard into one request, and eleven shards
each honouring the old 750KB budget still assembled a body over the limit.

## Test identity

`Case.id` is Vitest's own task id, which is derived from the module path and the test's position
within it. Renaming a test, or moving it within its file, produces a different id. Qualflare
identifies cases by name within a suite as well, so history survives — but do not rely on the id
being stable across refactors.

## Not limitations of this reporter

Things Vitest itself does not do. They are recorded here because people ask why a Vitest launch
looks different from a Playwright or Cypress one — not because anything is being withheld. There is
nothing to fix on this side; each would need a change in Vitest.

**No per-attempt timings, and no history at all when `expect.soft()` is used.** Per-attempt
statuses and errors ARE sent as `Case.attempts`, like the other three reporters — but reconstructed
rather than read, because Vitest exposes no per-attempt array and no retry-level `Reporter` hook.
What it does expose is `result.errors`, which accumulates across attempts in order, plus
`diagnostic.retryCount`. Every non-final attempt necessarily failed (a pass ends the retry loop), so
the error count is pinned to `retryCount` when the last attempt passed and `retryCount + 1` when it
failed, and the list splits one-to-one onto attempts.

Two consequences, both from Vitest rather than from this reporter:

- **No per-attempt `duration` or `startedAt`.** `diagnostic()` reports run-wide aggregates only.
  Those fields are left unset rather than filled with the total, which would claim every attempt
  took the whole time.
- **`expect.soft()` suppresses the history.** Soft assertions let one attempt contribute several
  errors, so the count no longer pins the boundaries — three errors over two attempts could be 2+1
  or 1+2. Nothing in the payload says which, so `attempts` is omitted rather than guessed at, and
  the case falls back to `retryCount` plus the combined `error` text. Attributing a failure to the
  wrong attempt would be worse than not showing one.

**Four statuses, not seven.** Vitest has `passed`, `failed`, `skipped` and `pending`. A test that
exceeds `testTimeout` surfaces as `failed` carrying a timeout message — Vitest does not distinguish
it — so no `timeout` or `aborted` ever reaches a report. Playwright does distinguish them and its
reporter maps them.

**No video, anywhere.** Vitest records none, in browser mode or otherwise.

**Native annotations need Vitest 3.2+.** `task.annotate()` and `TestCase.annotations()` arrived in
3.2, and the peer floor is 3.0 — so on 3.0/3.1 there are no annotations for this reporter to read.
It feature-detects rather than assuming (`typeof testCase.annotations !== 'function'`), and CI runs a
3.0 leg to prove the unguarded call would have thrown. `qualflare.attachment()` works throughout;
upgrading to 3.2+ is what gets you the native ones.
