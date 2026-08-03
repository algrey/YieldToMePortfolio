"use client";

import Link from "next/link";
import { useState } from "react";
import type { ManualLedgerOptions } from "../../db/repositories/manual-ledger-options.ts";
import {
  MANUAL_LEDGER_TYPES,
  type ManualLedgerFormValue,
} from "../manual-ledger-contract.ts";

type ManualLedgerEntryProps = Readonly<{
  portfolioId: string;
  baseCurrencyCode: string;
  options: ManualLedgerOptions;
}>;

type Result = Readonly<{
  ok: boolean;
  message?: string;
  idempotencyKey?: string;
  preview?: {
    type: string;
    businessDate: string;
    currencyCode: string;
    grossAmountDecimal: string | null;
    cashEffectDecimal: string | null;
    cashImpact: string;
    fxStatus: string;
  };
  mutation?: {
    transaction: {
      id: string;
      status: string;
      type: string;
      tradeAt: string;
      localTradeDate: string;
      reversesTransactionId: string | null;
      supersedesTransactionId: string | null;
    };
    idempotent: boolean;
  };
}>;

const typeLabels: Record<(typeof MANUAL_LEDGER_TYPES)[number], string> = {
  buy: "Buy",
  sell: "Sell",
  cash_deposit: "Cash deposit",
  cash_withdrawal: "Cash withdrawal",
  fee: "Fee",
  tax: "Tax",
  split: "Stock split",
};

function isoTimestamp(value: FormDataEntryValue | undefined): string {
  if (typeof value !== "string" || value === "") return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "" : parsed.toISOString();
}

function formValue(
  form: HTMLFormElement,
  idempotencyKey: string | null,
): ManualLedgerFormValue {
  const entries = new FormData(form);
  const value: Record<string, unknown> = Object.fromEntries(entries.entries());
  value.tradeAt = isoTimestamp(entries.get("tradeAt") ?? undefined);
  value.fxObservedAt = isoTimestamp(entries.get("fxObservedAt") ?? undefined);
  if (idempotencyKey) value.idempotencyKey = idempotencyKey;
  return value as ManualLedgerFormValue;
}

