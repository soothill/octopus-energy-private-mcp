# Architecture

## Data flow

```text
MCP client
  │ local stdio (JSON-RPC)
  ▼
McpServer tools/resources/prompts
  │
  ├── period + meter resolution
  ├── local analytics and conventional tariff replay
  ├── private file cache (hashed keys)
  └── shared serial request limiter
          │ HTTPS only; fixed origin
          ▼
    api.octopus.energy
      ├── /v1/... REST
      └── /v1/graphql/ named read queries

Startup only
  │ anonymous version manifest; two-second timeout; no redirects
  ▼
api.github.com
  └── public main/package.json
```

No component listens on a TCP port. The authenticated energy clients reject any URL whose protocol/origin is not exactly `https://api.octopus.energy`, including pagination links returned by the API, and do not follow HTTP redirects automatically. The independent startup update checker can make one unauthenticated request to the fixed `api.github.com` manifest URL. It sends no Octopus data, rejects redirects, bounds the response and cannot prevent startup if it fails.

## Modules

- `config.ts`: validated environment settings and a credential-free public view.
- `cache.ts`: atomic local JSON cache, namespaces, statistics and targeted clearing.
- `rate-limiter.ts`: shared serial queue with a minimum interval and rolling-minute cap.
- `octopus-client.ts`: REST authentication, retries, safe pagination, account/meter discovery, products, consumption and rates.
- `graphql-client.ts`: in-memory token lifecycle and a fixed set of read-only operations, including active four-rate EV tariff prices and Octopus-priced EV charge costs.
- `periods.ts`: DST-aware named/custom periods in the configured timezone.
- `analytics.ts`: unit handling, data quality, usage profiles, comparison, cheapest windows and tariff cost replay.
- `update-check.ts`: bounded, failure-safe semantic-version check against the public GitHub `main` manifest.
- `version.ts`: installed version sourced from the package manifest.
- `server.ts`: MCP schemas, annotations, resources, prompts and privacy-safe error responses.

## Caching policy

- Account: one hour.
- Product catalogue/details: six hours.
- Historical consumption: 24 hours.
- Recent consumption: 15 minutes.
- Tariff rates: 30 minutes.
- GraphQL: 30 seconds to one hour depending on volatility.

Expired values are used only as a resilience fallback after transient network, timeout, `429` or `5xx` failures. Permanent authentication, validation and GraphQL errors are never masked. Returned data includes cache status, stale-use and age metadata; analysis and cost tools also add warnings when stale inputs were used. Cache keys can contain personal identifiers in memory but are converted to SHA-256 filenames; only response payloads and expiry metadata are written.

## Rate and size controls

One limiter is shared by REST calls, GraphQL token exchange and GraphQL queries. Every retry reacquires the limiter. Defaults are 30 attempts/minute with at least 1,000 ms between attempts. `429` and `5xx` responses retry with `Retry-After` or exponential backoff.

Pagination is capped by both pages and records per MCP call. Tools return `truncated=true` rather than silently continuing. Concurrent identical REST calls share one promise.

## Analytics boundaries

All analytics execute locally. Raw records are deduplicated and sorted before both analysis and tariff replay. The analysis reports coverage, duplicates and gaps instead of presenting incomplete data as complete. Conventional tariff replay uses exact single-register import product/tariff codes and published VAT-inclusive rates. Two-register day/night feeds remain available for inspection but are not replayed against aggregate readings; export readings are not presented as import cost. Gas conversion and billing limitations remain explicit in every affected result.

Device-aware EV billing is intentionally a separate path. The new Intelligent Octopus Go model has four simultaneous prices—home peak/off-peak and EV peak/off-peak—and applies smart-charge scheduling and allowance rules that cannot be inferred from aggregate half-hour meter consumption. `octopus_get_ev_tariff_pricing` uses the authenticated GraphQL `account.electricityAgreements.tariff` union and only returns active `FourRateEvTariff` records. `octopus_get_ev_charge_costs` uses the documented `costOfCharge` query and returns Octopus-calculated kWh and pence totals by day, week, month or year. Because that query accepts whole dates, the response exposes both the requested period and the effective whole-date period whenever rounding was required. Aggregate values are only calculated when every returned record contains that value; otherwise the affected total is `null` and its completeness flag is false. An actual empty array produces zero totals, while a null or missing dataset is rejected as unavailable. EV charge arrays are also validated against `maxRecordsPerCall` before cache insertion or summary calculation; oversized results fail with instructions to narrow the period or frequency. Both operations are named, read-only, locally cached and use the same request limiter as all other Octopus calls.

The conventional REST rate/window tools and local cost tools reject tariff codes that indicate the new fixed/four-rate Intelligent Octopus Go, Drive Pack or Power Pack models rather than returning a plausible-looking but incomplete rate view or invalid reconstruction. Legacy `INTELLI-VAR` codes are deliberately excluded from this guard and retain their conventional REST support. Type-of-use subscription fees, credits, export benefits and other account-level adjustments are not assumed to be part of `costOfCharge`; every affected response directs the user to their Octopus statement for the definitive total.
