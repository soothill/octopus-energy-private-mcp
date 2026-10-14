# Octopus → InfluxDB battery poller

A Dockerized poller that records Octopus Agile **import and export prices** (day-ahead and history), half-hourly **consumption/export readings**, matched **costs/revenues**, and a **battery arbitrage signal** into an InfluxDB 2.x bucket. It supports multiple houses (sites), each with its own Octopus API key and account.

## What it writes to InfluxDB

| Measurement | Tags | Fields | Meaning |
|---|---|---|---|
| `octopus_price` | `site`, `direction` (import/export), `tariff_code`, `source` (tariff/intelligent/market) | `value_inc_vat`, `value_exc_vat` | Half-hourly rates, timestamped at `valid_from`. Covers history (backfill) and day-ahead. For Intelligent Octopus (IOG) sites the half-hours are synthesised from the day/night unit-rate feeds (`source=intelligent`). With `source=market`, day-ahead Agile import/export, Outgoing Octopus and Prime Outgoing Fixed prices for the site's region (letter derived from its tariff code, e.g. F=Yorkshire, B=Eastern) are stored for tariff comparison — all normalised to half-hourly points, so dual-rate tariffs (Prime Outgoing day 9p / evening 16p) and flat tariffs align 1:1 with Agile. |
| `octopus_consumption` | `site`, `direction`, `mpan` | `kwh` | Half-hourly import/export readings from the smart meter. |
| `octopus_cost` | `site`, `direction` | `kwh`, `rate_inc_vat`, `cost_inc_vat_pence` / `revenue_inc_vat_pence` | Each interval matched to its rate (Octopus half-to-even 0.01 kWh rounding). |
| `octopus_battery_signal` | `site`, `action` (export/import) | `import_pence`, `export_pence`, `spread_pence` | Per future half-hour: `spread = export − import`. Positive spread ⇒ discharge/export beats charging. |
| `octopus_battery_plan` | `site`, `day` | `profitable_export_half_hours`, `potential_margin_p_per_kwh`, `best_export_1..4_unix`, `cheapest_import_1..4_unix`, `min_import_pence`, `max_export_pence` | Daily arbitrage summary for the forward window. |
| `octopus_intelligent_dispatch` | `site`, `device_id`, `device_type`, `status` (planned/completed), `dispatch_type` | `energy_kwh`, `duration_minutes` | Intelligent Octopus (SmartFlex) dispatch windows from the Kraken GraphQL API: planned slots per device (~24h ahead) and completed slots for the account (~12h behind). |
| `octopus_poll_status` | `site`, `task` | `ok`, `records` | Liveness marker per poll. |

## Intelligent Octopus (IOG) sites

IOG tariffs publish nothing on the standard REST rate feeds. For sites whose import tariff contains `IOG`, the poller automatically:

1. **Synthesises half-hourly prices** from the tariff's `day-unit-rates` / `night-unit-rates` feeds — the off-peak window (23:30–05:30 local) gets the night rate, everything else the day rate — and writes them to `octopus_price` with `source=intelligent`. Costs are matched against these rates like any other tariff.
2. **Logs SmartFlex dispatch windows** via the Kraken GraphQL API (`api.oegb-kraken.energy`): the API key is exchanged for a short-lived JWT, then `flexPlannedDispatches` (per device, ~24h ahead) and `completedDispatches` (per account, ~12h behind) are written to `octopus_intelligent_dispatch`.

No extra configuration is needed — detection is by tariff code.

## How the arbitrage signal works

Agile publishes next-day half-hourly import prices (~16:00–20:00) and the Agile export tariff publishes matching export rates. For every future half-hour the poller stores `spread_pence = export_inc_vat − import_inc_vat`:

- **spread > 0** → exporting stored battery energy earns more than importing costs → tag `action=export`.
- **spread ≤ 0** → cheaper to hold/import → tag `action=import`.

`octopus_battery_plan` ranks the best export half-hours and cheapest import half-hours for the day so you (or a downstream automation) can schedule charge/discharge windows.

## Configure

```bash
cd poller
cp .env.example .env
# edit .env: site keys/accounts, INFLUX_URL/TOKEN/ORG/BUCKET
```

InfluxDB 2.x: create a bucket (e.g. `octopus`), copy an API token, set `INFLUX_ORG`. If the poller and InfluxDB containers share a docker network, `INFLUX_URL=http://<influx-container-name>:8086`; otherwise use the Proxmox host address.

## Run

```bash
docker compose up -d --build
docker logs -f octopus-influx-poller
```

First run backfills `POLL_BACKFILL_DAYS` of history; afterwards it polls prices every 30 min and consumption every 15 min (configurable).

Local one-shot without Docker:

```bash
npm ci && npm run build && cp .env.example .env && node --env-file=.env dist/index.js --once
```

## Example InfluxQL / Flux checks

```flux
from(bucket: "octopus")
  |> range(start: -2d)
  |> filter(fn: (r) => r._measurement == "octopus_battery_signal" and r._field == "spread_pence")
```

```sql
SELECT mean("spread_pence") FROM "octopus_battery_signal" WHERE time > now() - 7d GROUP BY "site", time(1d)
```

## Design notes

- Outbound calls are restricted to `https://api.octopus.energy`; API keys are sent only there (Basic auth). No arbitrary URLs.
- Per-site sequential throttle (default ≥1 s between calls) with retry/backoff on 429/5xx.
- Export MPANs report exported kWh as "consumption" per Octopus docs; the poller labels them `direction=export`.
- If a site has no export meter, export prices and the signal are skipped with a log line.