function ResultPanel({
  result,
  onReverse,
  onReplace,
}: {
  result: Result;
  onReverse: () => void;
  onReplace: () => void;
}) {
  if (!result.ok) {
    return (
      <p className="manual-ledger-error" role="alert">
        {result.message}
      </p>
    );
  }
  const transaction = result.mutation?.transaction;
  return (
    <section
      className="manual-ledger-result"
      aria-labelledby="ledger-result-title"
    >
      <p className="eyebrow">Immutable submit result</p>
      <h2 id="ledger-result-title">
        {transaction?.type.replaceAll("_", " ")} recorded
      </h2>
      <p role="status">
        {result.mutation?.idempotent
          ? "The identical retry returned the existing fact."
          : "A new ledger fact was posted."}
        {transaction ? ` Business date: ${transaction.localTradeDate}.` : ""}
      </p>
      <details className="manual-ledger-evidence">
        <summary>Show exact transaction evidence</summary>
        <p>
          Transaction ID: {transaction?.id}. Exact trade time:{" "}
          {transaction?.tradeAt}.
        </p>
        <p>Server-issued idempotency key: {result.idempotencyKey}.</p>
        {transaction?.reversesTransactionId ? (
          <p>Reverses: {transaction.reversesTransactionId}.</p>
        ) : null}
        {transaction?.supersedesTransactionId ? (
          <p>Supersedes: {transaction.supersedesTransactionId}.</p>
        ) : null}
      </details>
      <div className="manual-ledger-actions">
        {transaction?.status === "posted" ? (
          <button type="button" onClick={onReverse}>
            Reverse this fact
          </button>
        ) : null}
        {transaction?.status === "posted" ? (
          <button type="button" onClick={onReplace}>
            Prepare a replacement
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function ManualLedgerEntry({
  portfolioId,
  baseCurrencyCode,
  options,
}: ManualLedgerEntryProps) {
  const [type, setType] = useState<(typeof MANUAL_LEDGER_TYPES)[number]>("buy");
  const [currency, setCurrency] = useState(baseCurrencyCode);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [retryKey, setRetryKey] = useState<string | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<string | null>(null);
  const securityEvent = type === "buy" || type === "sell" || type === "split";
  const missingFx = currency !== baseCurrencyCode;

  async function submit(form: HTMLFormElement) {
    setPending(true);
    const payload = formValue(form, retryKey);
    const endpoint = correctionTarget
      ? `/api/portfolios/${portfolioId}/ledger/${correctionTarget}/supersede`
      : `/api/portfolios/${portfolioId}/ledger`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const next = (await response.json().catch(() => ({
      ok: false,
      message: "The ledger response was invalid.",
    }))) as Result;
    setResult(next);
    setRetryKey(next.idempotencyKey ?? retryKey);
    setPending(false);
    if (next.ok) setCorrectionTarget(null);
  }

  async function reverse() {
    const transactionId = result?.mutation?.transaction.id;
    if (!transactionId) return;
    setPending(true);
    const response = await fetch(
      `/api/portfolios/${portfolioId}/ledger/${transactionId}/reverse`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const next = (await response.json().catch(() => ({
      ok: false,
      message: "The correction response was invalid.",
    }))) as Result;
    setResult(next);
    setRetryKey(next.idempotencyKey ?? retryKey);
    setPending(false);
  }

  return (
    <main className="manual-ledger-page">
      <header className="manual-ledger-heading">
        <p className="eyebrow">Private ledger · server validated</p>
        <h1>Manual entry and corrections</h1>
        <p>
          Record a supported ledger fact without changing history. Business
          dates stay visible; exact timestamps and provenance remain in the
          evidence disclosure.
        </p>
        <Link href={`/portfolio/${portfolioId}/details`}>
          Return to portfolio details
        </Link>
      </header>
      {result ? (
        <ResultPanel
          result={result}
          onReverse={reverse}
          onReplace={() => {
            setRetryKey(null);
            setCorrectionTarget(result.mutation?.transaction.id ?? null);
          }}
        />
      ) : null}
      <form
        className="manual-ledger-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget);
        }}
      >
        <fieldset disabled={pending}>
          <legend>
            {correctionTarget ? "Replacement fact" : "New ledger fact"}
          </legend>
          {correctionTarget ? (
            <p className="manual-ledger-notice" role="status">
              This creates a superseding replacement. The original transaction
              will remain unchanged.
            </p>
          ) : null}
          <div className="manual-ledger-grid">
            <label>
              Entry type
              <select
                name="type"
                value={type}
                onChange={(event) => setType(event.target.value as typeof type)}
              >
                {MANUAL_LEDGER_TYPES.map((entryType) => (
                  <option key={entryType} value={entryType}>
                    {typeLabels[entryType]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Transaction currency
              <select
                name="currencyCode"
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
              >
                {options.currencies.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
            {securityEvent ? (
              <label className="manual-ledger-wide">
                Owned security
                <select name="portfolioSecurityId" required>
                  <option value="">Select a security</option>
                  {options.securities.map((security) => (
                    <option key={security.id} value={security.id}>
                      {security.label} · {security.currencyCode}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <input type="hidden" name="portfolioSecurityId" value="" />
            )}
            {type === "split" ? (
              <>
                <label>
                  Split numerator (a)
                  <input
                    name="quantityDecimal"
                    inputMode="decimal"
                    required
                    pattern="(?:0|[1-9]\d*)(?:\.\d+)?"
                    aria-describedby="split-help"
                  />
                </label>
                <label>
                  Split denominator (b)
                  <input
                    name="unitPriceDecimal"
                    inputMode="decimal"
                    required
                    pattern="(?:0|[1-9]\d*)(?:\.\d+)?"
                    aria-describedby="split-help"
                  />
                </label>
                <p id="split-help" className="manual-ledger-help">
                  Both ratio values must be positive. A 3:2 split uses 3 and 2.
                </p>
              </>
            ) : securityEvent ? (
              <>
                <label>
                  Quantity
                  <input
                    name="quantityDecimal"
                    inputMode="decimal"
                    required
                    pattern="(?:0|[1-9]\d*)(?:\.\d+)?"
                  />
                </label>
                <label>
                  Unit price
                  <input
                    name="unitPriceDecimal"
                    inputMode="decimal"
                    required
                    pattern="(?:0|[1-9]\d*)(?:\.\d+)?"
                  />
                </label>
                <label>
                  Gross amount (optional check)
                  <input
                    name="grossAmountDecimal"
                    inputMode="decimal"
                    pattern="(?:0|[1-9]\d*)(?:\.\d+)?"
                  />
                </label>
              </>
            ) : (
              <label>
                Amount
                <input
                  name="grossAmountDecimal"
                  inputMode="decimal"
                  required
                  pattern="(?:0|[1-9]\d*)(?:\.\d+)?"
                />
              </label>
            )}
            <label>
              Fee
              <input
                name="feeAmountDecimal"
                defaultValue="0"
                inputMode="decimal"
                required
                pattern="(?:0|[1-9]\d*)(?:\.\d+)?"
              />
            </label>
            <label>
              Tax
              <input
                name="taxAmountDecimal"
                defaultValue="0"
                inputMode="decimal"
                required
                pattern="(?:0|[1-9]\d*)(?:\.\d+)?"
              />
            </label>
            <label>
              Business date
              <input name="localTradeDate" type="date" required />
            </label>
            <label>
              Exact trade time
              <input name="tradeAt" type="datetime-local" required />
            </label>
            <label>
              Settlement date (optional)
              <input name="settlementDate" type="date" />
            </label>
            <label>
              Source reference (optional)
              <input name="sourceReference" maxLength={200} />
            </label>
            <label>
              FX rate to {baseCurrencyCode} (optional)
              <input
                name="fxRateToBaseDecimal"
                inputMode="decimal"
                pattern="(?:0|[1-9]\d*)(?:\.\d+)?"
              />
            </label>
            <label>
              FX source (required with rate)
              <input name="fxRateSource" maxLength={120} />
            </label>
            <label>
              FX observed at (required with rate)
              <input name="fxObservedAt" type="datetime-local" />
            </label>
          </div>
          <section
            className="manual-ledger-preview"
            aria-labelledby="impact-preview-title"
          >
            <p className="eyebrow">Server impact preview</p>
            <h2 id="impact-preview-title">{typeLabels[type]} impact</h2>
            <p>
              Buy cash impact includes fees and tax; sell cash impact subtracts
              them. The server recalculates gross amount with exact decimals
              before posting.
            </p>
            {missingFx ? (
              <p className="manual-ledger-warning" role="status">
                FX unavailable for {currency} to {baseCurrencyCode}. Dependent
                home-currency values remain unavailable, never zero.
              </p>
            ) : (
              <p className="manual-ledger-help">
                {currency} matches the portfolio base currency; no conversion is
                required.
              </p>
            )}
          </section>
          <button type="submit">
            {pending
              ? "Saving…"
              : correctionTarget
                ? "Post superseding replacement"
                : "Post immutable ledger fact"}
          </button>
        </fieldset>
      </form>
    </main>
  );
}
