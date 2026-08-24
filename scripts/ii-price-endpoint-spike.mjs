// MKT-018A: Intelligent Investor price-endpoint evidence spike (owner
// directive 2026-08-24, docs/ASXCSVDownloadGuide.md): the owner's guide
// downloads ASX price history via a CLIENT-SIDE Highcharts CSV export run in
// a real browser tab (`chart.downloadCSV()`). A Cloudflare Worker cannot
// execute page JS, so that script cannot run server-side. This spike checks
// whether the chart's underlying data instead arrives over a plain,
// fetchable HTTP endpoint a Worker COULD call directly.
//
// THIS SCRIPT IS EVIDENCE-GATHERING ONLY -- it is not imported by, and does
// not change, any provider/adapter/import-pipeline code. See
// docs/MARKET_DATA_STRATEGY.md's dated MKT-018A section for the full
// write-up (endpoint shape, robots.txt/WAF posture, go/no-go
// recommendation).
//
// WHAT THIS PROBES, per ticker (default SHL/CBA/BHP, override via argv)
//   1. GET https://www.intelligentinvestor.com.au/robots.txt -- read once,
//      to honestly report the site's own stated crawl posture for the
//      endpoint this spike is about to call.
//   2. GET the share page's bare ticker URL (`/shares/asx-{ticker}/`),
//      following redirects, to resolve the slugged canonical page URL --
//      the guide's own documented URL pattern needs no slug, but the
//      underlying chart-data endpoint (below) is slug-scoped.
//   3. GET the slugged page's `_price-chart` AJAX fragment (the exact path
//      this spike found embedded in the base page as
//      `ajax-loader-data[data-content]`) -- this is the fragment
//      `init_chart` lazy-loads client-side and where the chart's Highcharts
//      config, including its full price-history data array, actually lives.
//   4. Extracts the embedded `data: [ [timestamp,price], ... ]` array (a
//      valid JSON array once isolated by bracket-depth matching -- the
//      surrounding object literal uses unquoted keys, but the array itself
//      contains only numeric tuples) and reports SHAPE evidence: point
//      count, first/last observed date, and a couple of sample values (this
//      is public delayed market data, not owner data -- printing a few
//      close values for verification is within this task's output
//      discipline).
//
// OUTPUT DISCIPLINE: shapes, counts, HTTP statuses, and a small number of
// sample field values -- never a bulk dump of the embedded series (which can
// run to several thousand points per ticker).
//
// POLITENESS: robots.txt (fetched first, see above) declares
// `Crawl-delay: 20` for this site. This spike is a manual, one-off
// evidence-gathering run (not a recurring job), but honours that delay
// between requests anyway -- a small, fixed ticker list (default 3) keeps
// the total run under a few minutes.
//
// HOW TO RUN
//   node scripts/ii-price-endpoint-spike.mjs [TICKER ...]
//   Needs outbound network access to www.intelligentinvestor.com.au
//   (sandboxed shells must disable the network sandbox for this run, same
//   as any other live spike in this repo).

const BASE = "https://www.intelligentinvestor.com.au";
// This site's WAF returns a bare 403 to requests with no User-Agent header
// at all (VERIFIED by this spike -- see the write-up); a realistic browser
// UA is the minimum needed to reach any page here, evidence-only, not a
// disguise this codebase would ship in production without the Orchestrator
// weighing that fact explicitly.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DEFAULT_TICKERS = ["shl", "cba", "bhp"];
const CRAWL_DELAY_MS = 20_000;

function section(title) {
  console.log("");
  console.log(`=== ${title} ===`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Isolates the FIRST `data: [ ... ]` array literal after `marker` in
 * `html` by walking bracket depth (the array holds only `[number,number]`
 * tuples, so depth never exceeds 2) and returns it as a JSON string.
 * Returns null if no balanced array is found. */
function extractDataArray(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;
  const dataKeyIndex = html.indexOf("data:", markerIndex);
  if (dataKeyIndex === -1) return null;
  const openIndex = html.indexOf("[", dataKeyIndex);
  if (openIndex === -1) return null;
  let depth = 0;
  for (let i = openIndex; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return html.slice(openIndex, i + 1);
    }
  }
  return null;
}

async function fetchRobotsTxt() {
  section("robots.txt posture");
  const url = `${BASE}/robots.txt`;
  console.log(`GET ${url}`);
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
  });
  console.log(`robots.txt: httpStatus=${response.status}`);
  if (!response.ok) return;
  const text = await response.text();
  const priceChartRule = text
    .split("\n")
    .find((line) => line.toLowerCase().includes("_price-chart"));
  const crawlDelayRule = text
    .split("\n")
    .find((line) => line.toLowerCase().startsWith("crawl-delay"));
  console.log(
    `robots.txt: price-chart rule = ${priceChartRule ? JSON.stringify(priceChartRule.trim()) : "(none found)"}`,
  );
  console.log(
    `robots.txt: crawl-delay rule = ${crawlDelayRule ? JSON.stringify(crawlDelayRule.trim()) : "(none found)"}`,
  );
}

