// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sumit Sharma
// Source: https://github.com/sumitpmgit-creator/medocr-hybrid/blob/5b93ec52d3a2a70d0399fbe5ec43c227c323ef1b/benchmarks/src/metrics.ts
// Modified for ClaimGuard: extracted two functions and removed TypeScript annotations.

/** Levenshtein distance over any indexable sequence (chars or word tokens). */
export function levenshtein(a, b) {
  const n = a.length, m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

/** Nearest-rank percentile (q in 0..100). */
export function percentile(xs, q) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((q / 100) * s.length));
  return s[rank - 1];
}
