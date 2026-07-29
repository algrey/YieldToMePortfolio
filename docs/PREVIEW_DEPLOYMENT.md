# Preview Deployment

VSL-006 packages the read-only fixture slice for a non-production Cloudflare
preview. The preview profile in `wrangler.json` sets
`YIELDTOME_RUNTIME_ENV=preview`, uses the preview D1 binding, keeps
`MARKET_DATA_PROVIDER=disabled`, and requires Cloudflare Access issuer and
audience secrets. It does not enable production authentication data, live
market data, background jobs, deletion, or mutations.

## Local review

```sh
npm run build
npm run preview:harness
```

The harness serves the built Worker at `http://127.0.0.1:8788` with the signed
test principal and deterministic fixture JWKS. It is for local review only and
does not use production credentials. To expose that fixture-only surface for a
short review session, run `cloudflared tunnel --url http://localhost:8788`.
The resulting `trycloudflare.com` URL is temporary and public; it is not a
production or private Access deployment and must not be used with real data.
If the Worker is rebuilt while the harness remains running, its asset resolver
uses the current CSS bundle for stale hashed stylesheet references so the page
cannot silently render unstyled; unrelated missing assets return an explicit
503 diagnostic.

The VSL-006 review URL captured for this task is:

`https://leads-strips-whole-completion.trycloudflare.com`

The capture manifest is [PREVIEW_EVIDENCE.json](PREVIEW_EVIDENCE.json). The
fixture contract is exercised by `tests/preview-valuation.test.ts`, and the
route smoke checks are in `tests/rendered-html.test.mjs`.

## Cloudflare preview

Publish with the repository's supported Sites/Wrangler workflow after setting
the preview Access secrets out of source control. The public preview URL and
deployed-route smoke results must be added to the manifest after publication.
Never put Access tokens, D1 exports, or fixture response dumps in this
repository.

The dedicated preview Worker profile was deployed separately at
`yieldtome-portfolio-preview.argreen.workers.dev`; Access issuer and audience
secrets remain intentionally unset until the operator has the tenant-specific
values. The Quick Tunnel review uses the local fixture principal instead.