async function probeNoUserAgent() {
  section("WAF posture: request with NO User-Agent header");
  const url = `${BASE}/shares/asx-shl/`;
  console.log(`GET ${url} (no user-agent header)`);
  const response = await fetch(url, { redirect: "manual" });
  console.log(
    `no-UA request: httpStatus=${response.status} -- compare against the per-ticker requests below, which all send a browser UA`,
  );
}

async function probeTicker(ticker) {
  section(`ticker ${ticker.toUpperCase()}`);

  const baseUrl = `${BASE}/shares/asx-${ticker.toLowerCase()}/`;
  console.log(`GET ${baseUrl} (resolving canonical slugged URL)`);
  const baseResponse = await fetch(baseUrl, {
    headers: { "user-agent": USER_AGENT },
    redirect: "follow",
  });
  console.log(
    `base page: httpStatus=${baseResponse.status} resolvedUrl=${baseResponse.url}`,
  );
  if (!baseResponse.ok) {
    console.log(`base page: skipping ${ticker} -- could not resolve slug`);
    return;
  }
  const baseHtml = await baseResponse.text();
  const contentMatch = baseHtml.match(
    /data-content="([^"]*_price-chart[^"]*)"/,
  );
  const fragmentPath = contentMatch
    ? contentMatch[1].replace(/&amp;/g, "&")
    : null;
  console.log(
    `base page: embedded _price-chart fragment path = ${fragmentPath ? JSON.stringify(fragmentPath) : "(not found -- page structure may have changed)"}`,
  );
  if (!fragmentPath) return;

  await sleep(CRAWL_DELAY_MS);

  const fragmentUrl = new URL(fragmentPath, baseResponse.url).toString();
  console.log(`GET ${fragmentUrl}`);
  const fragmentResponse = await fetch(fragmentUrl, {
    headers: { "user-agent": USER_AGENT },
  });
  console.log(
    `price-chart fragment: httpStatus=${fragmentResponse.status} contentType=${fragmentResponse.headers.get("content-type")} cacheControl=${fragmentResponse.headers.get("cache-control")}`,
  );
  if (!fragmentResponse.ok) return;
  const fragmentHtml = await fragmentResponse.text();
  console.log(`price-chart fragment: bodyBytes=${fragmentHtml.length}`);

  const currencyHeadingMatch = fragmentHtml.match(
    /Share Price Chart - ([A-Za-z]+ ?\(?\$?\)?)</,
  );
  console.log(
    `price-chart fragment: currency heading = ${currencyHeadingMatch ? JSON.stringify(currencyHeadingMatch[1]) : "(not found)"}`,
  );

  const priceArrayJson = extractDataArray(fragmentHtml, "id: 'dataseries'");
  if (!priceArrayJson) {
    console.log(
      "price-chart fragment: could not isolate the price data array -- page structure may have changed",
    );
    return;
  }
  let pairs;
  try {
    pairs = JSON.parse(priceArrayJson);
  } catch (caught) {
    console.log(
      `price-chart fragment: price data array did not parse as JSON (${caught?.message ?? caught})`,
    );
    return;
  }
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  console.log(
    `price series: points=${pairs.length} firstDate=${new Date(first[0]).toISOString().slice(0, 10)} lastObservation=${new Date(last[0]).toISOString()}`,
  );
  console.log(
    `price series: sample values (public delayed data, a couple of points only) firstClose=${first[1]} (${typeof first[1]}) lastClose=${last[1]} (${typeof last[1]})`,
  );

  const divArrayJson = extractDataArray(fragmentHtml, "name: 'divFlag'");
  if (divArrayJson) {
    try {
      const divEvents = JSON.parse(divArrayJson);
      console.log(
        `dividend-flag series (divFlag): points=${divEvents.length} sampleEvent=${JSON.stringify(divEvents[0] ?? null)}`,
      );
    } catch {
      console.log(
        "dividend-flag series (divFlag): present but did not parse as JSON",
      );
    }
  } else {
    console.log("dividend-flag series (divFlag): not found in this fragment");
  }
}

async function main() {
  const tickers =
    process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_TICKERS;

  await fetchRobotsTxt();
  await sleep(CRAWL_DELAY_MS);
  await probeNoUserAgent();
  await sleep(CRAWL_DELAY_MS);

  for (const ticker of tickers) {
    await probeTicker(ticker);
    if (ticker !== tickers[tickers.length - 1]) await sleep(CRAWL_DELAY_MS);
  }

  section("done");
  console.log(
    "See docs/MARKET_DATA_STRATEGY.md's dated MKT-018A section for the full write-up and go/no-go recommendation.",
  );
}

try {
  await main();
} catch (caught) {
  // Fail closed with a readable message rather than a raw fetch-failed
  // stack trace -- an offline machine or a DNS/TLS failure is a
  // network-reachability problem, not evidence of anything site-side
  // (matches scripts/yahoo-auth-spike.mjs's precedent).
  console.error("");
  console.error(
    `Spike aborted: a network request failed unexpectedly (${caught?.message ?? caught}).`,
  );
  console.error(
    "This usually means no outbound network access to intelligentinvestor.com.au from this machine/sandbox -- not a site-side result.",
  );
  process.exit(1);
}
