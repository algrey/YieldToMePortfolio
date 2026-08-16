import { randomUUID } from "node:crypto";
import { normalizeToken } from "../../domain/securities/verify-identity.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import type {
  SecurityVerificationCandidateInput,
  SecurityVerificationLinkResult,
} from "./security-verification.ts";

// IMP-009: an owner-attested identity -- symbol/currency the owner confirms
// directly, with a display name they supply/confirm (default: the symbol) --
// used when the market-data provider is unavailable (rate-limited, outage)
// or cannot ever verify a delisted ticker, yet the owner's real dividend/
// transaction history for it must still be recorded (Orchestrator ruling,
// TASKS.md). Asset type always defaults to `equity` per that ruling; there is
// no provider evidence to infer `etf`/`fund` from. Deliberately has no
// `exchangeAlias`/`providerExchange` field: attestation carries no exchange
// evidence at all (see the header comment on
// `security_identifiers_owner_attested_ticker_unique` in `db/schema.ts` for
// the accepted ambiguity this implies).
export type SecurityAttestationIdentity = {
  symbol: string;
  currencyCode: string;
  displayName: string;
};

export type SecurityAttestationRepository = {
  /**
   * Publishes a `securities` row (plus a `security_identifiers` row carrying
   * `source = 'owner_attested'`) for `identity` if, and only if, no active
   * identifier already exists for that ticker text under EITHER namespace
   * (owner-attested or provider-verified) -- creation-only against the
   * shared master, mirroring `createOwnedSecurityVerificationRepository`'s
   * `publishAndLink` -- then links the owner's private `portfolio_securities`
   * candidate. Deliberately NEVER writes a `security_provider_mappings`
   * row: that table is provider evidence only (AGENTS.md/TASKS.md
   * provenance-honesty ruling), so an attested security is queryable as
   * "not yet provider-verified" by the simple absence of an active verified
   * mapping for its `security_id` (see `listAttestedSecurityIds` below).
   *
   * When an existing identifier already resolves this ticker text -- either
   * a prior attestation (converge on the same row) or an existing
   * PROVIDER-VERIFIED security (link to it rather than ever duplicating it,
   * per the Orchestrator ruling) -- this links to that security instead of
   * creating a new one, after re-checking currency agreement; a currency
   * disagreement is an explicit `currency_mismatch` failure, never a silent
   * link.
   */
  attestAndLink(
    userId: string,
    identity: SecurityAttestationIdentity,
    candidate: SecurityVerificationCandidateInput,
  ): Promise<SecurityVerificationLinkResult>;
};

// IMP-009: the queryable "owner-attested, not yet provider-verified" signal
// this task's provenance-honesty ruling calls for -- no new column, just an
// absence-of-mapping check joined against the `source = 'owner_attested'`
// identifier this repository writes. A security that started attested and
// was later upgraded by a provider verify (see
// `security-verification.ts`'s attested-identifier lookup) now has an
// active verified mapping, so it correctly drops out of this set without
// this repository or the identifier row ever being touched again.
export async function listAttestedSecurityIds(
  client: SqlClient,
  securityIds: readonly string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(securityIds)];
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = await client.all<{ security_id: string }>(
    `SELECT DISTINCT si.security_id AS security_id
       FROM security_identifiers si
      WHERE si.source = 'owner_attested' AND si.valid_to IS NULL
        AND si.security_id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM security_provider_mappings spm
           WHERE spm.security_id = si.security_id
             AND spm.valid_to IS NULL AND spm.status = 'verified'
        )`,
    uniqueIds,
  );
  return rows.map((row) => row.security_id);
}

export function createOwnedSecurityAttestationRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
): SecurityAttestationRepository {
  // Duplicated from `security-verification.ts`'s identically-named private
  // helpers rather than shared, matching this codebase's established
  // `loadReview`-duplication precedent (see that file's header comment):
  // each write-path repository stays a fully self-contained module.
  async function securityCurrency(
    securityId: string,
  ): Promise<string | undefined> {
    const row = await client.get<{ primary_currency_code: string }>(
      `SELECT primary_currency_code FROM securities WHERE id = ? LIMIT 1`,
      [securityId],
    );
    return row?.primary_currency_code;
  }

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
       WHERE user_id = ? AND portfolio_id = ? AND source_symbol = ?
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

  async function linkToSecurity(
    userId: string,
    securityId: string,
    candidate: SecurityVerificationCandidateInput,
    existingRow:
      { id: string; security_id: string | null; status: string } | undefined,
  ): Promise<SecurityVerificationLinkResult> {
    const nowIso = now();
    if (existingRow) {
      if (existingRow.security_id === securityId) {
        return {
          ok: true,
          securityId,
          portfolioSecurityId: existingRow.id,
          created: false,
        };
      }
      if (existingRow.security_id !== null) {
        return { ok: false, reason: "conflict" };
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
          securityId,
          portfolioSecurityId: existingRow.id,
          created: false,
        };
      }
      return { ok: false, reason: "conflict" };
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
                  WHERE user_id = ? AND portfolio_id = ? AND source_symbol = ?
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
        securityId,
        portfolioSecurityId: fresh.id,
        created: fresh.id === newId,
      };
    }
    return { ok: false, reason: "conflict" };
  }

  // Pure re-read + compare, no writes -- mirrors
  // `security-verification.ts`'s identically-named/-shaped helper, reused
  // here by the creation path's post-batch resolution.
  async function readLinkOutcome(
    userId: string,
    securityId: string,
    candidate: SecurityVerificationCandidateInput,
    options: { knownRowId?: string; insertedId?: string },
  ): Promise<SecurityVerificationLinkResult> {
    if (options.knownRowId) {
      const fresh = await client.get<{ security_id: string | null }>(
        `SELECT security_id FROM portfolio_securities WHERE id = ? AND user_id = ? LIMIT 1`,
        [options.knownRowId, userId],
      );
      if (fresh?.security_id === securityId) {
        return {
          ok: true,
          securityId,
          portfolioSecurityId: options.knownRowId,
          created: false,
        };
      }
      return { ok: false, reason: "conflict" };
    }
    const fresh = await existingCandidateRow(userId, candidate);
    if (fresh?.security_id === securityId) {
      return {
        ok: true,
        securityId,
        portfolioSecurityId: fresh.id,
        created: fresh.id === options.insertedId,
      };
    }
    return { ok: false, reason: "conflict" };
  }

  async function activeIdentifierSecurityId(
    normalizedSymbol: string,
    sourceFilter: "owner_attested" | "not_owner_attested",
  ): Promise<{ security_id: string } | undefined> {
    return client.get<{ security_id: string }>(
      `SELECT security_id FROM security_identifiers
       WHERE scheme = 'ticker' AND UPPER(value) = ? AND valid_to IS NULL
         AND source ${sourceFilter === "owner_attested" ? "=" : "<>"} 'owner_attested'
       LIMIT 1`,
      [normalizedSymbol],
    );
  }

  return {
    async attestAndLink(userId, identity, candidate) {
      const normalizedSymbol = normalizeToken(identity.symbol);
      const existingRow = await existingCandidateRow(userId, candidate);

      // 1. A prior attestation of the exact same ticker text -- converge on
      // it (this is the concurrent-attest race's resolution target).
      const existingAttested = await activeIdentifierSecurityId(
        normalizedSymbol,
        "owner_attested",
      );
      if (existingAttested) {
        const currency = await securityCurrency(existingAttested.security_id);
        if (currency !== identity.currencyCode) {
          return { ok: false, reason: "currency_mismatch" };
        }
        return linkToSecurity(
          userId,
          existingAttested.security_id,
          candidate,
          existingRow,
        );
      }

      // 2. A provider-verified security already publishes this exact
      // ticker text -- link to it rather than ever creating a duplicate
      // (Orchestrator ruling). This never writes a provider mapping; the
      // security is already genuinely provider-verified.
      const existingProviderVerified = await activeIdentifierSecurityId(
        normalizedSymbol,
        "not_owner_attested",
      );
      if (existingProviderVerified) {
        const currency = await securityCurrency(
          existingProviderVerified.security_id,
        );
        if (currency !== identity.currencyCode) {
          return { ok: false, reason: "currency_mismatch" };
        }
        return linkToSecurity(
          userId,
          existingProviderVerified.security_id,
          candidate,
          existingRow,
        );
      }

      // When the owner's candidate is already resolved to a DIFFERENT
      // security, nothing this attempt can link regardless of who wins the
      // publish race below.
      const alreadyResolvedElsewhere =
        existingRow !== undefined && existingRow.security_id !== null;

      const securityId = randomUUID();
      const identifierId = randomUUID();
      const linkId = randomUUID();
      const nowIso = now();
      const today = nowIso.slice(0, 10);

      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO securities (
                  id, asset_type, exchange_id, primary_currency_code, canonical_name,
                  isin, status, first_trade_date, last_trade_date, created_at, updated_at
                )
                SELECT ?, 'equity', NULL, ?, ?, NULL, 'active', NULL, NULL, ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM security_identifiers
                  WHERE scheme = 'ticker' AND UPPER(value) = ? AND valid_to IS NULL
                )`,
          params: [
            securityId,
            identity.currencyCode,
            identity.displayName,
            nowIso,
            nowIso,
            normalizedSymbol,
          ],
        },
        {
          sql: `INSERT INTO security_identifiers (
                  id, security_id, scheme, value, exchange_id, valid_from, valid_to, source
                )
                SELECT ?, ?, 'ticker', ?, NULL, ?, NULL, 'owner_attested'
                WHERE EXISTS (SELECT 1 FROM securities WHERE id = ?)
                  AND NOT EXISTS (
                    SELECT 1 FROM security_identifiers
                    WHERE scheme = 'ticker' AND UPPER(value) = ? AND valid_to IS NULL
                  )`,
          params: [
            identifierId,
            securityId,
            normalizedSymbol,
            today,
            securityId,
            normalizedSymbol,
          ],
        },
      ];

      // Fold the owner's `portfolio_securities` link into this SAME batch,
      // resolving `security_id` from a live subquery against
      // `security_identifiers` (not the literal `securityId` generated
      // above) so linking is correct even when a concurrent attestation's
      // row -- not this attempt's -- is the one still standing once this
      // statement runs. Mirrors `security-verification.ts`'s identical
      // technique (see that file and `docs/DATA_MODEL.md` §11 for the full
      // guard-conditional atomicity discussion).
      if (!alreadyResolvedElsewhere) {
        statements.push(
          existingRow
            ? {
                sql: `UPDATE portfolio_securities
                      SET security_id = (
                            SELECT security_id FROM security_identifiers
                            WHERE scheme = 'ticker' AND UPPER(value) = ? AND valid_to IS NULL
                            LIMIT 1
                          ),
                          status = 'held', updated_at = ?
                      WHERE id = ? AND user_id = ? AND portfolio_id = ?
                        AND status = 'unresolved' AND security_id IS NULL
                        AND EXISTS (
                          SELECT 1 FROM security_identifiers
                          WHERE scheme = 'ticker' AND UPPER(value) = ? AND valid_to IS NULL
                        )`,
                params: [
                  normalizedSymbol,
                  nowIso,
                  existingRow.id,
                  userId,
                  candidate.portfolioId,
                  normalizedSymbol,
                ],
              }
            : {
                sql: `INSERT INTO portfolio_securities (
                        id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias,
                        source_currency_code, status, created_at, updated_at
                      )
                      SELECT ?, ?, ?,
                             (SELECT security_id FROM security_identifiers
                               WHERE scheme = 'ticker' AND UPPER(value) = ? AND valid_to IS NULL
                               LIMIT 1),
                             ?, ?, ?, 'held', ?, ?
                      WHERE EXISTS (
                              SELECT 1 FROM security_identifiers
                              WHERE scheme = 'ticker' AND UPPER(value) = ? AND valid_to IS NULL
                            )
                        AND NOT EXISTS (
                              SELECT 1 FROM portfolio_securities
                              WHERE user_id = ? AND portfolio_id = ? AND source_symbol = ?
                                AND COALESCE(source_exchange_alias, '') = COALESCE(?, '')
                                AND source_currency_code = ?
                            )`,
                params: [
                  linkId,
                  userId,
                  candidate.portfolioId,
                  normalizedSymbol,
                  candidate.sourceSymbol,
                  candidate.sourceExchangeAlias,
                  candidate.sourceCurrencyCode,
                  nowIso,
                  nowIso,
                  normalizedSymbol,
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
        // Creation-only: both canonical inserts are guarded on no active
        // identifier existing yet for this ticker text (either namespace),
        // and everything -- the canonical rows plus the owner's link --
        // runs in one atomic `batch()` call. A concurrent attestation of
        // the same ticker text either loses this race outright (its own
        // batch throws on `security_identifiers_owner_attested_ticker_unique`,
        // rolling this whole attempt back) or -- if it committed first --
        // makes the `WHERE NOT EXISTS` guards on the canonical inserts
        // no-op while the link statement's live subquery still fires,
        // linking straight to the concurrent winner within this same call.
        await client.batch(statements);
      } catch {
        // Fall through to the unconditional re-read below.
      }

      const winner =
        (await activeIdentifierSecurityId(
          normalizedSymbol,
          "owner_attested",
        )) ??
        (await activeIdentifierSecurityId(
          normalizedSymbol,
          "not_owner_attested",
        ));
      if (!winner) return { ok: false, reason: "conflict" };
      if (alreadyResolvedElsewhere) {
        return linkToSecurity(
          userId,
          winner.security_id,
          candidate,
          existingRow,
        );
      }
      return readLinkOutcome(userId, winner.security_id, candidate, {
        knownRowId: existingRow?.id,
        insertedId: existingRow ? undefined : linkId,
      });
    },
  };
}
