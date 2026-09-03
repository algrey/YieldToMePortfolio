// EXP-001 (extracted for EXP-004): a real topological order over a chain
// graph, NOT a `createdAt` sort -- see the header comment this carries
// forward below for the full "why". BUG-018 (round 2) made the traversal
// depth-first so a reversal/supersession is emitted immediately after the
// transaction it targets.
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
 * other item it depends on -- a real topological order over the chain graph
 * `dependencyOf` describes, NOT a `createdAt` sort.
 *
 * BUG-018 (round 2): the traversal is DEPTH-FIRST (pre-order), not the
 * breadth-first sweep this originally used. Both are valid topological
 * orders, but breadth-first emits EVERY root before ANY child, which is
 * not merely a readability difference -- it is incorrect for a chain the
 * ledger now legally allows:
 *
 *   original (reversed) <- reversal mirror,  plus  a re-imported TWIN of
 *   the original that reuses the SAME `source_reference`
 *
 * BUG-018 narrowed `transactions_portfolio_source_reference_unique` to
 * `WHERE status <> 'reversed'`, so a reversed transaction no longer
 * occupies its `source_reference` key and a re-import of the same trade is
 * a legitimate, exportable shape. Breadth-first ordered that bundle
 * [original, twin, mirror]: the twin was posted while the original was
 * still `posted`, and the partial index rightly rejected it -- the restore
 * failed with "A transaction could not be replayed (conflict)" even though
 * the exported state was perfectly valid. Depth-first emits
 * [original, mirror, twin]: the reversal that FREES the key is replayed
 * immediately after the transaction it targets, before any unrelated root.
 *
 * The rule, stated positively: a reversal/supersession is emitted
 * IMMEDIATELY after the transaction it depends on (and, transitively, its
 * own dependents before any other root). Ordering among UNRELATED nodes is
 * unchanged -- roots and sibling children are still sorted by the same
 * `createdAt`-then-`ref` tiebreak, so the order stays fully deterministic
 * and identical on both sides of a chunked replay.
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
  const roots: T[] = [];
  for (const item of items) {
    const dep = dependencyOf(item);
    if (dep === null || !byRef.has(dep)) {
      roots.push(item);
      continue;
    }
    const siblings = children.get(dep);
    if (siblings) siblings.push(item);
    else children.set(dep, [item]);
  }
  roots.sort(stableCompare);
  for (const siblings of children.values()) siblings.sort(stableCompare);
  // Pre-order DFS over an explicit stack (never recursion -- a bundle's
  // chain depth is owner-controlled). Pushing sorted children in REVERSE
  // makes the stack pop them in sorted order, so siblings keep the same
  // deterministic `createdAt`/`ref` sequence a breadth-first sweep gave
  // them; the only change is that a node's whole subtree is emitted before
  // the next root. A cycle (structurally impossible -- see below) has no
  // root, so it is never pushed and can never spin this loop.
  const ordered: T[] = [];
  const stack: T[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    stack.push(roots[index]!);
  }
  while (stack.length > 0) {
    const item = stack.pop()!;
    ordered.push(item);
    const kids = children.get(item.ref);
    if (!kids) continue;
    for (let index = kids.length - 1; index >= 0; index -= 1) {
      stack.push(kids[index]!);
    }
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
