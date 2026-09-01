# qualflare-vitest basic example

A minimal, standalone Vitest project showing typical `@qualflare/vitest` usage: reporter
registration via the typed `qualflareReporter()` helper, and the `qualflare.*` metadata API
(`label`, `link`, `tag`, `description`, `priority`, `parameter`, `step`).

## Running it against a real Qualflare account

The reporter never uploads anything itself: `vitest run` writes a report directory, and
`qualflare-cli` uploads it as a separate step. That split is what lets sharded CI jobs each write
into the same directory and be merged into one Launch by a single `collect`.

```sh
cd examples/basic
npm install

# 1. Run the tests. Writes ./qualflare-results, no network calls.
npm test

# 2. Upload. This is the only step that touches the network.
npx @qualflare/cli <your-project-identifier> collect ./qualflare-results
```

`collect` needs `@qualflare/cli` v0.1.18 or newer — that is the first release that recognises
`vitest` as a framework. An older CLI silently labels the suites `generic` instead.

## What to look at

- **`vitest.config.ts`** — reporter registration. `qualflareReporter({ ... })` returns the same
  `['@qualflare/vitest/reporter', options]` tuple you could write by hand, but type-checked.
- **`tests/checkout.test.ts`** — labels, a typed link, priority, a description, and nested
  `qualflare.step()` calls with per-step parameters.
- **`tests/login.test.ts`** — tags and a case-level parameter.

## Sharding

Nothing to configure. Vitest hands the reporter its own `--shard` value, and the reporter converts
it from Vitest's 1-based index to Qualflare's 0-based one:

```sh
vitest run --shard=1/3   # writes one report file
vitest run --shard=2/3   # ...another, into the same directory
vitest run --shard=3/3

npx @qualflare/cli <project> collect ./qualflare-results   # merged into ONE launch
```

Each shard writes a uniquely-named file, so they can safely share one `outputDir` — including on a
shared CI volume.
