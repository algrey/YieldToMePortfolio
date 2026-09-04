import { randomUUID } from "node:crypto";
import { normalizeToken } from "../../domain/securities/verify-identity.ts";
import {
  GLOBAL_TICKER_CURRENCY_TIER,
  resolveGlobalTickerCurrencyCandidate,
  resolveSecurityCandidate,
  type ResolveSecurityCandidateTier,
  type SameUserSecurityEvidenceRow,
} from "../../domain/securities/resolve-security-candidate.ts";
import type { SecurityIdentifierCandidateRow } from "../../domain/securities/resolve-security.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import type { SecurityVerificationCandidateInput } from "./security-verification.ts";

// BRK-009B: auto-resolution/auto-creation for `sharesight_sync` batches ONLY
// -- CSV batches keep the pre-existing owner-driven candidate/verify/attest
// flow (`security-verification.ts`/`security-attestation.ts`) completely
// unchanged; this module is never consulted for a CSV-sourced candidate. It
// mirrors those two repositories' creation-only, guard-conditional,
// single-`batch()`-call discipline (see `security-attestation.ts`'s header
// comment for the pattern this follows) but resolves through BRK-009A's
// multi-scheme resolver (`domain/securities/resolve-security.ts`) wrapped by
// THREE priority tiers, each strictly currency-aware and never merging on
// ticker text alone (2026-08-18 review round, findings B1/B2/B3):
//   1. `resolveSecurityCandidate`'s strict + same-user fallback.
//   2. `resolveGlobalTickerCurrencyCandidate` -- a cross-owner ticker+currency
//      dedupe tier (legitimate: `securities` is a shared canonical master,
//      IMP-004B precedent), consulted only when (1) found no match.
//   3. Genuine creation -- reached only when NEITHER (1) NOR (2) found
//      anything, guarded on ticker+CURRENCY (never ticker text alone, which
//      would permanently block a legitimately distinct-currency security --
//      B3) plus, when Sharesight supplied one, the `sharesight_instrument`
//      value-space (the 0039 migration's real unique index).
// Every SQL predicate that resolves "does a ticker match already exist"
// (creation guards, the post-batch winner lookup, and the pre-check that
// decides between tier (2)/tier (3)) carries the SAME `ticker text +
// currency` join against `securities.primary_currency_code` -- there is
// exactly one identity key this repository ever treats as sufficient for a
// ticker-text match, and it is never ticker text alone (B1).

export type SecurityResolutionCandidateIdentity = {
  symbol: string;
  exchangeAlias: string | null;
  currencyCode: string;
  sharesightInstrumentId: string | null;
  isin: string | null;
  /** Sharesight's own instrument display name, when present -- becomes
   * `securities.canonical_name` on creation only (falls back to the symbol
   * when absent); never used for matching. Sanitized (control-character
   * stripped, length-capped) before being written -- see
   * `sanitizeCanonicalName` below (BRK-009B review finding F2). */
  instrumentName: string | null;
  /** BRK-010: `"trade"` when every row in this candidate's group is a
   * buy/sell, `"dividend"` when every row is a payout/dividend row -- the
   * caller (`app/security-resolution-service.ts`) groups rows by
   * symbol+exchange+currency, so a group is naturally one or the other
   * (occasionally a payout happens to share a trade's currency and lands in
   * the SAME group; the group as a whole is still safely `"trade"` in that
   * case, since currency already agrees so the exemption is moot). Threaded
   * through to `resolveSecurityCandidate`'s strict-resolver call AND to this
   * repository's own pre-existing-link currency recheck below -- see
   * `domain/securities/resolve-security.ts`'s `rowClass` doc comment for the
   * exemption this enables. Optional, defaulting to `"trade"` (the strict,
   * pre-BRK-010 behaviour) when omitted -- mirrors
   * `ResolveSecurityCandidateIdentity.rowClass`'s identical default, so
   * every pre-BRK-010 caller/fixture keeps compiling and behaving
   * unchanged. */
  rowClass?: "trade" | "dividend";
};

// F2 (BRK-009B review): mirrors IMP-009's owner-attested display-name cap
// (`security-attestation-service.ts`, <=120 chars, no control characters),
// but Sharesight data has no interactive owner to correct a malformed value
// inline the way a form submission does, so this module prefers TRUNCATE +
// STRIP over REJECT: a malformed/over-length instrument name degrades to a
// still-usable display string rather than failing the whole auto-create --
// and therefore the owner's real holdings/income -- closed over a label
// formatting quirk.
const MAX_CANONICAL_NAME_LENGTH = 120;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/g;

// Exported (BRK-009C) so `app/import-security-metadata-service.ts`'s owner
// name-correction edit for an auto-created security applies the EXACT SAME
// sanitization this module's own auto-create path does, rather than a
// second, potentially-drifting reimplementation of the same rule.
export function sanitizeCanonicalName(rawName: string): string {
  const stripped = rawName.replace(CONTROL_CHARACTER_PATTERN, "").trim();
  const safe = stripped.length > 0 ? stripped : "Unnamed security";
  return safe.slice(0, MAX_CANONICAL_NAME_LENGTH);
}

// A tier label distinct from every tier `resolve-security.ts`/
// `resolve-security-candidate.ts` themselves define, reported ONLY when a
// PRE-EXISTING `portfolio_securities` link is found to disagree on currency
// with the identity now being resolved (B2) -- a defensive re-validation of
// data this repository never wrote in the first place, so it is reported
// under its own name rather than borrowed from another tier's meaning.
const EXISTING_LINK_CURRENCY_MISMATCH_TIER = "existing_link_currency_mismatch";

