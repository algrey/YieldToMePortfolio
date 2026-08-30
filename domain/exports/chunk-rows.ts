// EXP-004: the pure row-chunking arithmetic shared by every resumable,
// browser-driven part loop (the system-backup restore's price/transactions/
// dividends parts, `app/components/system-backup-panel.tsx`). Split out into
// its own dependency-free module (mirroring `chain-order.ts`'s identical
// reasoning) purely so the chunk-boundary math itself -- easy to get subtly
// wrong at the edges (an empty input, an input that is an exact multiple of
// the chunk size, one row over) -- has direct unit tests, rather than being
// pinned only indirectly through a `.tsx` source-grep the plain Node test
// runner cannot execute.
export function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}
