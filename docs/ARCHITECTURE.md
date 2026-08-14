# Architecture

## Data flow

```text
MCP client
  │ local stdio (JSON-RPC)
  ▼
McpServer tools/resources/prompts
  │
  ├── period + meter resolution
  ├── local analytics and tariff replay
  ├── private file cache (hashed keys)
  └── shared serial request limiter
          │ HTTPS only; fixed origin
          ▼
    api.octopus.energy
      ├── /v1/... REST
      └── /v1/graphql/ named read queries
```

No component listens on a TCP port. The production clients reject any URL whose protocol/origin is not exactly `https://api.octopus.energy`, including pagination links returned by the API.

## Modules

- `config.ts`: validated environment settings and a credential-free public view.
- `cache.ts`: atomic local JSON cache, namespaces, statistics and targeted clearing.
- `rate-limiter.ts`: shared serial queue with a minimum interval and rolling-minute cap.
- `octopus-client.ts`: REST authentication, retries, safe pagination, account/meter discovery, products, consumption and rates.
- `graphql-client.ts`: in-memory token lifecycle and a fixed set of read-only operations.
- `periods.ts`: DST-aware named/custom periods in the configured timezone.
- `analytics.ts`: unit handling, data quality, usage profiles, comparison, cheapest windows and tariff cost replay.
- `server.ts`: MCP schemas, annotations, resources, prompts and privacy-safe error responses.

## Caching policy

- Account: one hour.
- Product catalogue/details: six hours.
- Historical consumption: 24 hours.
- Recent consumption: 15 minutes.
- Tariff rates: 30 minutes.
- GraphQL: 30 seconds to one hour depending on volatility.

Expired values are used only as a resilience fallback after a request fails. Cache keys can contain personal identifiers in memory but are converted to SHA-256 filenames; only response payloads and expiry metadata are written.

## Rate and size controls

One limiter is shared by REST calls, GraphQL token exchange and GraphQL queries. Every retry reacquires the limiter. Defaults are 30 attempts/minute with at least 1,000 ms between attempts. `429` and `5xx` responses retry with `Retry-After` or exponential backoff.

Pagination is capped by both pages and records per MCP call. Tools return `truncated=true` rather than silently continuing. Concurrent identical REST calls share one promise.

## Analytics boundaries

All analytics execute locally. Raw records are deduplicated and sorted. The analysis reports coverage, duplicates and gaps instead of presenting incomplete data as complete. Tariff replay uses exact product/tariff codes and published VAT-inclusive rates. Gas conversion and billing limitations remain explicit in every affected result.
