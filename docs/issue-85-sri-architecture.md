# Issue #85 — Subresource Integrity (SRI) Build

**Target page:** [`vite.config.ts`](../vite.config.ts)
**Plugins:** `vite-plugin-subresource-integrity` (defined inline in `vite.config.ts`)
**Test coverage:** [`src/tests/subresource-integrity.test.ts`](../src/tests/subresource-integrity.test.ts)

## Goal

Every asset a browser loads from a StormSale build must be cryptographically
verified before execution. If a CDN, an OSS bucket, a mirror or a man-in-the-middle
path is compromised, the tampered bytes fail the browser's `integrity` check and
the resource is refused — no code executes.

The plugin delivers two Acceptance Criteria:

1. **Automatic build-time hash generation** — `transformIndexHtml` computes a
   SHA-384 digest of every emitted JS/CSS chunk and appends it to the tag as
   `integrity="sha384-…"`, plus `crossorigin="anonymous"` (required by the
   browser for the check to run).
2. **Hash verification on script load** — the `integrity` attribute itself is
   the verification directive; the browser performs the digest and blocks
   execution on mismatch. External `<script src="https://…">` tags are also
   pinned when their URL is in `KNOWN_EXTERNAL_INTEGRITY` (e.g. Telegram's
   `telegram-web-app.js`).

## Architecture

```mermaid
flowchart TD
    A[Source: index.html + src/main.tsx] --> B[Vite / Rollup build]
    B --> C{generateBundle hook}
    C -->|Each chunk / asset| D[Compute SHA-384 integrity]\nattach to bundle item
    C -->|manifest.json entries| E[Inject file + cssIntegrity]
    D --> F{transformIndexHtml - order:post}
    E --> F
    F -->|Local bundle URL| G[find item in bundle →\ninject integrity + crossorigin]
    F -->|External URL in KNOWN_EXTERNAL_INTEGRITY| H[Inject pinned hash]
    F -->|Other external URL| I[Leave untouched - opt-in only]
    G --> J[dist/index.html with SRI attributes]
    H --> J
    I --> J
    J --> K[Browser loads asset]
    K --> L{Digest matches integrity?}
    L -->|Yes| M[Execute / Apply]
    L -->|No| N[Block: refuses to run tampered asset]
```

## Data flow inside `vite.config.ts`

| Layer | Responsibility | Symbol |
| --- | --- | --- |
| Hash primitive | Turns bytes into `sha384-…` (or user-selected algorithms) | `computeIntegrity()` |
| Pinned third-parties | Static map of CDN URL → reviewed hash | `KNOWN_EXTERNAL_INTEGRITY` |
| Bundle resolver | Finds the emitted chunk/asset for a local URL, honouring `config.base` | `resolveIntegrity()` |
| Attribute weaver | Adds `integrity`/`crossorigin` without clobbering existing attributes | `applyIntegrityAttrs()` |
| Vite plugin | Registers `generateBundle` + `transformIndexHtml` hooks, applies only on production builds | `subresourceIntegrity()` |

## Behaviour contract

* **`apply: "build"`** — no impact on the dev server. Hashing only runs during
  `vite build`.
* **`enforce: "post"`** — runs *after* the standard HTML injection so it sees
  the final bundle URLs (hashed filenames such as `assets/index-DxY2.js`).
* **Idempotent** — existing `integrity` / `crossorigin` attributes are never
  overwritten. Attributes like `data-integrity` are preserved.
* **Conservative on externals** — third-party URLs are only touched when they
  appear in `KNOWN_EXTERNAL_INTEGRITY` or the caller passes `external: { url: hash }`.
  Unknown protocol-relative or absolute URLs are passed through unchanged so we
  never break a page by pinning a hash we did not verify.

## Adding a new external script

1. Fetch the file from the upstream origin:
   ```bash
   curl -sSL https://cdn.example.com/lib.js | openssl dgst -sha384 -binary | openssl base64 -A
   ```
2. Add the pair to `KNOWN_EXTERNAL_INTEGRITY` in `vite.config.ts` (or pass it
   via `subresourceIntegrity({ external: { … } })` at the call site).
3. Run `npm run build` and inspect `dist/index.html` — the tag should now carry
   `integrity="sha384-…" crossorigin="anonymous"`.
4. Load the built app and confirm the browser console shows no
   `Failed to find a valid digest in the 'integrity' attribute` error.

## Verification / visual proof checklist

For the PR reviewer:

* Run `npm run build`.
* Open `dist/index.html` — every `<script type="module" crossorigin src="/assets/…">`
  and `<link rel="stylesheet" crossorigin href="/assets/…">` tag must contain
  an `integrity="sha384-…"` attribute; the `https://telegram.org/js/telegram-web-app.js`
  script tag must be pinned.
* Serve `dist/` and open DevTools → Network tab, tick "Disable cache".
* Tamper with any file under `dist/assets/` (add a byte) and reload — the browser
  must refuse to execute it (red console error) and the app must not boot.
* Restore the file and reload — the app boots normally with a green Network tab.

Take a screenshot of the tamper attempt (console error + blocked resource) and
attach it to the PR — this satisfies the "📸 Visual Proof" requirement.
