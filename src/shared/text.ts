/**
 * Rune-safe truncation for wire fields the server bounds.
 *
 * "Runes" means Unicode CODE POINTS, which is what the server counts. A plain
 * `s.slice(0, n)` counts UTF-16 code units instead, so it both over-counts
 * (an emoji is two units, one rune) and can cut a surrogate pair in half,
 * putting a lone surrogate on the wire. Test output contains emoji routinely.
 *
 * Mirrors the identical helper in the sibling reporters. Only `truncateRunes`
 * is ported here — Vitest exposes no per-attempt stdout/stderr, so there is
 * nothing for `clampOutputLines` to bound.
 */
export function truncateRunes(value: string, maxRunes: number): string {
  // Fast path: UTF-16 length is always >= the code-point count, so if the
  // cheap measure already fits, the real one does too. Matters because these
  // are called per attempt on strings that can be hundreds of KB.
  if (value.length <= maxRunes) {
    return value;
  }
  const runes = Array.from(value);
  if (runes.length <= maxRunes) {
    return value;
  }
  return runes.slice(0, maxRunes).join('');
}
