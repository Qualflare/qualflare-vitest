# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.1

### Changed

- Documentation only; no code change. The limitations list now separates what *this reporter* does
  not do from what **Vitest** does not do — per-attempt retry history, the three missing statuses
  and video are properties of Vitest, not gaps here, and listing them as limitations implied we
  were withholding something. They now sit under "Not limitations of this reporter".
- The `parameter()` masking caveat and the attachment-cap consequence are surfaced in the README
  rather than only in `docs/LIMITATIONS.md`.

## 0.2.0

### Added

- `metadata.runId` on every report, plus a `runId` option (`QUALFLARE_RUN_ID`) to set it
  explicitly. Every shard of one CI run resolves the same value (`GITHUB_RUN_ID`,
  `CI_PIPELINE_ID`, and so on); outside CI it is a per-process UUID.

  This is what lets `qf collect` tell the shards of the current run apart from a file left behind
  by an earlier one. Until now a stale report sitting in `outputDir` was merged into the launch
  silently — the launch looked entirely plausible and contained results nobody ran, which corrupts
  the history flaky-detection is built on. Requires `@qualflare/cli` v0.1.19 or newer, which
  refuses the merge and names the offending files; older CLIs ignore `runId` and merge as before.

### Changed

- The stale-file caveat in `README.md` and `docs/LIMITATIONS.md` documents what now actually
  happens, instead of asking you to remember to clear the directory.

## 0.1.0

Initial public release.

### Why this exists

Vitest results previously reached Qualflare only through the Jest-compatible JSON file, which the
CLI parses with its Jest parser. That path carries pass/fail and duration and nothing else — no
retry counts, no flakiness, no attachments, no labels, links, steps or parameters. Flaky-test
detection, one of Qualflare's headline features, did not work for Vitest users at all.

### Behavior worth knowing

- `qualflare.attachment()`, `qualflare.attachmentFromFile()` and Vitest's own annotations all draw on
  the same `maxAttachmentBytes` per-attachment cap and run-wide `maxTotalAttachmentBytes` budget. An
  attachment over either limit is skipped with a warning rather than inlined. This matters because
  `/collect` rejects a request body over 10MB outright, and a rejected request loses the **entire**
  launch — not just the oversized attachment.

### Added

- Native Vitest reporter: suite/case results, retry counts, flakiness, assertion diffs, and nested
  steps via `parentIndex`.
- Writes one uniquely-named report per process into `outputDir` (default `./qualflare-results`) and
  makes **zero network calls**; `qf collect <outputDir>` uploads the result. CI asserts this by
  grepping the built bundle for an HTTP client, rather than trusting a mock server.
- Automatic shard support. Vitest exposes `--shard i/N` on its resolved config, so each case is
  stamped with the shard that ran it with no configuration — converting Vitest's 1-based index to
  Qualflare's 0-based one.
- Author-facing `qualflare` metadata API: `label`, `link`, `tag`, `description`, `priority`,
  `parameter`, `attachment`, `attachmentFromFile`, `step`. Messages travel on `task.meta`, so the
  calls are synchronous with nothing to await.
- Native `task.annotate()` annotations carrying an attachment are captured automatically
  (Vitest 3.2+).
- `qualflareReporter()` typed registration helper, since Vitest types a custom reporter's options as
  `Record<string, unknown>`.

### Notes

- Requires `@qualflare/cli >= v0.1.18` — the first release that recognises `vitest` as a framework.
  An older CLI silently labels the suites `generic`. This also required an api-service migration
  adding `vitest` to the `test_type` enum, so a self-hosted Qualflare must be current too.
- Requires `vitest >= 3.0.0`. The reporter is built on the Reported Tasks API
  (`onTestCaseResult`, `onTestRunEnd`, `TestCase`), which does not exist in Vitest 2 — that version's
  reporter interface cannot supply a retry count, a flaky flag, or annotations at all.
- Native annotations require Vitest 3.2+ (`TestCase.annotations()` does not exist before that). On
  3.0/3.1 the reporter reads none rather than refusing to install; `qualflare.attachment()` works
  throughout. CI runs a 3.0 leg specifically to prove the unguarded call would have thrown.
- No video: Vitest records none. Browser-mode artifacts (`TestCase.artifacts()`) are 4.x-only and
  experimental, and deliberately not read yet.
- Steps exist in Qualflare only. Vitest has no `test.step()` to delegate to, unlike the sibling
  Playwright reporter.
