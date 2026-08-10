import Link from "next/link";
import { AccountLifecycleControls } from "./account-lifecycle-controls";
import {
  formatDecimalFixed,
  formatDecimalTrimmed,
  groupThousands,
  parseDecimal,
} from "../../domain/calculations/decimal.ts";
import type {
  PortfolioInspection,
  PortfolioInspectionCashAccount,
  PortfolioInspectionCashEntry,
  PortfolioInspectionLot,
  PortfolioInspectionLotAllocation,
  PortfolioInspectionTransaction,
} from "../../db/repositories/portfolio-inspection.ts";

export type OwnedDetailsProps = Readonly<{
  inspection: PortfolioInspection | null;
  onOpenSettings: () => void;
}>;

function sourceScale(value: string): number {
  return value.split(".")[1]?.length ?? 0;
}

function decimal(value: string | null, empty = "—"): string {
  if (value === null) return empty;
  try {
    return formatDecimalTrimmed(parseDecimal(value), sourceScale(value));
  } catch {
    return empty;
  }
}

function money(value: string | null, currency: string): string {
  if (value === null) return "Unavailable";
  try {
    return `${currency} ${groupThousands(formatDecimalFixed(parseDecimal(value), 2))}`;
  } catch {
    return "Unavailable";
  }
}

function dateLabel(value: string): string {
  return value.slice(0, 10);
}

function EmptyInspectionList({ message }: { message: string }) {
  return <p className="inspection-empty">{message}</p>;
}