export type SecurityResolutionLinkResult =
  | {
      ok: true;
      outcome: "already_resolved" | "matched" | "created";
      securityId: string;
      portfolioSecurityId: string;
      tier: ResolveSecurityCandidateTier | null;
      created: boolean;
    }
  | {
      ok: false;
      reason: "conflict";
      tiers: readonly (
        | ResolveSecurityCandidateTier
        | typeof EXISTING_LINK_CURRENCY_MISMATCH_TIER
      )[];
      securityIds: readonly string[];
    }
  | { ok: false; reason: "invalid_currency" }
  | { ok: false; reason: "link_conflict" };

export type SecurityResolutionRepository = {
  /**
   * Resolves `identity` against the shared `securities` master and links
   * (creating the `portfolio_securities` row if it does not exist yet) the
   * owner's `candidate`. Never writes a `security_provider_mappings` row --
   * see `security-attestation.ts`'s identical provenance-honesty rule, which
   * this mirrors exactly (auto-created securities are provider-mapping-less
   * until a later provider verify/IMP-009 attest upgrades them, exactly like
   * an owner-attested security today).
   */
  resolveAndLink(
    userId: string,
    identity: SecurityResolutionCandidateIdentity,
    candidate: SecurityVerificationCandidateInput,
  ): Promise<SecurityResolutionLinkResult>;
};

// BRK-009C: the durable, queryable "was this security auto-created by
// BRK-009B's own resolution pass" signal the "Review securities" summary
// reads to distinguish `state: "created"` from `state: "resolved"` (a
// candidate this batch merely matched to a security that already existed,
// however it was made) -- mirrors `listAttestedSecurityIds`'s identical
// absence/presence-of-identifier technique (`security-attestation.ts`)
// rather than parsing audit-log metadata: `createAndLink` above ALWAYS
// stamps a fresh `ticker` identifier with `source = 'sharesight'` when it
// creates a security (never on a match/link-only path, and never written
// by any other repository -- `security-verification.ts` stamps the
// provider's own name, `security-attestation.ts` stamps
// `'owner_attested'`), so this is a durable per-security fact, not scoped
// to any one batch's own resolution run.
export async function listAutoCreatedSecurityIds(
  client: SqlClient,
  securityIds: readonly string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(securityIds)];
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = await client.all<{ security_id: string }>(
    `SELECT DISTINCT security_id AS security_id
       FROM security_identifiers
      WHERE scheme = 'ticker' AND source = 'sharesight' AND valid_to IS NULL
        AND security_id IN (${placeholders})`,
    uniqueIds,
  );
  return rows.map((row) => row.security_id);
}

// BRK-009C review round (finding B1): a STRICTER, user-scoped subset of
// `listAutoCreatedSecurityIds` above -- the securities whose name THIS user
// may edit from the "Review securities" screen right now. Auto-created
// alone is not sufficient: `securities`/`security_identifiers` are a shared
// canonical master (IMP-004B precedent), so a security this app created can
// later be (a) linked by ANOTHER owner's portfolio (making it shared
// canon -- renaming it here would silently rename another owner's holding's
// display name), or (b) upgraded by a later provider verification (adding
// an active `security_provider_mappings` row -- the provider's own naming
// becomes authoritative, never overwritten by an owner's free-text edit
// here). This function is a UX convenience only (drives which rows the UI
// even OFFERS the edit control for); `app/import-security-metadata-service.ts`'s
// guarded `UPDATE securities ... WHERE` re-enforces the identical three
// predicates at write time regardless, so a race between this read and the
// write can never actually rename a security that fails any predicate.
export async function listNameEditableSecurityIds(
  client: SqlClient,
  userId: string,
  securityIds: readonly string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(securityIds)];
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = await client.all<{ security_id: string }>(
    `SELECT DISTINCT si.security_id AS security_id
       FROM security_identifiers si
      WHERE si.scheme = 'ticker' AND si.source = 'sharesight' AND si.valid_to IS NULL
        AND si.security_id IN (${placeholders})
        AND NOT EXISTS (
              SELECT 1 FROM security_provider_mappings spm
               WHERE spm.security_id = si.security_id
                 AND spm.valid_to IS NULL AND spm.status = 'verified'
            )
        AND NOT EXISTS (
              SELECT 1 FROM portfolio_securities ps
               WHERE ps.security_id = si.security_id AND ps.user_id <> ?
            )`,
    [...uniqueIds, userId],
  );
  return rows.map((row) => row.security_id);
}

export type ResolvedInstrumentCurrencyRow = {
  /** Present only when a `security_identifiers` row with
   * `scheme = 'sharesight_instrument'` (valid_to IS NULL) exists for this
   * security -- `null` for a security that was never linked via Sharesight
   * evidence (e.g. CSV-only). */
  sharesightInstrumentId: string | null;
  /** `portfolio_securities.source_symbol` -- for a Sharesight-sourced row
   * this is the trade's `instrumentCode` or the payout's `symbol`,
   * byte-identical either way (both feed the same `candidate.sourceSymbol`
   * in `app/security-resolution-service.ts`). */
  symbol: string;
  /** `portfolio_securities.source_exchange_alias` -- the trade's/payout's
   * own `marketCode`. */
  exchangeAlias: string | null;
  /** The REAL, DB-resolved `securities.primary_currency_code` for whatever
   * security this instrument is already linked to in this user's portfolio
   * -- never a guess or a portfolio-base fallback. */
  currencyCode: string;
};

