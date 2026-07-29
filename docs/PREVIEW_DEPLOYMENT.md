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
does not expose a public URL or use production credentials.

The capture manifest is [PREVIEW_EVIDENCE.json](PREVIEW_EVIDENCE.json). The
fixture contract is exercised by `tests/preview-valuation.test.ts`, and the
route smoke checks are in `tests/rendered-html.test.mjs`.

## Cloudflare preview

Publish with the repository's supported Sites/Wrangler workflow after setting
the preview Access secrets out of source control. The public preview URL and
deployed-route smoke results must be added to the manifest after publication.
Never put Access tokens, D1 exports, or fixture response dumps in this
repository.
