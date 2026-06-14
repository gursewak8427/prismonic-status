# prismonic-status

Cloudflare Worker behind [`status.prismonic.com`](https://status.prismonic.com).

- Runs health checks against every public Prismonic surface (V2 + V3 APIs, storefronts, admin panels, Bani Bot catalogue, radio streams) every **5 minutes**.
- Stores per-tick results in Cloudflare KV (`PRISMONIC_STATUS` namespace) with a **7-day** retention.
- Renders a branded uptime page with daily bar graphs.
- Diffs against the previous tick — on any UP↔DOWN flip, POSTs a batched payload to the V3 backend (`/api/v1/internal/status-alert`) which fans out an HTML email to operations.

## Architecture

```
                      ┌────────────────────────────────────────┐
                      │  Cloudflare Worker (prismonic-status)  │
                      │  fetch()  → render page                │
                      │  scheduled() → cron every 5 min        │
                      └─────────────┬──────────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
      [ KV namespace ]    [ Prismonic endpoints ]    [ V3 backend ]
      h:* history          api.v3, prismonic.com,    /internal/status-alert
      state:last           admin, radio, ...         → nodemailer → Gmail
```

Public site is `https://status.prismonic.com/`. JSON API at `/api/status`.

## Local dev

```sh
npm install
npm run dev          # wrangler dev, runs at http://127.0.0.1:8787
npm run deploy       # only used by CI; locally just push to main
```

## Deploy

**Don't deploy manually.** Pushing to `main` triggers `.github/workflows/deploy.yml`, which runs `wrangler deploy`.

### Required GitHub secrets

| Name | What |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with `Workers Scripts:Edit`, `Workers KV Storage:Edit`, `User Details:Read` |
| `CLOUDFLARE_ACCOUNT_ID` | `647016b1b69d44f514eca0ae66d71bf1` |

Set once: `gh secret set CLOUDFLARE_API_TOKEN -b "..."` and `gh secret set CLOUDFLARE_ACCOUNT_ID -b "..."`.

### Worker secrets (kept out of git)

Set via the Cloudflare dashboard or `wrangler secret put`:

| Name | What |
|---|---|
| `ALERT_ENDPOINT` | `https://api.v3.prismonic.com/api/v1/internal/status-alert` |
| `ALERT_SECRET` | Shared with the V3 backend's `STATUS_ALERT_SECRET` env. Rotating either side flips alerts off cleanly. |

They survive subsequent `wrangler deploy` calls — you only set them once.

## Adding / removing a check

Edit `SERVICES` in `src/worker.js`. Each entry:

```js
{
  id: "unique-id",
  group: "Backend | Bani Bot | Web | Radio | ...",
  name: "Friendly Name",
  desc: "Subtitle shown on the page",
  url: "https://...",
  check: "status-200" | "json-success" | "audio-mpeg",
}
```

Commit + push → CI deploys → next cron tick (≤ 5 min) the new service appears with `Collecting data…` and starts accumulating history.

## Changing cadence

Cron is in `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

Cron expression is standard 5-field. Page also adapts its copy + meta-refresh based on the `TICK_MINUTES` constant in `src/worker.js` — keep both in sync.