/**
 * BRK-010 review round 3 (BLOCKING): `domain/sharesight-sync/transform.ts`'s
 * `payoutSecurityCurrencyProxy` previously fell back to the portfolio's own
 * base currency whenever THIS SAME FETCH carried no trade for a payout's
 * instrument -- but trades are historical (fetched once, rarely repeated)
 * while payouts recur, so "no same-fetch trade" is the REALISTIC STEADY
 * STATE, not an edge case, and that fallback was a bare guess masquerading
 * as evidence (an NZD-security's recurring USD payout wrongly read as
 * "case B, achievable" forever, with NOTHING inside a batch able to clear
 * the resulting `SHARESIGHT_PAYOUT_FX_RATE_MISSING` block -- re-resolution
 * only clears `SECURITY_RESOLUTION_CONFLICT`, never this code; see
 * `app/security-resolution-service.ts`'s `markConflictIssuesResolved`).
 * Every instrument this user has ALREADY resolved a security for, in THIS
 * portfolio, regardless of source (an earlier Sharesight sync or a CSV
 * import) -- real evidence, called from `app/sharesight-sync-service.ts`
 * BEFORE the pure `transformSharesightSync` runs, so the proxy can prefer
 * it over both the same-fetch trade heuristic and (now removed) the
 * portfolio-base guess. A brand-new, payout-only instrument with no
 * resolved security anywhere yet simply returns no row for that instrument
 * here -- the caller then has genuinely NO evidence and must not guess
 * (see `payoutSecurityCurrencyProxy`'s own doc comment for how that absence
 * is handled: never a block).
 */
