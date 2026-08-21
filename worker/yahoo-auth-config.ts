// MKT-009B: server-only factory that resolves the owner's optional Yahoo
// login cookies (`YAHOO_COOKIE_T`/`YAHOO_COOKIE_Y`) from Worker env, mirroring
// `worker/sharesight-config.ts`'s optional-env convention (its own env input
// is a local type decoupled from the generated ambient `Env`, so this module
// needs no `worker-configuration.d.ts`/`wrangler.json` change until a real
// caller wires the binding).
//
// Cookie names per MKT-009A's dated evidence (docs/MARKET_DATA_STRATEGY.md
// §20, primary-source `yfinance` `data.py` `Auth.set_login_cookies`): the
// owner exports `T` and `Y` from an already-logged-in browser session at
// `https://finance.yahoo.com`. There is no headless/unattended grant --
// these are themselves a live session snapshot, not a credential this
// factory can validate beyond "present and non-empty"; actual login
// validity is only ever discovered by the adapter's own 401 handling
// (`domain/market-data/yahoo-compatible.ts`).
//
// Absent BOTH env vars means the authenticated leg is DISABLED -- a typed
// state (`{ enabled: false }`), never a thrown error -- so the rest of the
// Worker treats Yahoo auth as an optional enhancement layered on the
// existing fully-anonymous adapter, exactly like Sharesight's optional
// integration. A HALF-configured pair (one cookie present, the other
// missing) is also disabled, with a distinct `reason`, rather than guessing
// which cookie to trust or sending an incomplete cookie jar upstream.
//
// Secrets discipline (binding on every caller): values are NEVER logged,
// echoed in error messages, or returned in any shape other than the sealed
// `YahooAuthConfig.credentials` object consumed directly by the adapter's
// cookie header. `tests/mkt-009b.test.ts` greps this module's behaviour for
// leakage, not just its typed shape.

export type YahooAuthConfigEnvInput = Readonly<{
  YAHOO_COOKIE_T?: unknown;
  YAHOO_COOKIE_Y?: unknown;
}>;

export type YahooAuthCredentials = Readonly<{
  cookieT: string;
  cookieY: string;
}>;

export type YahooAuthConfig =
  | Readonly<{
      enabled: false;
      reason: "not_configured" | "incomplete_configuration";
    }>
  | Readonly<{ enabled: true; credentials: YahooAuthCredentials }>;

function normalizeCookie(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Never throws for absent/incomplete configuration -- callers check
 * `.enabled` and fall back to the adapter's pre-existing fully-anonymous
 * behaviour whenever this returns `{ enabled: false }`.
 */
export function createYahooAuthConfig(
  env: YahooAuthConfigEnvInput,
): YahooAuthConfig {
  const cookieT = normalizeCookie(env.YAHOO_COOKIE_T);
  const cookieY = normalizeCookie(env.YAHOO_COOKIE_Y);

  if (cookieT === null && cookieY === null) {
    return { enabled: false, reason: "not_configured" };
  }
  if (cookieT === null || cookieY === null) {
    return { enabled: false, reason: "incomplete_configuration" };
  }

  return { enabled: true, credentials: { cookieT, cookieY } };
}
