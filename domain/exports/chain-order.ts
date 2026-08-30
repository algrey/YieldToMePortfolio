// EXP-001 (extracted for EXP-004): a real topological (Kahn's-algorithm)
// order over a chain graph, NOT a `createdAt` sort -- see the header comment
// this carries forward below for the full "why".
//
// EXP-004 moved this out of `app/portfolio-bundle-service.ts` (server-only:
// that module pulls in D1 repositories) into this dependency-free `domain/`
// module so BOTH sides of a resumable, chunked bundle replay can use the
// IDENTICAL ordering: the server (unchanged behaviour, now imported rather
// than defined locally) and the browser panel
// (`app/components/system-backup-panel.tsx`), which must slice a portfolio's
// transactions/dividend records into request-sized parts in the SAME order
// the server would compute, so that a chain dependency (a reversal's or
// supersession's target) always lands in an earlier part (or earlier in the
// same part) than its dependent -- never a later one.
export type ChainItem = { ref: string; createdAt: string };

/**
 * Orders `items` so every item is placed strictly after the (at most one)
 * other item it depends on -- a real topological (Kahn's-algorithm) order
 * over the chain graph `dependencyOf` describes, NOT a `createdAt` sort.
 *
 * A `createdAt`-only sort (the original implementation) is provably
 * unsafe: `ledger.post`/`reverse`/`supersede` and the dividend-record
 * writers all stamp `created_at` at MILLISECOND resolution, so two rows
 * created in the same millisecond (routine on fast/in-memory writes, and
 * reproduced by this module's own test suite as a real, non-deterministic
 * failure -- "A supersession's original transaction was not replayed
 * first") tie, and the previous ref-based tiebreak (`a.ref.localeCompare`)
 * compares random UUIDs with no relation to dependency order. This
 * function is driven purely by the bundle's own explicit `ref` graph, so
 * it is correct regardless of timestamp resolution or collisions.
 * `createdAt`/`ref` are used only to order otherwise-independent items
 * for readability/determinism, never to decide dependency order.
 */
export function chainOrder<T extends ChainItem>(
  items: readonly T[],
  dependencyOf: (item: T) => string | null,
): T[] {
  const byRef = new Map(items.map((item) => [item.ref, item]));
  const stableCompare = (a: T, b: T): number =>
    a.createdAt === b.createdAt
      ? a.ref.localeCompare(b.ref)
      : a.createdAt.localeCompare(b.createdAt);
  const children = new Map<string, T[]>();
  const queue: T[] = [];
  for (const item of items) {
    const dep = dependencyOf(item);
    if (dep === null || !byRef.has(dep)) {
      queue.push(item);
      continue;
    }
    const siblings = children.get(dep);
    if (siblings) siblings.push(item);
    else children.set(dep, [item]);
  }
  queue.sort(stableCompare);
  const ordered: T[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const item = queue[cursor];
    ordered.push(item);
    const kids = children.get(item.ref);
    if (!kids) continue;
    kids.sort(stableCompare);
    queue.push(...kids);
  }
  // Defensive: a dangling/cyclic dependency should be structurally
  // impossible (`validatePortfolioBundle` checks every `reversesRef`/
  // `supersedesRef`/`supersedesRef` points at a ref the bundle actually
  // contains, and rejects a transaction that is both a reversal and a
  // supersession), but never silently drop a row if one somehow occurs --
  // append it so the per-row dependency check downstream still fails
  // closed with a clear message.
  if (ordered.length < items.length) {
    const placed = new Set(ordered.map((item) => item.ref));
    for (const item of items) if (!placed.has(item.ref)) ordered.push(item);
  }
  return ordered;
}