export async function loadResolvedPortfolioInstrumentCurrencies(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<ResolvedInstrumentCurrencyRow[]> {
  const rows = await client.all<Record<string, unknown>>(
    `SELECT ps.source_symbol AS source_symbol,
            ps.source_exchange_alias AS source_exchange_alias,
            s.primary_currency_code AS primary_currency_code,
            si.value AS sharesight_instrument_id
       FROM portfolio_securities ps
       JOIN securities s ON s.id = ps.security_id
       LEFT JOIN security_identifiers si
         ON si.security_id = ps.security_id
        AND si.scheme = 'sharesight_instrument' AND si.valid_to IS NULL
      WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.security_id IS NOT NULL`,
    [userId, portfolioId],
  );
  return rows.map((row) => ({
    sharesightInstrumentId:
      row.sharesight_instrument_id === null
        ? null
        : String(row.sharesight_instrument_id),
    symbol: String(row.source_symbol),
    exchangeAlias:
      row.source_exchange_alias === null
        ? null
        : String(row.source_exchange_alias),
    currencyCode: String(row.primary_currency_code),
  }));
}

/** One already-linked `portfolio_securities` row, as evidence for BRK-022
 * slice 2's pending-payout resolution below. */
export type ResolvablePortfolioSecurityForPendingPayouts = {
  portfolioSecurityId: string;
  sharesightInstrumentId: string | null;
  symbol: string;
  exchangeAlias: string | null;
  currencyCode: string;
};

/**
 * BRK-022 slice 2: resolves a future-dated (announced, not-yet-paid)
 * Sharesight payout to an EXISTING `portfolio_securities` row for THIS
 * user+portfolio -- reuses the EXACT same join
 * `loadResolvedPortfolioInstrumentCurrencies` above already established for
 * "already-linked instrument" evidence, but additionally surfaces `ps.id`
 * (needed to populate `sharesight_pending_payouts.portfolio_security_id`)
 * alongside `s.primary_currency_code` (needed by
 * `app/sharesight-sync-service.ts` to decide whether the payout is foreign
 * to its own security for FX-field storage, mirroring
 * `db/repositories/import-commit.ts`'s dividend branch exactly -- see that
 * service's own doc comment). NEVER creates a security: an instrument with
 * no resolved row simply has no entry here, and the caller's own tiered
 * match (Sharesight instrument id, then symbol+exchange -- see
 * `domain/sharesight-sync/transform.ts`'s `instrumentMatchKey`) leaves such
 * a payout `portfolioSecurityId: null` rather than guessing.
 */
export async function loadResolvablePortfolioSecuritiesForPendingPayouts(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<ResolvablePortfolioSecurityForPendingPayouts[]> {
  const rows = await client.all<Record<string, unknown>>(
    `SELECT ps.id AS portfolio_security_id,
            ps.source_symbol AS source_symbol,
            ps.source_exchange_alias AS source_exchange_alias,
            s.primary_currency_code AS primary_currency_code,
            si.value AS sharesight_instrument_id
       FROM portfolio_securities ps
       JOIN securities s ON s.id = ps.security_id
       LEFT JOIN security_identifiers si
         ON si.security_id = ps.security_id
        AND si.scheme = 'sharesight_instrument' AND si.valid_to IS NULL
      WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.security_id IS NOT NULL`,
    [userId, portfolioId],
  );
  return rows.map((row) => ({
    portfolioSecurityId: String(row.portfolio_security_id),
    sharesightInstrumentId:
      row.sharesight_instrument_id === null
        ? null
        : String(row.sharesight_instrument_id),
    symbol: String(row.source_symbol),
    exchangeAlias:
      row.source_exchange_alias === null
        ? null
        : String(row.source_exchange_alias),
    currencyCode: String(row.primary_currency_code),
  }));
}

export function createOwnedSecurityResolutionRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
): SecurityResolutionRepository {
  // F5 (BRK-009B review): case-insensitive symbol compare, matching
  // `domain/imports/reconciliation.ts`'s own `normalized()` candidate-match
  // rule (trim + lower-case) -- a Sharesight sync's own symbol casing must
  // never fail to find a candidate row reconciliation.ts would otherwise
  // treat as the identical one.
  async function existingCandidateRow(
    userId: string,
    candidate: SecurityVerificationCandidateInput,
  ): Promise<
    { id: string; security_id: string | null; status: string } | undefined
  > {
    return client.get<{
      id: string;
      security_id: string | null;
      status: string;
    }>(
      `SELECT id, security_id, status FROM portfolio_securities
       WHERE user_id = ? AND portfolio_id = ? AND UPPER(source_symbol) = UPPER(?)
         AND COALESCE(source_exchange_alias, '') = COALESCE(?, '')
         AND source_currency_code = ?
       LIMIT 1`,
      [
        userId,
        candidate.portfolioId,
        candidate.sourceSymbol,
        candidate.sourceExchangeAlias,
        candidate.sourceCurrencyCode,
      ],
    );
  }

  async function securityCurrency(
    securityId: string,
  ): Promise<string | undefined> {
    const row = await client.get<{ primary_currency_code: string }>(
      `SELECT primary_currency_code FROM securities WHERE id = ? LIMIT 1`,
      [securityId],
    );
    return row?.primary_currency_code;
  }

  // Global (cross-owner) identifier evidence for the strict resolver's own
  // four durable/ticker tiers -- `security_identifiers` is the shared
  // canonical master, not owner-scoped (matching `security-verification.ts`/
  // `security-attestation.ts`'s existing global lookups). Every ticker row
  // this codebase writes today carries `exchange_id = NULL` (BRK-009A
  // carried finding F2), so `exchangeAlias` is always reported `null` here
  // -- there is nothing to resolve it from; that gap is exactly what the
  // same-user and global-ticker-currency fallback tiers below exist to
  // cover, both of which apply currency (and, for same-user, exchange)
  // predicates the strict resolver's own ticker tiers cannot reach.
  async function loadGlobalIdentifiers(
    identity: SecurityResolutionCandidateIdentity,
  ): Promise<SecurityIdentifierCandidateRow[]> {
    const normalizedSymbol = normalizeToken(identity.symbol);
    const rows = await client.all<Record<string, unknown>>(
      `SELECT si.security_id AS security_id, si.scheme AS scheme, si.value AS value,
              si.valid_from AS valid_from, si.valid_to AS valid_to,
              s.primary_currency_code AS primary_currency_code
       FROM security_identifiers si
       JOIN securities s ON s.id = si.security_id
       WHERE (si.scheme = 'ticker' AND UPPER(si.value) = ?)
          OR (? IS NOT NULL AND si.scheme = 'sharesight_instrument' AND si.value = ?)
          OR (? IS NOT NULL AND si.scheme = 'isin' AND si.value = ?)`,
      [
        normalizedSymbol,
        identity.sharesightInstrumentId,
        identity.sharesightInstrumentId,
        identity.isin,
        identity.isin,
      ],
    );
    return rows.map((row) => ({
      securityId: String(row.security_id),
      scheme: String(row.scheme),
      value: String(row.value),
      exchangeAlias: null,
      validFrom: String(row.valid_from),
      validTo: row.valid_to === null ? null : String(row.valid_to),
      primaryCurrencyCode: String(row.primary_currency_code),
    }));
  }

  // Same-user dedupe evidence (BRK-009A carried finding F2): securities the
  // RESOLVING OWNER has already linked (via CSV verify/attest or an earlier
  // sync) whose ticker text and canonical currency already agree with
  // `identity` -- scoped to `userId`'s own `portfolio_securities` rows only
  // (never another owner's), per
  // `domain/securities/resolve-security-candidate.ts`'s header comment.
  // Exchange evidence is assembled from BOTH `portfolio_securities.source_exchange_alias`
  // and any active `security_provider_mappings.provider_exchange` for the
  // same security, exactly as the BRK-009B ruling names.
  async function loadSameUserEvidence(
    userId: string,
    identity: SecurityResolutionCandidateIdentity,
  ): Promise<SameUserSecurityEvidenceRow[]> {
    const normalizedSymbol = normalizeToken(identity.symbol);
    const normalizedCurrency = normalizeToken(identity.currencyCode);
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ps.security_id AS security_id,
              COALESCE(ps.source_exchange_alias, spm.provider_exchange) AS exchange_alias
       FROM portfolio_securities ps
       JOIN securities s ON s.id = ps.security_id
       LEFT JOIN security_provider_mappings spm
         ON spm.security_id = ps.security_id AND spm.valid_to IS NULL
       WHERE ps.user_id = ? AND ps.security_id IS NOT NULL
         AND UPPER(ps.source_symbol) = ? AND UPPER(s.primary_currency_code) = ?`,
      [userId, normalizedSymbol, normalizedCurrency],
    );
    return rows.map((row) => ({
      securityId: String(row.security_id),
      exchangeAlias:
        row.exchange_alias === null ? null : String(row.exchange_alias),
    }));
  }

  // GLOBAL (cross-owner) ticker+currency evidence -- the third, lowest
  // priority resolution tier (B1/B3 fix). `securities`/`security_identifiers`
  // are a shared canonical master (IMP-004B precedent: two different owners
  // verifying the identical provider identity dedupe onto ONE row), so a
  // ticker+currency match belonging to ANOTHER owner is legitimate dedupe
  // evidence too -- but only ever a MATCH when no exchange evidence anywhere
  // contradicts it (`resolveGlobalTickerCurrencyCandidate` enforces this).
  // Every matched security_id is represented by at least one row even with
  // NO exchange evidence anywhere (an explicit null-evidence baseline),
  // since "no evidence" must still count as "no contradiction", never as
  // "this security doesn't exist".
  async function loadGlobalTickerCurrencyEvidence(
    symbol: string,
    currencyCode: string,
  ): Promise<SameUserSecurityEvidenceRow[]> {
    const normalizedSymbol = normalizeToken(symbol);
    const normalizedCurrency = normalizeToken(currencyCode);
    const securityRows = await client.all<Record<string, unknown>>(
      `SELECT DISTINCT si.security_id AS security_id
       FROM security_identifiers si
       JOIN securities s ON s.id = si.security_id
       WHERE si.scheme = 'ticker' AND UPPER(si.value) = ? AND si.valid_to IS NULL
         AND UPPER(s.primary_currency_code) = ?`,
      [normalizedSymbol, normalizedCurrency],
    );
    const securityIds = securityRows.map((row) => String(row.security_id));
    if (securityIds.length === 0) return [];
    const rows: SameUserSecurityEvidenceRow[] = securityIds.map((id) => ({
      securityId: id,
      exchangeAlias: null,
    }));
    const placeholders = securityIds.map(() => "?").join(", ");
    const exchangeRows = await client.all<Record<string, unknown>>(
      `SELECT security_id, provider_exchange AS exchange_alias
         FROM security_provider_mappings
        WHERE security_id IN (${placeholders}) AND valid_to IS NULL
       UNION ALL
       SELECT security_id, source_exchange_alias AS exchange_alias
         FROM portfolio_securities
        WHERE security_id IN (${placeholders}) AND source_exchange_alias IS NOT NULL`,
      [...securityIds, ...securityIds],
    );
    for (const row of exchangeRows) {
      rows.push({
        securityId: String(row.security_id),
        exchangeAlias:
          row.exchange_alias === null ? null : String(row.exchange_alias),
      });
    }
    return rows;
  }

  // Ticker+CURRENCY-scoped lookup (never ticker text alone -- B1) for a
  // security genuinely matching `symbol`/`currencyCode`, ANY source. Used
  // both to decide "does anything already satisfy this identity" before a
  // create attempt is even considered, and to determine the winner after a
  // guarded create batch (this attempt's own row, or a concurrent racer's).
  async function findTickerCurrencySecurityId(
    symbol: string,
    currencyCode: string,
  ): Promise<string | undefined> {
    const normalizedSymbol = normalizeToken(symbol);
    const normalizedCurrency = normalizeToken(currencyCode);
    const row = await client.get<{ security_id: string }>(
      `SELECT si.security_id AS security_id
       FROM security_identifiers si
       JOIN securities s ON s.id = si.security_id
       WHERE si.scheme = 'ticker' AND UPPER(si.value) = ? AND si.valid_to IS NULL
         AND UPPER(s.primary_currency_code) = ?
       LIMIT 1`,
      [normalizedSymbol, normalizedCurrency],
    );
    return row?.security_id;
  }

  // Links (or creates) the owner's `portfolio_securities` row against an
  // already-resolved `securityId` -- mirrors `security-verification.ts`'s
  // identically-named private helper exactly (see that file's header
  // comment for why each write-path repository keeps its own copy rather
  // than sharing one).
  async function linkToSecurity(
    userId: string,
    securityId: string,
    candidate: SecurityVerificationCandidateInput,
    existingRow:
      { id: string; security_id: string | null; status: string } | undefined,
  ): Promise<
    { ok: true; portfolioSecurityId: string; created: boolean } | { ok: false }
  > {
    const nowIso = now();
    if (existingRow) {
      if (existingRow.security_id === securityId) {
        return {
          ok: true,
          portfolioSecurityId: existingRow.id,
          created: false,
        };
      }
      if (existingRow.security_id !== null) {
        return { ok: false };
      }
      try {
        await client.batch([
          {
            sql: `UPDATE portfolio_securities SET security_id = ?, status = 'held', updated_at = ?
                  WHERE id = ? AND user_id = ? AND portfolio_id = ?
                    AND status = 'unresolved' AND security_id IS NULL`,
            params: [
              securityId,
              nowIso,
              existingRow.id,
              userId,
              candidate.portfolioId,
            ],
          },
        ]);
      } catch {
        // Fall through to the re-read below.
      }
      const fresh = await client.get<{ security_id: string | null }>(
        `SELECT security_id FROM portfolio_securities WHERE id = ? AND user_id = ? LIMIT 1`,
        [existingRow.id, userId],
      );
      if (fresh?.security_id === securityId) {
        return {
          ok: true,
          portfolioSecurityId: existingRow.id,
          created: false,
        };
      }
      return { ok: false };
    }

    const newId = randomUUID();
    try {
      await client.batch([
        {
          sql: `INSERT INTO portfolio_securities (
                  id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias,
                  source_currency_code, status, created_at, updated_at
                )
                SELECT ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM portfolio_securities
                  WHERE user_id = ? AND portfolio_id = ? AND UPPER(source_symbol) = UPPER(?)
                    AND COALESCE(source_exchange_alias, '') = COALESCE(?, '')
                    AND source_currency_code = ?
                )`,
          params: [
            newId,
            userId,
            candidate.portfolioId,
            securityId,
            candidate.sourceSymbol,
            candidate.sourceExchangeAlias,
            candidate.sourceCurrencyCode,
            nowIso,
            nowIso,
            userId,
            candidate.portfolioId,
            candidate.sourceSymbol,
            candidate.sourceExchangeAlias,
            candidate.sourceCurrencyCode,
          ],
        },
      ]);
    } catch {
      // Fall through to the re-read below.
    }
    const fresh = await existingCandidateRow(userId, candidate);
    if (fresh?.security_id === securityId) {
      return {
        ok: true,
        portfolioSecurityId: fresh.id,
        created: fresh.id === newId,
      };
    }
    return { ok: false };
  }

  // BRK-010: `linkToSecurity` above is keyed by (symbol, exchange, currency)
  // -- exactly right for a TRADE-class candidate, but wrong for a
  // DIVIDEND-class one resolved via the currency exemption
  // (`resolve-security.ts`'s `rowClass` doc comment): `portfolio_securities_resolved_unique`
  // permits only ONE row per (portfolio_id, security_id), so a dividend
  // group whose payout currency (e.g. USD) differs from an ALREADY-LINKED
  // trade group's own currency (e.g. AUD) for the SAME security must never
  // try to create a SECOND, differently-currencied row for that same
  // security -- it would violate the unique index. A dividend fact's own
  // cash currency lives on `dividend_manual_records` (this repository's
  // caller stores it there), never on `portfolio_securities.source_currency_code`,
  // so reusing whatever row already exists for this security -- regardless
  // of ITS OWN currency -- is exactly correct, not a loss of information.
  // Only when this security has NO `portfolio_securities` row in this
  // portfolio at all yet (a brand-new holding whose only evidence so far is
  // a dividend) does this fall through to the normal, currency-keyed
  // create/link path, which then creates a row in the dividend's own
  // currency (the only evidence available in that degenerate case).
  async function linkResolvedSecurity(
    userId: string,
    securityId: string,
    identity: SecurityResolutionCandidateIdentity,
    candidate: SecurityVerificationCandidateInput,
    existingRow:
      { id: string; security_id: string | null; status: string } | undefined,
  ): Promise<
    { ok: true; portfolioSecurityId: string; created: boolean } | { ok: false }
  > {
    if (identity.rowClass === "dividend") {
      const existingForSecurity = await client.get<{ id: string }>(
        `SELECT id FROM portfolio_securities
         WHERE user_id = ? AND portfolio_id = ? AND security_id = ? LIMIT 1`,
        [userId, candidate.portfolioId, securityId],
      );
      if (existingForSecurity) {
        return {
          ok: true,
          portfolioSecurityId: existingForSecurity.id,
          created: false,
        };
      }
    }
    return linkToSecurity(userId, securityId, candidate, existingRow);
  }

  async function createAndLink(
    userId: string,
    identity: SecurityResolutionCandidateIdentity,
    candidate: SecurityVerificationCandidateInput,
    existingRow:
      { id: string; security_id: string | null; status: string } | undefined,
  ): Promise<SecurityResolutionLinkResult> {
    const normalizedSymbol = normalizeToken(identity.symbol);
    const normalizedCurrency = normalizeToken(identity.currencyCode);
    const currencyRow = await client.get<{ code: string }>(
      `SELECT code FROM currencies WHERE code = ? LIMIT 1`,
      [normalizedCurrency],
    );
    if (!currencyRow) return { ok: false, reason: "invalid_currency" };

    const alreadyResolvedElsewhere =
      existingRow !== undefined && existingRow.security_id !== null;

    const securityId = randomUUID();
    const tickerIdentifierId = randomUUID();
    const instrumentIdentifierId = randomUUID();
    const linkId = randomUUID();
    const nowIso = now();
    const today = nowIso.slice(0, 10);
    const canonicalName = sanitizeCanonicalName(
      identity.instrumentName ?? identity.symbol,
    );
    const sharesightInstrumentId = identity.sharesightInstrumentId;

    // Creation-only guard, scoped to ticker+CURRENCY (B3 fix -- a bare
    // ticker-text guard would permanently block a legitimately
    // distinct-currency security from ever being created) -- reused
    // identically across the securities insert, the ticker identifier
    // insert, and the winner-resolution/link statements below, so every
    // decision this function makes shares exactly one identity predicate.
    const tickerCurrencyGuard = `NOT EXISTS (
                SELECT 1 FROM security_identifiers tcg
                JOIN securities tcgs ON tcgs.id = tcg.security_id
                WHERE tcg.scheme = 'ticker' AND UPPER(tcg.value) = ? AND tcg.valid_to IS NULL
                  AND UPPER(tcgs.primary_currency_code) = ?
              )`;
    // When Sharesight supplied an instrument id, ALSO guard on the
    // `sharesight_instrument` value-space -- the 0039 migration's real
    // unique index, giving hard atomic convergence for that identity
    // (unchanged from before this review round).
    const instrumentGuard = sharesightInstrumentId
      ? `AND NOT EXISTS (SELECT 1 FROM security_identifiers WHERE scheme = 'sharesight_instrument' AND value = ? AND valid_to IS NULL)`
      : "";

    const securitiesParams: unknown[] = [
      securityId,
      normalizedCurrency,
      canonicalName,
      nowIso,
      nowIso,
      normalizedSymbol,
      normalizedCurrency,
    ];
    if (sharesightInstrumentId) securitiesParams.push(sharesightInstrumentId);

    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO securities (
                id, asset_type, exchange_id, primary_currency_code, canonical_name,
                isin, status, first_trade_date, last_trade_date, created_at, updated_at
              )
              SELECT ?, 'equity', NULL, ?, ?, NULL, 'active', NULL, NULL, ?, ?
              WHERE ${tickerCurrencyGuard}
              ${instrumentGuard}`,
        params: securitiesParams,
      },
      {
        sql: `INSERT INTO security_identifiers (
                id, security_id, scheme, value, exchange_id, valid_from, valid_to, source
              )
              SELECT ?, ?, 'ticker', ?, NULL, ?, NULL, 'sharesight'
              WHERE EXISTS (SELECT 1 FROM securities WHERE id = ?)
                AND ${tickerCurrencyGuard}`,
        params: [
          tickerIdentifierId,
          securityId,
          normalizedSymbol,
          today,
          securityId,
          normalizedSymbol,
          normalizedCurrency,
        ],
      },
    ];
    if (sharesightInstrumentId) {
      statements.push({
        sql: `INSERT INTO security_identifiers (
                id, security_id, scheme, value, exchange_id, valid_from, valid_to, source
              )
              SELECT ?, ?, 'sharesight_instrument', ?, NULL, ?, NULL, 'sharesight'
              WHERE EXISTS (SELECT 1 FROM securities WHERE id = ?)
                AND NOT EXISTS (
                  SELECT 1 FROM security_identifiers
                  WHERE scheme = 'sharesight_instrument' AND value = ? AND valid_to IS NULL
                )`,
        params: [
          instrumentIdentifierId,
          securityId,
          sharesightInstrumentId,
          today,
          securityId,
          sharesightInstrumentId,
        ],
      });
    }

    // Fold the owner's `portfolio_securities` link into this SAME batch,
    // resolved via a live subquery (not the literal `securityId` generated
    // above) so linking is correct even when a concurrent creation's row --
    // not this attempt's -- is the one still standing once this statement
    // runs. Scoped to ticker+CURRENCY throughout (B1/B2 fix): the subquery
    // and its guard share the EXACT SAME predicate as the creation guards
    // above, so this statement can never resolve to (and therefore can
    // never persist a link to) a currency-mismatched pre-existing security
    // -- if nothing satisfies that predicate, the guard is false and NOTHING
    // persists (B2's "if the winner fails validation, nothing persists").
    const winnerSubquery = `(SELECT wsq.security_id FROM security_identifiers wsq
           JOIN securities wsqs ON wsqs.id = wsq.security_id
           WHERE wsq.scheme = 'ticker' AND UPPER(wsq.value) = ? AND wsq.valid_to IS NULL
             AND UPPER(wsqs.primary_currency_code) = ? LIMIT 1)`;
    const winnerGuardExists = `EXISTS (SELECT 1 FROM security_identifiers wge
           JOIN securities wges ON wges.id = wge.security_id
           WHERE wge.scheme = 'ticker' AND UPPER(wge.value) = ? AND wge.valid_to IS NULL
             AND UPPER(wges.primary_currency_code) = ?)`;

    if (!alreadyResolvedElsewhere) {
      statements.push(
        existingRow
          ? {
              sql: `UPDATE portfolio_securities
                    SET security_id = ${winnerSubquery},
                        status = 'held', updated_at = ?
                    WHERE id = ? AND user_id = ? AND portfolio_id = ?
                      AND status = 'unresolved' AND security_id IS NULL
                      AND ${winnerGuardExists}`,
              params: [
                normalizedSymbol,
                normalizedCurrency,
                nowIso,
                existingRow.id,
                userId,
                candidate.portfolioId,
                normalizedSymbol,
                normalizedCurrency,
              ],
            }
          : {
              sql: `INSERT INTO portfolio_securities (
                      id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias,
                      source_currency_code, status, created_at, updated_at
                    )
                    SELECT ?, ?, ?, ${winnerSubquery}, ?, ?, ?, 'held', ?, ?
                    WHERE ${winnerGuardExists}
                      AND NOT EXISTS (
                            SELECT 1 FROM portfolio_securities
                            WHERE user_id = ? AND portfolio_id = ? AND UPPER(source_symbol) = UPPER(?)
                              AND COALESCE(source_exchange_alias, '') = COALESCE(?, '')
                              AND source_currency_code = ?
                          )`,
              params: [
                linkId,
                userId,
                candidate.portfolioId,
                normalizedSymbol,
                normalizedCurrency,
                candidate.sourceSymbol,
                candidate.sourceExchangeAlias,
                candidate.sourceCurrencyCode,
                nowIso,
                nowIso,
                normalizedSymbol,
                normalizedCurrency,
                userId,
                candidate.portfolioId,
                candidate.sourceSymbol,
                candidate.sourceExchangeAlias,
                candidate.sourceCurrencyCode,
              ],
            },
      );
    }

    try {
      // Everything -- the canonical rows plus the owner's link -- runs in
      // one atomic `batch()` call, mirroring `security-attestation.ts`'s and
      // `security-verification.ts`'s identical creation-only technique (see
      // either file's header comment for the full atomicity discussion).
      await client.batch(statements);
    } catch {
      // Fall through to the unconditional re-read below.
    }

    const winner = await findTickerCurrencySecurityId(
      identity.symbol,
      identity.currencyCode,
    );
    if (!winner) return { ok: false, reason: "link_conflict" };

    const linked = alreadyResolvedElsewhere
      ? await linkToSecurity(userId, winner, candidate, existingRow)
      : existingRow
        ? await (async () => {
            const fresh = await client.get<{ security_id: string | null }>(
              `SELECT security_id FROM portfolio_securities WHERE id = ? AND user_id = ? LIMIT 1`,
              [existingRow.id, userId],
            );
            return fresh?.security_id === winner
              ? {
                  ok: true as const,
                  portfolioSecurityId: existingRow.id,
                  created: false,
                }
              : { ok: false as const };
          })()
        : await (async () => {
            const fresh = await existingCandidateRow(userId, candidate);
            return fresh?.security_id === winner
              ? {
                  ok: true as const,
                  portfolioSecurityId: fresh.id,
                  created: fresh.id === linkId,
                }
              : { ok: false as const };
          })();

    if (!linked.ok) return { ok: false, reason: "link_conflict" };
    return {
      ok: true,
      outcome: winner === securityId ? "created" : "matched",
      securityId: winner,
      portfolioSecurityId: linked.portfolioSecurityId,
      tier: winner === securityId ? null : GLOBAL_TICKER_CURRENCY_TIER,
      created: winner === securityId,
    };
  }

  return {
    async resolveAndLink(userId, identity, candidate) {
      const existingRow = await existingCandidateRow(userId, candidate);
      if (existingRow?.security_id) {
        // B2: re-validate a PRE-EXISTING link's currency agreement before
        // trusting it -- never silently launder a bad prior link (e.g. one
        // a pre-fix version of this repository created) into a committed
        // batch. This never happens for a link genuinely created by the
        // current logic (which always validates currency before linking),
        // only for data this repository did not itself just write.
        const linkedCurrency = await securityCurrency(existingRow.security_id);
        if (
          // BRK-010: this re-validation exists to catch a genuinely bad
          // PRE-EXISTING link (B2, see this function's header comment) --
          // for a dividend-class candidate a currency "mismatch" against the
          // linked security is the EXPECTED, legitimate shape (a foreign-
          // currency payout linked to a security that trades in a different
          // currency), never evidence of a bad link, so the check is skipped
          // exactly like the strict resolver's own exemption below.
          identity.rowClass !== "dividend" &&
          linkedCurrency !== undefined &&
          normalizeToken(linkedCurrency) !==
            normalizeToken(identity.currencyCode)
        ) {
          return {
            ok: false,
            reason: "conflict",
            tiers: [EXISTING_LINK_CURRENCY_MISMATCH_TIER],
            securityIds: [existingRow.security_id],
          };
        }
        return {
          ok: true,
          outcome: "already_resolved",
          securityId: existingRow.security_id,
          portfolioSecurityId: existingRow.id,
          tier: null,
          created: false,
        };
      }

      const [globalIdentifiers, sameUserEvidence] = await Promise.all([
        loadGlobalIdentifiers(identity),
        loadSameUserEvidence(userId, identity),
      ]);
      const stage1 = resolveSecurityCandidate(
        {
          symbol: identity.symbol,
          exchangeAlias: identity.exchangeAlias,
          currencyCode: identity.currencyCode,
          sharesightInstrumentId: identity.sharesightInstrumentId,
          isin: identity.isin,
          rowClass: identity.rowClass,
        },
        globalIdentifiers,
        sameUserEvidence,
      );

      if (stage1.outcome === "conflict") {
        return {
          ok: false,
          reason: "conflict",
          tiers: stage1.tiers,
          securityIds: stage1.securityIds,
        };
      }

      if (stage1.outcome === "matched") {
        const linked = await linkResolvedSecurity(
          userId,
          stage1.securityId,
          identity,
          candidate,
          existingRow,
        );
        if (!linked.ok) return { ok: false, reason: "link_conflict" };
        return {
          ok: true,
          outcome: "matched",
          securityId: stage1.securityId,
          portfolioSecurityId: linked.portfolioSecurityId,
          tier: stage1.tier,
          created: false,
        };
      }

      // Stage 1 (strict resolver + same-user fallback) found nothing --
      // try the THIRD, lowest-priority tier: a genuinely agreeing
      // cross-owner ticker+currency match (B1/B4 ruling: shared canonical
      // securities may legitimately dedupe cross-user, but ONLY with
      // agreeing identity -- never a silent currency-blind merge).
      const globalEvidence = await loadGlobalTickerCurrencyEvidence(
        identity.symbol,
        identity.currencyCode,
      );
      const stage2 = resolveGlobalTickerCurrencyCandidate(
        identity.exchangeAlias,
        globalEvidence,
      );
      if (stage2.outcome === "conflict") {
        return {
          ok: false,
          reason: "conflict",
          tiers: stage2.tiers,
          securityIds: stage2.securityIds,
        };
      }
      if (stage2.outcome === "matched") {
        const linked = await linkResolvedSecurity(
          userId,
          stage2.securityId,
          identity,
          candidate,
          existingRow,
        );
        if (!linked.ok) return { ok: false, reason: "link_conflict" };
        return {
          ok: true,
          outcome: "matched",
          securityId: stage2.securityId,
          portfolioSecurityId: linked.portfolioSecurityId,
          tier: stage2.tier,
          created: false,
        };
      }

      // Genuinely no match anywhere -- create.
      return createAndLink(userId, identity, candidate, existingRow);
    },
  };
}
