import { expect, test } from 'vitest';

test('fails with a diff', () => {
  // The rendered expected/actual diff is the most useful part of a Vitest
  // failure; the reporter must carry it through without ANSI escapes.
  expect({ a: 1 }).toEqual({ a: 2 });
});