function SettingsPanel({
  inspection,
  onOpenSettings,
}: {
  inspection: PortfolioInspection;
  onOpenSettings: () => void;
}) {
  const settings = inspection.settings;
  return (
    <section className="inspection-panel" aria-labelledby="settings-title">
      <div className="inspection-heading">
        <div>
          <p className="eyebrow">Owned configuration</p>
          <h2 id="settings-title">Portfolio settings</h2>
        </div>
        <button type="button" onClick={onOpenSettings}>
          Open settings menu
        </button>
      </div>
      <dl className="inspection-settings">
        <div>
          <dt>Portfolio</dt>
          <dd>{inspection.portfolio.name}</dd>
        </div>
        <div>
          <dt>Code</dt>
          <dd>{inspection.portfolio.code}</dd>
        </div>
        <div>
          <dt>Home currency</dt>
          <dd>
            {settings?.homeCurrencyCode ??
              inspection.portfolio.homeCurrencyCode}
          </dd>
        </div>
        <div>
          <dt>Display values</dt>
          <dd>{settings?.defaultHoldingCurrencyView ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Timezone</dt>
          <dd>{settings?.timezone ?? inspection.portfolio.timezone}</dd>
        </div>
        <div>
          <dt>Accounting</dt>
          <dd>{inspection.portfolio.accountingMethod.toUpperCase()}</dd>
        </div>
      </dl>
      <p className="inspection-note">
        Settings changes remain server-authoritative. This screen is read-only;
        use the menu above for the existing home-currency and display-view
        controls.
      </p>
    </section>
  );
}

function TransactionRecord({
  transaction,
}: {
  transaction: PortfolioInspectionTransaction;
}) {
  return (
    <article className="inspection-record">
      <div className="inspection-record-heading">
        <div>
          <strong>{transaction.securityLabel ?? transaction.type}</strong>
          <span>{transaction.type.replaceAll("_", " ")}</span>
        </div>
        <time dateTime={transaction.businessDate}>
          {dateLabel(transaction.businessDate)}
        </time>
      </div>
      <dl className="inspection-facts">
        <div>
          <dt>Quantity</dt>
          <dd>{decimal(transaction.quantityDecimal)}</dd>
        </div>
        <div>
          <dt>Unit price</dt>
          <dd>
            {money(transaction.unitPriceDecimal, transaction.currencyCode)}
          </dd>
        </div>
        <div>
          <dt>Gross</dt>
          <dd>
            {money(transaction.grossAmountDecimal, transaction.currencyCode)}
          </dd>
        </div>
        <div>
          <dt>Fees / tax</dt>
          <dd>
            {money(transaction.feeAmountDecimal, transaction.currencyCode)} /{" "}
            {money(transaction.taxAmountDecimal, transaction.currencyCode)}
          </dd>
        </div>
      </dl>
      <details className="inspection-evidence">
        <summary>Show transaction provenance</summary>
        <p>
          Source: {transaction.sourceType}
          {transaction.sourceReference
            ? ` · reference ${transaction.sourceReference}`
            : ""}
          . Exact trade time: {transaction.tradeAt}.
          {transaction.settlementDate
            ? ` Settlement date: ${transaction.settlementDate}.`
            : ""}
        </p>
        <p>
          Status: {transaction.status}. Calculation version:{" "}
          {transaction.calculationVersion}.
          {transaction.fxRateToBaseDecimal
            ? ` FX ${transaction.fxRateToBaseDecimal} (${transaction.fxRateSource ?? "source unavailable"}).`
            : " FX unavailable or not required."}
        </p>
        {transaction.reversesTransactionId ||
        transaction.supersedesTransactionId ? (
          <p>
            {transaction.reversesTransactionId
              ? `Reverses ${transaction.reversesTransactionId}. `
              : ""}
            {transaction.supersedesTransactionId
              ? `Supersedes ${transaction.supersedesTransactionId}.`
              : ""}
          </p>
        ) : null}
      </details>
    </article>
  );
}

function LotRecord({
  lot,
  allocations,
  currency,
}: {
  lot: PortfolioInspectionLot;
  allocations: readonly PortfolioInspectionLotAllocation[];
  currency: string;
}) {
  const matches = allocations.filter(
    (allocation) => allocation.taxLotId === lot.id,
  );
  return (
    <article className="inspection-record">
      <div className="inspection-record-heading">
        <div>
          <strong>{lot.securityLabel}</strong>
          <span>
            {lot.status} · {lot.basisStatus.replaceAll("_", " ")}
          </span>
        </div>
        <time dateTime={lot.acquiredAt}>{dateLabel(lot.acquiredAt)}</time>
      </div>
      <dl className="inspection-facts">
        <div>
          <dt>Open quantity</dt>
          <dd>{decimal(lot.openQuantityDecimal)}</dd>
        </div>
        <div>
          <dt>Open basis</dt>
          <dd>{money(lot.baseBasisDecimal, currency)}</dd>
        </div>
        <div>
          <dt>Original quantity</dt>
          <dd>{decimal(lot.originalQuantityDecimal)}</dd>
        </div>
        <div>
          <dt>Matched sales</dt>
          <dd>{matches.length}</dd>
        </div>
      </dl>
      <details className="inspection-evidence">
        <summary>Show lot provenance</summary>
        <p>
          Opening transaction: {lot.openingTransactionId}. Exact acquired time:{" "}
          {lot.acquiredAt}. Rebuilt at {lot.rebuiltAt}; calculation version{" "}
          {lot.calculationVersion}.
        </p>
        {matches.length > 0 ? (
          <ul>
            {matches.map((match) => (
              <li key={match.id}>
                Sale {match.sellTransactionId}: matched{" "}
                {decimal(match.matchedQuantityDecimal)}, basis{" "}
                {money(match.allocatedBaseBasisDecimal, currency)}, gain{" "}
                {money(match.baseRealisedGainDecimal, currency)}.
              </li>
            ))}
          </ul>
        ) : (
          <p>No matched sale allocation is recorded for this lot.</p>
        )}
      </details>
    </article>
  );
}

function CashAccountRecord({
  account,
}: {
  account: PortfolioInspectionCashAccount;
}) {
  return (
    <article className="inspection-record">
      <div className="inspection-record-heading">
        <div>
          <strong>{account.currencyCode} cash</strong>
          <span>
            {account.completeness.replaceAll("_", " ")}
            {account.balanceStatus === "complete"
              ? ""
              : " · balance unavailable"}
          </span>
        </div>
        <strong>{money(account.balanceDecimal, account.currencyCode)}</strong>
      </div>
      <details className="inspection-evidence">
        <summary>Show cash account provenance</summary>
        {account.balanceStatus === "complete" ? (
          <p>
            Account status: {account.status}. Balance is the exact sum of posted
            cash entries.
          </p>
        ) : account.balanceStatus === "window_incomplete" ? (
          <p>
            Account status: {account.status}. Balance is unavailable because the
            bounded inspection window does not contain every cash entry.
          </p>
        ) : (
          <p>
            Account status: {account.status}. Balance is unavailable because a
            stored cash amount could not be validated as an exact decimal.
          </p>
        )}
      </details>
    </article>
  );
}

function CashEntryRecord({ entry }: { entry: PortfolioInspectionCashEntry }) {
  return (
    <article className="inspection-record compact">
      <div className="inspection-record-heading">
        <div>
          <strong>{entry.type.replaceAll("_", " ")}</strong>
          <span>
            {entry.currencyCode} · {entry.status}
          </span>
        </div>
        <time dateTime={entry.businessDate}>
          {dateLabel(entry.businessDate)}
        </time>
      </div>
      <p className="inspection-amount">
        {money(entry.signedAmountDecimal, entry.currencyCode)}
      </p>
      <details className="inspection-evidence">
        <summary>Show cash entry provenance</summary>
        <p>
          Exact effective time: {entry.effectiveAt}. Source transaction:{" "}
          {entry.transactionId ?? "not linked"}.
          {entry.reversesEntryId ? ` Reverses ${entry.reversesEntryId}.` : ""}
        </p>
      </details>
    </article>
  );
}

export function OwnedPortfolioDetails({
  inspection,
  onOpenSettings,
}: OwnedDetailsProps) {
  if (inspection === null) {
    return (
      <section
        className="empty-state"
        aria-labelledby="details-unavailable-title"
      >
        <p className="eyebrow">Private ledger</p>
        <h1 id="details-unavailable-title">Ledger details unavailable</h1>
        <p>
          Portfolio evidence could not be loaded. No other owner’s data is
          shown.
        </p>
      </section>
    );
  }

  const { portfolio } = inspection;
  return (
    <div className="owned-details-screen">
      <section
        className="inspection-intro"
        aria-labelledby="owned-details-title"
      >
        <p className="eyebrow">
          Read-only provenance · {portfolio.homeCurrencyCode}
        </p>
        <h1 id="owned-details-title">{portfolio.name} details</h1>
        <p>
          Ledger facts, FIFO lots, cash entries, and settings are shown as
          stored. Financial values are not editable here.
        </p>
        <Link
          className="inspection-action"
          href={`/portfolio/${portfolio.id}/ledger/new`}
        >
          Manual entry and corrections
        </Link>
        <p className="inspection-note">
          This link opens the separate financial workflow; this inspection view
          never mutates shares, cost, or cash.
        </p>
      </section>

      <SettingsPanel inspection={inspection} onOpenSettings={onOpenSettings} />
      <AccountLifecycleControls />

      <section
        className="inspection-panel"
        aria-labelledby="transactions-title"
      >
        <div className="inspection-heading">
          <div>
            <p className="eyebrow">Immutable ledger facts</p>
            <h2 id="transactions-title">Transactions</h2>
          </div>
          {inspection.truncated.transactions ? (
            <span className="muted-copy">Showing first 200</span>
          ) : null}
        </div>
        {inspection.transactions.length === 0 ? (
          <EmptyInspectionList message="No transactions are recorded for this portfolio." />
        ) : (
          <div className="inspection-record-list">
            {inspection.transactions.map((transaction) => (
              <TransactionRecord
                key={transaction.id}
                transaction={transaction}
              />
            ))}
          </div>
        )}
      </section>

      <section className="inspection-panel" aria-labelledby="lots-title">
        <div className="inspection-heading">
          <div>
            <p className="eyebrow">FIFO projection</p>
            <h2 id="lots-title">Tax lots</h2>
          </div>
          {inspection.truncated.lots || inspection.truncated.allocations ? (
            <span className="muted-copy">
              Showing first 200 lots or matches
            </span>
          ) : null}
        </div>
        {inspection.lots.length === 0 ? (
          <EmptyInspectionList message="No FIFO lots are available yet." />
        ) : (
          <div className="inspection-record-list">
            {inspection.lots.map((lot) => (
              <LotRecord
                key={lot.id}
                lot={lot}
                allocations={inspection.allocations}
                currency={portfolio.homeCurrencyCode}
              />
            ))}
          </div>
        )}
      </section>

      <section className="inspection-panel" aria-labelledby="cash-title">
        <div className="inspection-heading">
          <div>
            <p className="eyebrow">Separate currency ledgers</p>
            <h2 id="cash-title">Cash</h2>
          </div>
          {inspection.truncated.cashEntries ? (
            <span className="muted-copy">Showing first 200 entries</span>
          ) : null}
        </div>
        {inspection.cashAccounts.length === 0 ? (
          <EmptyInspectionList message="No cash account is recorded for this portfolio." />
        ) : (
          <div className="inspection-record-list">
            {inspection.cashAccounts.map((account) => (
              <CashAccountRecord key={account.id} account={account} />
            ))}
          </div>
        )}
        <h3 className="inspection-subheading">Cash entries</h3>
        {inspection.cashEntries.length === 0 ? (
          <EmptyInspectionList message="No cash entries are recorded." />
        ) : (
          <div className="inspection-record-list">
            {inspection.cashEntries.map((entry) => (
              <CashEntryRecord key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
