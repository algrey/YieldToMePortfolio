---
name: project-sharesight-sync-invariants
description: Load-bearing invariants of the Sharesight read-sync (GET-only seal, staging-vs-commit watermark hazard, source_reference key shapes, reversal semantics) to check on any BRK-* sync diff
metadata:
  type: project
---

Facts that repeatedly decide whether a Sharesight-sync diff is safe. Verified
during the BRK-015 review (2026-09-02) against the code, not recalled.

**The staging-vs-commit hazard is the whole ballgame.** BRK-005 ruling 4
advances `sharesight_sync_state.last_synced_at` on successful STAGING, never on
commit, and the owner has confirmed staging a batch and never accepting it is a
LIKELY path on this account. Measured: after an abandoned staging,
`last_synced_at` = now while the committed state is untouched. So ANY fetch
narrowing, cursor, or "already seen" check keyed to `last_synced_at` /
`last_trade_watermark` silently skips whatever the abandoned batch staged.
BRK-015's answer is `loadCommittedSharesightWatermark`
(`db/repositories/sharesight-sync-state.ts`), which derives from
`transactions`/`dividend_manual_records` instead — tables a staged row never
touches until commit.

**source_reference key shapes** (needed for any `LIKE`/prefix query):
`import-fingerprint:` + the row fingerprint. Trades are
`sharesight-trade:<sharesight trade id>`; payouts are NOT id-keyed since
BRK-005C — `sharesight-payout:<sharesightPortfolioId>:<holdingId>:<paidOnDate>`
(`domain/sharesight-sync/transform.ts`'s `payoutIdentityKey`). CSV rows use
`import-fingerprint:<sha256>`, a disjoint key space (that disjointness is
BUG-011's root cause). Both prefixes are ~37-38 bytes, safely under D1's 50-byte
LIKE-pattern cap (see [[review-recurring-issues]] pattern 8).

**Reversal semantics that a "live ledger state" query must respect.** Measured:
`db/repositories/import-reversal.ts` sets the original transaction
`status = 'reversed'` and DELETEs the dividend record outright, restoring any
manual record it superseded. So for a WATERMARK, `status = 'posted'` plus
`superseded_by_record_id IS NULL` is the correct live filter, and reversing a
batch correctly drops a derived watermark BACKWARDS (safe direction: a wider
re-fetch, deduped at commit).

**But `status = 'posted'` alone is NOT "economically in force" for transactions.**
`ledger.reverse()` re-runs `prepareLedgerPosting` on the ORIGINAL input, so the
compensating mirror row is `status = 'posted'` with the SAME
type/quantity/price/date/`portfolio_security_id`, `source_reference` NULL and
`reverses_transaction_id` set (re-proved end to end 2026-09-02 during the
BUG-011 review: after a full batch reversal, a
`status='posted' AND type IN ('buy','sell')` query still returns exactly one row
with the reversed trade's identity). Any query that MATCHES ON ECONOMIC IDENTITY
(not on dates/aggregates, where the mirror is harmless or self-cancelling) must
add `reverses_transaction_id IS NULL`. Harmless for a `MAX(date)` watermark;
wrong for a duplicate-detection surface.

**Dividends have NO reversal-mirror analogue — the trade lesson does not
transfer.** Verified 2026-09-02 (BUG-013): `db/repositories/import-reversal.ts`'s
`finalize()` hard-`DELETE`s a reversed batch's `dividend_manual_records` rows
and, in the same statement set (ordered BEFORE the delete), NULLs
`superseded_by_record_id` back out on any manual ancestor the batch had
superseded. The table has no `status` column at all. So
`superseded_by_record_id IS NULL` is the complete "live fact" filter for
`dividend_manual_records` — no `reverses_*` exclusion is needed or possible.
Also confirmed: `currency_code` is NULL whenever the row's amounts are already
in its SECURITY's own currency and non-NULL only when they are foreign to it
(schema header + `import-commit.ts`'s dividend branch), so it can never be
compared for equality against an incoming CSV row's declared currency.

**Sharesight query params are `start_date`/`end_date`, not `from`/`to`.** The
client's internal `SharesightListParams.from/.to` are mapped in
`domain/sharesight/client.ts`'s `toSearchParams`. Wrong keys are silently
ignored server-side and return unfiltered full history with a 200 — this was the
real cause of "syncs back to 2019 every time", not a missing design.

**Which date field the filter applies to is not the one the app stores.**
Live-confirmed 2026-09-02 (worker's second GET-only spike, method recorded in the
worker's own `sharesight-sync-window-investigation` memory): `listPayouts`'s
`start_date` filters by **ex-date (`goes_ex_on`)**, while the app's payout
watermark comes from `dividend_manual_records.payment_date` (paid date) — there
is no committed ex-date column. So a payout lookback constant buys only
`(constant - ex-to-paid gap)` days of real paid-date coverage; on the owner's
account every payout has a nonzero gap, largest observed 62 days. That is why
`SHARESIGHT_PAYOUT_SYNC_OVERLAP_DAYS` is 180, not the owner's approved 90. The
equivalent question for `listTrades` (does its `start_date` filter
`transaction_date`, the field `local_trade_date` derives from?) has NOT been
live-verified; the 30-day trade overlap rests on that assumption. Neither is
settleable from a local test — it needs a live GET.

**The batch digest is the repo's definition of "value-bearing" for a synced
row.** `app/sharesight-sync-service.ts`'s `canonicalRowDigestFields` joins
`fingerprint | type | symbol | exchange | currency | sharesOwned |
costPerShare | commission | localTradeDate | tradeAtUtc | frankingPerShare |
totalCashDecimal | totalFrankingDecimal | exchangeRateDecimal`. A change to ANY
of them makes `startUpload` create a genuinely new batch (BRK-005 finding B1 /
BRK-010 finding B2). Any later "is this row unchanged?" comparison must be
judged against this list, not against a shorter one (see
[[review-recurring-issues]] pattern 36).

**Commit-time dedupe is identity-only on BOTH tables, with no status filter.**
`db/repositories/import-commit.ts`: trades
`WHERE user_id=? AND portfolio_id=? AND source_type='csv_import' AND
source_reference=?`; dividends `WHERE user_id=? AND portfolio_id=? AND
source_reference=?`. So a value-CORRECTED row (same identity) is silently
SKIPPED at commit exactly like a true duplicate — accepting a batch that
contains a correction does not apply it. Verified 2026-09-03. The preview is
silent about it too: BUG-013's `dividendAlreadyBoundForSkip`/
`tradeAlreadyBoundForSkip` suppress the near/matches-existing warnings on
precisely those identity-matched rows.

**The GET-only seal is in `domain/sharesight/transport.ts`, not the client.**
`sharesightGet` rejects a smuggled `method` property and method-override-shaped
headers before calling `fetcher`; query params flow through
`url.searchParams.set` and cannot reach it. A diff that only touches
`toSearchParams`/params cannot weaken the seal — check `transport.ts` itself is
untouched and stop there.

**Which of the 13 digest fields can actually vary INDEPENDENTLY of the
row's identity** (measured 2026-09-03, BRK-014 round 2, real writers):
trades key on `sharesight-trade:<id>` alone, payouts on
`<portfolioId>:<holdingId>:<paidOnDate>`, so `symbol`, `exchange`,
`currency` and (payouts only) `exchangeRateDecimal` all vary with the
identity unchanged — they are NOT "folded into the source_reference".
`tradeAtUtc` is derived from the same date as `localTradeDate`
(`deriveDates`) and never varies alone; `frankingPerShare`/totals are null
for trades and `sharesOwned`/`costPerShare`/`frankingPerShare` null for
payouts, so those cannot vary per class. Committed counterparts:
`transactions.currency_code` (NOT NULL, verbatim `normalized.currency`),
`transactions.type`/`local_trade_date`/`fee_amount_decimal`
(`commission ?? "0"`) all verbatim; `dividend_manual_records.payment_date`
= `normalized.localTradeDate`; `dividend_manual_records.
fx_rate_to_portfolio_decimal` DOES store `normalized.exchangeRateDecimal`
verbatim — but ONLY when the payout currency is foreign to the SECURITY's
currency (`import-commit.ts` case B/C); a native payout that carries a rate
stores nothing, so a naive `decimalValuesMatch(incoming, stored)` on that
column would report every such payout as NEW on every routine re-sync.
Symbol/exchange have no directly comparable column (only
`portfolio_security_id`, and a mapping decision can override resolution).
`dividend_manual_records.currency_code` is written under the SAME
foreign-to-security condition as the FX rate (`import-commit.ts:777-805`,
cases B/C) and a non-null rate never appears without it, so it COULD be
compared with the same three-way rule (stored NULL = not comparable) —
strictly more coverage, no false-positive risk.

**`started.reused === false` does NOT mean "a value changed".**
`canonicalFetchDigestSource` hashes the whole sorted ROW SET plus
`portfolioId`/`sharesightPortfolioId`, so a different row COMBINATION
(Full-vs-routine mode, a watermark-narrowed window after a commit, a
dropped row) or a first-ever sync also yields a new batch. Verified
2026-09-03 by repro. Any UI copy or doc sentence inferring a per-field
change from `reused === false` is false; see
[[review-recurring-issues]] pattern 36c.

**Payout `currency` IS compared since BRK-014 round 4** (`357f3eb`):
`currencyNotComparableOrMatches` in `app/sharesight-sync-service.ts`, exact
string match against `dividend_manual_records.currency_code` only when that
column is non-null. Verified: `import-commit.ts` writes it verbatim from
`normalized.currency` in BOTH foreign branches (rate-present and case
C-no-rate), never from the security's currency; native payouts store NULL; no
repository UPDATEs it afterwards; `domain/sharesight-sync/transform.ts:509`
always sets `normalized.currency`, so the incoming-null path is unreachable and
conservative anyway. Residual (uncompared) fields are now `symbol`/`exchange`
only.

**`reused: false` also happens with NO prior sync at all.** `startUpload`
dedupes on the unique `(user_id, file_sha256, parser_format, parser_version)`
constraint (`db/repositories/import-staging.ts:1041`), and
`domain/exports/portfolio-bundle.ts` carries `transactions`/
`dividendManualRecords` but NOT `import_batches` — so a restored ledger's first
sync creates a new batch while every row reads as already imported. Any copy
phrased "differs from the last sync" is false on that path.

**The token provider is memoized per ISOLATE since BRK-016** (`de4dd6e`).
`worker/sharesight-config.ts` holds one module-scope
`{clientId, clientSecret, provider}` slot, consulted ONLY when
`createSharesightIntegrationConfig` is called with no `dependencies` — which is
exactly the four production call sites (`worker/scheduled-refresh.ts` x2,
`app/sharesight-price-gate-service.ts`, `app/sharesight-sync-service.ts`,
all single-argument; re-verified 2026-09-03). `domain/sharesight/client.ts`
calls `tokenProvider.invalidate?.()` on a data-call 401 only; `invalidate()`
clears `cached` and deliberately never touches `inFlight`. Measured: two
CONCURRENT data calls on a cold provider cost ONE exchange (single-flight), both
401s invalidate idempotently, and the next call re-exchanges exactly once.
Caveat for future tests: a test that calls the factory WITHOUT `dependencies`
uses the memo and the REAL `globalThis.fetch` (bound at provider construction,
`token.ts`'s `fetch.bind(globalThis)`), so it must stub `globalThis.fetch`
BEFORE constructing the config and call
`__resetSharesightIntegrationCacheForTests()` in a `finally` — the code comments'
claim that "every test injects `dependencies`" is not true of BRK-016's own
tests.

**`runSharesightSyncWithContext` fetches both streams with `Promise.all` since
BRK-016.** Typed failure precedence is unchanged (trades checked first), and
there is no unhandled-rejection hazard. One behaviour delta, reproduced: if
`listTrades` returns `ok:false` and `listPayouts` REJECTS, the function now
THROWS instead of returning the 502 result (pre-fix, `listPayouts` was never
invoked after a trade failure). Unreachable with the real client, whose every
network/parse path returns a typed result.

**List endpoints do not paginate (live-probed 2026-09-04, BRK-017).** Trades
107/107/107, payouts 119/119/119, user_instruments 18/18/18 across
wide / `page=1&per_page=1` / `page=2`; the only envelope siblings are `links`
(only ever `self`, or `{}`) and `api_transaction` on the v3 trades envelope.
v3 trades STRIPS unknown `page`/`per_page` from the `self` echo, v2 payouts
echoes them — either way the array is unchanged, so only an array-length
change may ever be read as paging. HTTP headers are never surfaced by
`getJson`, so a header-only pagination signal stays unruled-out. Since
BRK-017 step 2, `parseItemList` fails the WHOLE list closed
(`invalid_response`) on pagination-shaped envelope metadata, and every
consumer (sync 502, price-refresh/price-gate `fetch_failed` watermark, daily
capture skip) fail-closes without fabricating data — so a guard false
positive is loud, never a partial import. See
[[review-recurring-issues]] 63 for the two trigger-set defects found there.
