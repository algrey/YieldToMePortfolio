## Building with YieldToMe — conventions for the design agent

**Canvas first.** YieldToMe is a dark-first ledger UI: the page canvas is ink (`--ink`) with cream text (`--cream`). The stylesheet paints this on `html`/`body`, but a host page may repaint its own body, so wrap every design once in `AppCanvas` (exported from the bundle) — it re-applies the body defaults (background `--ink`, color `--cream`, `--sans` type, tabular numerals). Nothing else needs a provider: there is no theme or i18n context.

```jsx
const { AppCanvas, SubNav, BrandMark } = window.YieldToMe;
<AppCanvas>…your screen…</AppCanvas>
```

**Styling idiom: hand-written classes + CSS custom properties. No Tailwind utilities.** `_ds_bundle.css` (imported by `styles.css`) is the app's compiled `globals.css`: a Tailwind v4 preflight followed by ~320 purpose-named classes. Components use zero Tailwind utility classes (`flex`, `p-4`, `text-sm` do not exist here) — style your own layout glue with these tokens and classes, or small inline styles using the tokens.

Tokens (all on `:root`):

| Role | Names |
|---|---|
| surfaces | `--ink` (page), `--forest` (raised panel), `--forest-soft` (dialog/sheet), `--forest-raised` (hover/active row), `--divider` (hairlines) |
| text | `--cream` (primary), `--muted` (secondary), `--muted-dark` (tertiary) |
| accents | `--green` (brand, eyebrows, active tab), `--green-bright` (focus ring, emphasis), `--negative` (losses/errors), `--warning` (attention) |
| type | `--sans` (body, Inter/system stack), `--serif` (display headings — empty-state and page titles) |
| layout | `--content` (1440px max width), `--app-bar` (52px), `--tabs` (44px) |

Class vocabulary you may reuse for your own markup:

- `.eyebrow` — small uppercase green label above a heading or section.
- `.numeric` — right-aligned, no-wrap money/quantity cell; `.row-primary` / `.row-secondary` — the two-line list-row text pair (cream then muted).
- `.muted-copy` and `.unavailable` — muted text; **`unavailable` is the word for missing data**: never render 0 or "—" for a missing price, FX rate, cost basis or dividend.
- `.section-heading` (+ `.compact`) — flex row for a section title and its action.
- `.empty-state` with `.empty-mark`, `.eyebrow`, `h2`, `p` — the empty screen composition.
- `.status-banner` (+ `.warning` / `.error`) — a three-column grid: put `<span class="status-symbol">` first, then `<p>`, then an optional `<button>`.
- `.income-screen` / `.holding-screen` — full-screen area containers (centered at `--content`); `.subnav` chrome is produced by `SubNav`, `HoldingNav`, `IncomeNav`.
- `.icon-button`, `.dialog-actions`, `.income-dialog` — icon control, dialog footer row, dialog surface.
- `.sr-only`, `.desktop-only`, `.mobile-only` — accessibility and responsive visibility.

**Where the truth lives.** Read `styles.css` → `_ds_bundle.css` before inventing a class or colour; every token and class above is defined there. Per-component API and examples are in `components/<group>/<Name>/<Name>.prompt.md` and `<Name>.d.ts`. `PortfolioShell` is the primary-tab app frame; `SubNav`/`HoldingNav`/`IncomeNav` are the sub-area chrome.

**Idiomatic build snippet** (a holding sub-area with a metric list):

```jsx
const { AppCanvas, HoldingNav } = window.YieldToMe;
<AppCanvas>
  <main className="income-screen holding-screen">
    <HoldingNav portfolioId="p1" portfolioSecurityId="s1" symbol="VAS"
      subtitle="Vanguard Australian Shares · ASX · AUD" active="details" />
    <section>
      <div className="section-heading">
        <p className="eyebrow">Position</p>
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "8px 16px" }}>
        <dt className="row-secondary">Units</dt><dd className="numeric">1,240</dd>
        <dt className="row-secondary">Last price</dt><dd className="numeric unavailable">unavailable</dd>
      </dl>
    </section>
  </main>
</AppCanvas>
```
