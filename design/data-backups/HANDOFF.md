# Handoff: Data & Backups redesign → yieldtome-ui

Design target: `DataBackups.dc.html` (this folder). It is a static mockup with sample data. The markup between `<main>` and `</main>` is the intended structure; all styling is inline and uses only existing tokens (`--forest`, `--divider`, `--muted`, `--green`, etc.).

## Components to change (in `app/components/`)

| Component                  | File (upstream)              | Redesigned as                                                                                            |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| SystemBackupPanel          | `system-backup-panel.tsx`    | Card with header row + Export / Restore two-column grid (`1fr 1.4fr`)                                    |
| SystemBackupPreviewSummary | `system-backup-panel.tsx`    | Count grid (6 cells), "Portfolios to recreate" rows, settings diff (current → next, changed rows only)   |
| BundlePanel                | `portfolio-bundle-panel.tsx` | Same card pattern as SystemBackupPanel                                                                   |
| BundlePreviewSummary       | `portfolio-bundle-panel.tsx` | Headline sentence, count grid (4 cells), overrides as one `dl` line                                      |
| HistoricalDataPanel        | `historical-data-panel.tsx`  | Card with numbered steps in a `200px 1fr` grid: 1 Coverage, 2 Import CSVs, 3 Backup, then Upload history |

## Rules

- Keep every prop, state, handler, fetch call, `role`/`aria-*` attribute and copy string that carries meaning. Only the JSX structure and CSS change.
- Move inline styles from the mockup into `globals.css` as purpose-named classes (the app's convention; no Tailwind utilities). Suggested names: `.backup-card`, `.backup-card-header`, `.backup-card-split`, `.backup-export`, `.backup-restore`, `.file-drop`, `.count-grid`, `.count-cell`, `.settings-diff`, `.step-grid`, `.step-label`.
- Reuse existing classes where they already exist: `.eyebrow`, `.numeric`, `.status-banner.warning`, `.file-picker-input` (keep the visually hidden file input pattern).
- Blocking states (`baseCurrencyMismatch`, `!precondition.fresh`) render as `.status-banner.warning`, not `.historical-data-error` paragraphs.
- Counts render as numerals in `.count-cell` (value on top, muted label below), never "N thing(s)" list items.
- Settings diff: only rows where current !== next; show "(N other settings unchanged)" beneath.
- Below ~720px the two-column splits and `200px 1fr` step grids stack to one column.

## Also fix while there (design-sync reported this)

In `globals.css`, add a kind comment after these custom properties:

- `--sans`, `--serif` → `/* @kind font */`
- `--default-transition-duration`, `--default-transition-timing-function`, `--tw-numeric-figure`, `--tw-ordinal`, `--tw-blur`, `--tw-invert`, `--tw-scale-x`, `--tw-scale-y` and any other `--tw-*` → `/* @kind other */`
