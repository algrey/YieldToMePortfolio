import { randomUUID } from "node:crypto";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import {
  normalizeToken,
  type VerifiedSecurityIdentity,
} from "../../domain/securities/verify-identity.ts";

export type SecurityVerificationCandidateInput = {
  portfolioId: string;
  sourceSymbol: string;
  sourceExchangeAlias: string | null;
  sourceCurrencyCode: string;
};

export type SecurityVerificationLinkResult =
  | {
      ok: true;
      securityId: string;
      portfolioSecurityId: string;
      created: boolean;
    }
  | { ok: false; reason: "conflict" | "currency_mismatch" };

export type SecurityPublishOnlyResult =
  | { ok: true; securityId: string; created: boolean }
  | { ok: false; reason: "conflict" | "currency_mismatch" };

export type SecurityVerificationRepository = {
  /**
   * Publishes the canonical `securities` row (plus `security_identifiers`
   * and a `verified` `security_provider_mappings` row) for `identity` if,
   * and only if, no mapping already exists for that provider identity --
   * creation-only against the shared master, per IMP-004B's decision
   * constraints -- then links the owner's private `portfolio_securities`
   * candidate (creating it if this symbol/exchange/currency combination has
   * never been staged before, or resolving it in place if it has).
   */
  publishAndLink(
    userId: string,
    providerId: string,
    identity: VerifiedSecurityIdentity,
    candidate: SecurityVerificationCandidateInput,
  ): Promise<SecurityVerificationLinkResult>;
  /**
   * WLT-001: the same creation-only shared-master resolution `publishAndLink`
   * performs (dedupe against an existing provider mapping, then an
   * owner-attested ticker, then a fresh publish -- never a second `securities`
   * row for an identity that already resolves), WITHOUT touching
   * `portfolio_securities` at all. Adding a security to the watchlist records
   * INTEREST only, never a position, so there is no portfolio candidate row
   * to link here -- this method resolves/publishes the canonical
   * `securities`/`security_provider_mappings` rows and returns the resolved
   * `securityId` directly.
   */
  publishOnly(
    userId: string,
    providerId: string,
    identity: VerifiedSecurityIdentity,
  ): Promise<SecurityPublishOnlyResult>;
};

export function createOwnedSecurityVerificationRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
): SecurityVerificationRepository {
  async function existingMapping(
    providerId: string,
    providerExchange: string,
    providerSymbol: string,
  ): Promise<{ security_id: string } | undefined> {
    return client.get<{ security_id: string }>(
      `SELECT security_id FROM security_provider_mappings
       WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
         AND valid_to IS NULL
       ORDER BY valid_from DESC LIMIT 1`,
      [providerId, providerExchange, providerSymbol],
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

  // IMP-009 upgrade path: is `providerSymbol` (this verify request's OWN
  // provider identity, case-folded the same way `security-attestation.ts`
  // stores it) already published as an owner-ATTESTED security -- one with
  // no provider mapping yet, per `db/schema.ts`'s
  // `security_identifiers_owner_attested_ticker_unique`? If so, this verify
  // must ATTACH its mapping evidence to that SAME `securities` row instead
  // of creating a duplicate for what is, by ticker text, the identical
  // identity. Never touches `security_identifiers` itself -- the attested
  // row stays exactly as the owner recorded it, and once a mapping is
  // attached the row naturally stops being reported by
  // `listAttestedSecurityIds` (no mapping-less identity left to find).
  async function existingAttestedIdentifier(
    providerSymbol: string,
  ): Promise<{ security_id: string } | undefined> {
    return client.get<{ security_id: string }>(
      `SELECT security_id FROM security_identifiers
       WHERE scheme = 'ticker' AND UPPER(value) = ? AND valid_to IS NULL
         AND source = 'owner_attested'
       LIMIT 1`,
      [normalizeToken(providerSymbol)],
    );
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

  // Links (or creates) the owner's `portfolio_securities` row against an
  // already-resolved `securityId` -- the canonical row either pre-existed
  // (dedupe path) or was just published in the same request. Every write
  // here is guarded and, after any no-op/failure, the row is re-read so a
  // concurrent winner (another verify request, or another row in this same
  // batch resolving to the same identity) is treated as success rather than
  // a spurious conflict.
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
        // Already resolved to a different security -- never overwrite.
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
        // Fall through to the re-read below (e.g. `portfolio_securities_resolved_unique`).
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
      // Fall through to the re-read below (e.g. `portfolio_securities_resolved_unique`
      // if this exact security is already linked under a different source symbol).
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

  // Pure re-read + compare, no writes -- the tail half of `linkToSecurity`'s
  // own two branches, factored out so `publishAndLink`'s creation path can
  // reuse it after a link statement it folded directly into the canonical
  // publish `batch()` (see the comment on that batch below), instead of
  // re-attempting the write itself.
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

  return {
    async publishAndLink(userId, providerId, identity, candidate) {
      const providerExchange = identity.providerExchange ?? "";
      const providerSymbol = identity.providerSymbol;
      const existingRow = await existingCandidateRow(userId, candidate);

      const existing = await existingMapping(
        providerId,
        providerExchange,
        providerSymbol,
      );
      if (existing) {
        // Dedupe-link currency agreement: the lookup above keys only on
        // (provider_id, provider_exchange, provider_symbol), so it says
        // nothing about currency. Require the canonical security's currency
        // to still agree with this freshly-verified identity's currency --
        // never link a private candidate to a shared security whose
        // currency the current verification evidence disagrees with.
        const currency = await securityCurrency(existing.security_id);
        if (currency !== identity.currencyCode) {
          return { ok: false, reason: "currency_mismatch" };
        }
        return linkToSecurity(
          userId,
          existing.security_id,
          candidate,
          existingRow,
        );
      }

      // When the owner's candidate is already resolved to a DIFFERENT
      // security, there is nothing this attempt can link regardless of who
      // wins the publish race below -- `linkToSecurity`'s existing-row
      // branch settles that with reads only, no write, so it is safe to
      // fold no link statement into the batch and resolve it afterward.
      const alreadyResolvedElsewhere =
        existingRow !== undefined && existingRow.security_id !== null;

      // IMP-009 upgrade path: no provider mapping exists for this identity
      // yet, but an owner-attested security already publishes the exact
      // same ticker text -- attach this verify's mapping evidence to that
      // SAME `securities` row rather than creating a duplicate. On a
      // currency disagreement this fails explicitly (never silently
      // rewrites the attested identity), matching the dedupe-link currency
      // check above.
      const attested = await existingAttestedIdentifier(providerSymbol);
      if (attested) {
        const currency = await securityCurrency(attested.security_id);
        if (currency !== identity.currencyCode) {
          return { ok: false, reason: "currency_mismatch" };
        }
        const attachMappingId = randomUUID();
        const attachLinkId = randomUUID();
        const attachNowIso = now();
        const attachToday = attachNowIso.slice(0, 10);
        const attachStatements: SqlStatement[] = [
          {
            sql: `INSERT INTO security_provider_mappings (
                    id, security_id, provider_id, provider_exchange, provider_symbol,
                    valid_from, valid_to, status, verified_by_user_id, verified_at
                  )
                  SELECT ?, ?, ?, ?, ?, ?, NULL, 'verified', ?, ?
                  WHERE NOT EXISTS (
                    SELECT 1 FROM security_provider_mappings
                    WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                  )`,
            params: [
              attachMappingId,
              attested.security_id,
              providerId,
              providerExchange,
              providerSymbol,
              attachToday,
              userId,
              attachNowIso,
              providerId,
              providerExchange,
              providerSymbol,
            ],
          },
        ];
        if (!alreadyResolvedElsewhere) {
          attachStatements.push(
            existingRow
              ? {
                  sql: `UPDATE portfolio_securities
                        SET security_id = (
                              SELECT security_id FROM security_provider_mappings
                              WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                                AND valid_to IS NULL
                              ORDER BY valid_from DESC LIMIT 1
                            ),
                            status = 'held', updated_at = ?
                        WHERE id = ? AND user_id = ? AND portfolio_id = ?
                          AND status = 'unresolved' AND security_id IS NULL
                          AND EXISTS (
                            SELECT 1 FROM security_provider_mappings
                            WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                              AND valid_to IS NULL
                          )`,
                  params: [
                    providerId,
                    providerExchange,
                    providerSymbol,
                    attachNowIso,
                    existingRow.id,
                    userId,
                    candidate.portfolioId,
                    providerId,
                    providerExchange,
                    providerSymbol,
                  ],
                }
              : {
                  sql: `INSERT INTO portfolio_securities (
                          id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias,
                          source_currency_code, status, created_at, updated_at
                        )
                        SELECT ?, ?, ?,
                               (SELECT security_id FROM security_provider_mappings
                                 WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                                   AND valid_to IS NULL
                                 ORDER BY valid_from DESC LIMIT 1),
                               ?, ?, ?, 'held', ?, ?
                        WHERE EXISTS (
                                SELECT 1 FROM security_provider_mappings
                                WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                                  AND valid_to IS NULL
                              )
                          AND NOT EXISTS (
                                SELECT 1 FROM portfolio_securities
                                WHERE user_id = ? AND portfolio_id = ? AND source_symbol = ?
                                  AND COALESCE(source_exchange_alias, '') = COALESCE(?, '')
                                  AND source_currency_code = ?
                              )`,
                  params: [
                    attachLinkId,
                    userId,
                    candidate.portfolioId,
                    providerId,
                    providerExchange,
                    providerSymbol,
                    candidate.sourceSymbol,
                    candidate.sourceExchangeAlias,
                    candidate.sourceCurrencyCode,
                    attachNowIso,
                    attachNowIso,
                    providerId,
                    providerExchange,
                    providerSymbol,
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
          await client.batch(attachStatements);
        } catch {
          // Fall through to the unconditional re-read below.
        }
        const attachWinner = await existingMapping(
          providerId,
          providerExchange,
          providerSymbol,
        );
        if (!attachWinner) return { ok: false, reason: "conflict" };
        if (alreadyResolvedElsewhere) {
          return linkToSecurity(
            userId,
            attachWinner.security_id,
            candidate,
            existingRow,
          );
        }
        return readLinkOutcome(userId, attachWinner.security_id, candidate, {
          knownRowId: existingRow?.id,
          insertedId: existingRow ? undefined : attachLinkId,
        });
      }

      const securityId = randomUUID();
      const identifierId = randomUUID();
      const mappingId = randomUUID();
      const linkId = randomUUID();
      const nowIso = now();
      const today = nowIso.slice(0, 10);

      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO securities (
                  id, asset_type, exchange_id, primary_currency_code, canonical_name,
                  isin, status, first_trade_date, last_trade_date, created_at, updated_at
                )
                SELECT ?, ?, NULL, ?, ?, NULL, 'active', NULL, NULL, ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM security_provider_mappings
                  WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                )`,
          params: [
            securityId,
            identity.assetType,
            identity.currencyCode,
            identity.name,
            nowIso,
            nowIso,
            providerId,
            providerExchange,
            providerSymbol,
          ],
        },
        {
          sql: `INSERT INTO security_identifiers (
                  id, security_id, scheme, value, exchange_id, valid_from, valid_to, source
                )
                SELECT ?, ?, 'ticker', ?, NULL, ?, NULL, ?
                WHERE EXISTS (SELECT 1 FROM securities WHERE id = ?)
                  AND NOT EXISTS (
                    SELECT 1 FROM security_provider_mappings
                    WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                  )`,
          params: [
            identifierId,
            securityId,
            providerSymbol,
            today,
            providerId,
            securityId,
            providerId,
            providerExchange,
            providerSymbol,
          ],
        },
        {
          sql: `INSERT INTO security_provider_mappings (
                  id, security_id, provider_id, provider_exchange, provider_symbol,
                  valid_from, valid_to, status, verified_by_user_id, verified_at
                )
                SELECT ?, ?, ?, ?, ?, ?, NULL, 'verified', ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM security_provider_mappings
                  WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                )`,
          params: [
            mappingId,
            securityId,
            providerId,
            providerExchange,
            providerSymbol,
            today,
            userId,
            nowIso,
            providerId,
            providerExchange,
            providerSymbol,
          ],
        },
      ];

      // Fold the owner's `portfolio_securities` link into this SAME batch
      // instead of a separate follow-up call: every canonical row this
      // batch might publish, plus the private link, must commit or roll
      // back together, or a crash/abort between two separate batches could
      // leave a published-but-unlinked canonical row with no owner ever
      // attributed to it. Both link statements below resolve `security_id`
      // from a live subquery against `security_provider_mappings` (guarded
      // on the mapping existing) rather than the literal `securityId`
      // generated above, so linking is correct even when a concurrent
      // publish's row -- not this attempt's -- is the one still standing
      // once this statement runs.
      if (!alreadyResolvedElsewhere) {
        statements.push(
          existingRow
            ? {
                sql: `UPDATE portfolio_securities
                      SET security_id = (
                            SELECT security_id FROM security_provider_mappings
                            WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                              AND valid_to IS NULL
                            ORDER BY valid_from DESC LIMIT 1
                          ),
                          status = 'held', updated_at = ?
                      WHERE id = ? AND user_id = ? AND portfolio_id = ?
                        AND status = 'unresolved' AND security_id IS NULL
                        AND EXISTS (
                          SELECT 1 FROM security_provider_mappings
                          WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                            AND valid_to IS NULL
                        )`,
                params: [
                  providerId,
                  providerExchange,
                  providerSymbol,
                  nowIso,
                  existingRow.id,
                  userId,
                  candidate.portfolioId,
                  providerId,
                  providerExchange,
                  providerSymbol,
                ],
              }
            : {
                sql: `INSERT INTO portfolio_securities (
                        id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias,
                        source_currency_code, status, created_at, updated_at
                      )
                      SELECT ?, ?, ?,
                             (SELECT security_id FROM security_provider_mappings
                               WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                                 AND valid_to IS NULL
                               ORDER BY valid_from DESC LIMIT 1),
                             ?, ?, ?, 'held', ?, ?
                      WHERE EXISTS (
                              SELECT 1 FROM security_provider_mappings
                              WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                                AND valid_to IS NULL
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
                  providerId,
                  providerExchange,
                  providerSymbol,
                  candidate.sourceSymbol,
                  candidate.sourceExchangeAlias,
                  candidate.sourceCurrencyCode,
                  nowIso,
                  nowIso,
                  providerId,
                  providerExchange,
                  providerSymbol,
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
        // Creation-only against the shared master: every insert is guarded
        // on the provider identity still being unclaimed, and everything --
        // the canonical rows plus the owner's link -- runs in one atomic
        // `batch()` call (see `runAtomicPersist`'s doc comment in
        // import-staging.ts for the guard-conditional technique this
        // mirrors). A concurrent verify for the same identity either loses
        // this race outright (its own batch throws on the unique index
        // `security_provider_mappings_provider_symbol_from_unique`, rolling
        // this whole attempt -- canonical rows and link alike -- back) or
        // -- if it committed first -- makes the `WHERE NOT EXISTS` guards
        // on the canonical inserts no-op while the link statement's `WHERE
        // EXISTS`/live subquery still fire, linking straight to the
        // concurrent winner within this same call. Either way nothing is
        // published twice and no canonical row is ever left unlinked; the
        // unconditional re-read below resolves to whichever attempt
        // actually won.
        await client.batch(statements);
      } catch {
        // Fall through to the unconditional re-read below.
      }

      const winner = await existingMapping(
        providerId,
        providerExchange,
        providerSymbol,
      );
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

    // WLT-001: identical creation-only resolution to `publishAndLink` above
    // (dedupe by provider mapping, then owner-attested ticker, then a fresh
    // publish), but never writes/links a `portfolio_securities` row -- see
    // the interface doc comment. `userId` is retained for symmetry with
    // `publishAndLink` and future audit attribution, though this method's
    // shared-master writes are not owner-scoped by column (the same
    // creation-only discipline every other publish path in this file
    // follows).
    async publishOnly(userId, providerId, identity) {
      const providerExchange = identity.providerExchange ?? "";
      const providerSymbol = identity.providerSymbol;

      const existing = await existingMapping(
        providerId,
        providerExchange,
        providerSymbol,
      );
      if (existing) {
        const currency = await securityCurrency(existing.security_id);
        if (currency !== identity.currencyCode) {
          return { ok: false, reason: "currency_mismatch" };
        }
        return { ok: true, securityId: existing.security_id, created: false };
      }

      const attested = await existingAttestedIdentifier(providerSymbol);
      if (attested) {
        const currency = await securityCurrency(attested.security_id);
        if (currency !== identity.currencyCode) {
          return { ok: false, reason: "currency_mismatch" };
        }
        const attachMappingId = randomUUID();
        const attachNowIso = now();
        const attachToday = attachNowIso.slice(0, 10);
        try {
          await client.batch([
            {
              sql: `INSERT INTO security_provider_mappings (
                      id, security_id, provider_id, provider_exchange, provider_symbol,
                      valid_from, valid_to, status, verified_by_user_id, verified_at
                    )
                    SELECT ?, ?, ?, ?, ?, ?, NULL, 'verified', ?, ?
                    WHERE NOT EXISTS (
                      SELECT 1 FROM security_provider_mappings
                      WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                    )`,
              params: [
                attachMappingId,
                attested.security_id,
                providerId,
                providerExchange,
                providerSymbol,
                attachToday,
                userId,
                attachNowIso,
                providerId,
                providerExchange,
                providerSymbol,
              ],
            },
          ]);
        } catch {
          // Fall through to the unconditional re-read below.
        }
        const attachWinner = await existingMapping(
          providerId,
          providerExchange,
          providerSymbol,
        );
        if (!attachWinner) return { ok: false, reason: "conflict" };
        return {
          ok: true,
          securityId: attachWinner.security_id,
          created: false,
        };
      }

      const securityId = randomUUID();
      const identifierId = randomUUID();
      const mappingId = randomUUID();
      const nowIso = now();
      const today = nowIso.slice(0, 10);
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO securities (
                  id, asset_type, exchange_id, primary_currency_code, canonical_name,
                  isin, status, first_trade_date, last_trade_date, created_at, updated_at
                )
                SELECT ?, ?, NULL, ?, ?, NULL, 'active', NULL, NULL, ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM security_provider_mappings
                  WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                )`,
          params: [
            securityId,
            identity.assetType,
            identity.currencyCode,
            identity.name,
            nowIso,
            nowIso,
            providerId,
            providerExchange,
            providerSymbol,
          ],
        },
        {
          sql: `INSERT INTO security_identifiers (
                  id, security_id, scheme, value, exchange_id, valid_from, valid_to, source
                )
                SELECT ?, ?, 'ticker', ?, NULL, ?, NULL, ?
                WHERE EXISTS (SELECT 1 FROM securities WHERE id = ?)
                  AND NOT EXISTS (
                    SELECT 1 FROM security_provider_mappings
                    WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                  )`,
          params: [
            identifierId,
            securityId,
            providerSymbol,
            today,
            providerId,
            securityId,
            providerId,
            providerExchange,
            providerSymbol,
          ],
        },
        {
          sql: `INSERT INTO security_provider_mappings (
                  id, security_id, provider_id, provider_exchange, provider_symbol,
                  valid_from, valid_to, status, verified_by_user_id, verified_at
                )
                SELECT ?, ?, ?, ?, ?, ?, NULL, 'verified', ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM security_provider_mappings
                  WHERE provider_id = ? AND provider_exchange = ? AND provider_symbol = ?
                )`,
          params: [
            mappingId,
            securityId,
            providerId,
            providerExchange,
            providerSymbol,
            today,
            userId,
            nowIso,
            providerId,
            providerExchange,
            providerSymbol,
          ],
        },
      ];
      try {
        await client.batch(statements);
      } catch {
        // Fall through to the unconditional re-read below.
      }
      const winner = await existingMapping(
        providerId,
        providerExchange,
        providerSymbol,
      );
      if (!winner) return { ok: false, reason: "conflict" };
      return {
        ok: true,
        securityId: winner.security_id,
        created: winner.security_id === securityId,
      };
    },
  };
}
