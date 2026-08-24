# ASX Share Price CSV Download — Quick Reference

## 1. Page URL pattern

```
https://www.intelligentinvestor.com.au/shares/asx-{ticker}/
```

Example: `https://www.intelligentinvestor.com.au/shares/asx-shl/`

The bare ticker URL redirects automatically to the full slugged page (e.g. `.../sonic-healthcare-limited`). You don't need the slug — just the ticker.

## 2. What to do

1. Open Claude in Chrome (side panel).
2. Navigate to the ticker URL above.
3. Ask Claude to run the script below in that tab (or paste it into DevTools Console yourself).

## 3. The script (sets filename + downloads CSV directly)

```javascript
const chart = Highcharts.charts.find((c) => c && c.series && c.series.length);
if (!chart) {
  ("no chart found");
} else {
  chart.update({ exporting: { filename: "ASX-SHL" } }); // change ticker here
  chart.downloadCSV();
  ("triggered");
}
```

Replace `'ASX-SHL'` with the ticker you want (e.g. `'ASX-CBA'`, `'ASX-BHP'`). The file downloads straight to your Downloads folder already named correctly — no rename step needed.

## 4. Multi-ticker version

To do several tickers in one session, repeat: navigate → run script with updated filename → wait for download → next ticker.

```javascript
// Run once per ticker page load
function downloadTickerCSV(ticker) {
  const chart = Highcharts.charts.find((c) => c && c.series && c.series.length);
  if (!chart) return "no chart found";
  chart.update({ exporting: { filename: `ASX-${ticker.toUpperCase()}` } });
  chart.downloadCSV();
  return "triggered";
}

downloadTickerCSV("SHL");
```

## 5. Notes / limitations

- This only works while the Chrome extension side panel session is open — it does not persist if Chrome is closed, and can't run unattended/on a schedule in this form.
- The CSV is generated client-side by the page's Highcharts chart (not a fixed downloadable link) — the script above must be run on each ticker's page.
- For scheduled/unattended automation across many tickers, this would need to run through a cloud (Cowork) session instead — either headless (no login needed, since this data is public/delayed) or via the desktop bridge to your real browser (only fires successfully while your desktop app is open and connected).
