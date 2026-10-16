# Octopus → InfluxDB battery poller

A Dockerized poller that records Octopus Agile **import and export prices** (day-ahead and history), half-hourly **consumption/export readings**, matched **costs/revenues**, and a **battery arbitrage signal** into an InfluxDB 2.x bucket. It supports multiple houses (sites), each with its own Octopus API key and account.

## What it writes to InfluxDB

| Measurement | Tags | Fields | Meaning |
|---|---|---|---|
| `octopus_price` | `site`, `direction` (import/export), `tariff_code`, `source` (tariff/intelligent/market) | `value_inc_vat`, `value_exc_vat` | Half-hourly rates, timestamped at `valid_from`. Covers history (backfill) and day-ahead. For Intelligent Octopus (IOG) sites the half-hours are synthesised from the day/night unit-rate feeds (`source=intelligent`). With `source=market`, day-ahead Agile import/export, Outgoing Octopus and Prime Outgoing Fixed prices for the site's region (letter derived from its tariff code, e.g. F=Yorkshire, B=Eastern) are stored for tariff comparison — all normalised to half-hourly points, so dual-rate tariffs (Prime Outgoing day 9p / evening 16p) and flat tariffs align 1:1 with Agile. |
| `octopus_consumption` | `site`, `direction`, `mpan` | `kwh` | Half-hourly import/export readings from the smart meter. |
| `octopus_cost` | `site`, `direction` | `kwh`, `rate_inc_vat`, `cost_inc_vat_pence` / `revenue_inc_vat_pence` | Each interval matched to its rate (Octopus half-to-even 0.01 kWh rounding). |
| `octopus_battery_signal` | `site`, `action` (export/import) | `import_pence`, `export_pence`, `spread_pence` | Per future half-hour: `spread = export − import`. Positive spread ⇒ discharge/export beats charging. |
| `octopus_battery_plan` | `site`, `day`, `action` | summary: `cycle_a_enabled`, `grid_charge_kwh`, `grid_charge_cost_pence`, `morning_export_kwh`, `morning_revenue_pence`, `solar_refill_kwh`, `evening_export_kwh`, `evening_revenue_pence`, `reserve_kwh`, `reserve_value_pence`, `expected_profit_pence`; per-slot: `kwh`, `soc_after` (kWh), `import_pence`, `export_pence` | Day-ahead two-cycle schedule for battery sites (`BATTERY_PLAN_SITES`), timestamped at each half-hour. `action` is one of `grid_charge` (cheap window, e.g. Go 7p), `discharge_morning`, `solar_refill` (assumed free), `discharge_evening` (down to the reserve), `reserve` (drains 19:00–23:00), plus one `summary` point per day. The legacy tariff-spread summary (`action` absent) is still written from the site's own rates. |
| `octopus_intelligent_dispatch` | `site`, `device_id`, `device_type`, `status` (planned/completed), `dispatch_type` | `energy_kwh`, `duration_minutes` | Intelligent Octopus (SmartFlex) dispatch windows from the Kraken GraphQL API: planned slots per device (~24h ahead) and completed slots for the account (~12h behind). |
| `octopus_poll_status` | `site`, `task` | `ok`, `records` | Liveness marker per poll. |
| `octopus_tariff_report` | `site`, `day` | `gain_current_pence`, `gain_go_var_pence`, `gain_go_agile_pence`, `gain_go_prime_pence`, `gain_agile_agile_pence`, `gain_go_agile_opt_pence`, `uplift_opt_pence`, `pv_kwh`, `export_kwh`, `import_kwh` | Daily tariff-comparison replay (see "Daily tariff report"). One point per day; positive gain = money earned. The emailed report's 7-day / 30-day / all-time totals are column sums over the window. |
| `sma_pv` | `site` | `power_kw` (15-min average), `energy_kwh` (slot energy = power × 0.25 h) | Newport Pagnell PV generation from Sunny Portal (see "Sunny Portal"). Points are timestamped at the 15-minute slot start (true UTC) and rewritten idempotently each poll. |

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

## Day-ahead battery planner

For sites listed in `BATTERY_PLAN_SITES`, the poller also builds a concrete two-cycle schedule from the day-ahead **market** prices (Agile import + Agile export products), modelling a cheap fixed-rate night tariff (e.g. Octopus Go 7p 00:30–05:30) even if the site is not yet on it:

1. **`grid_charge`** — charge from grid in the cheapest slots of `BATTERY_CHEAP_IMPORT_WINDOW` until full (skipped entirely if the morning peak doesn't pay for it).
2. **`discharge_morning`** — export the best-priced morning half-hours (06:00–09:30).
3. **`solar_refill`** — solar refills the battery through the day (assumed free; no midday exporting).
4. **`discharge_evening`** — dump into the best evening half-hours (16:00–19:00) **down to `BATTERY_RESERVE_KWH`**, not to empty.
5. **`reserve`** — the held-back kWh drains across 19:00–23:00 to cover house load until the next cheap window starts (valued as avoided import).

Power limits (`BATTERY_CHARGE_KW`/`BATTERY_DISCHARGE_KW`) and round-trip efficiency (`BATTERY_EFFICIENCY`) are enforced per half-hour; SOC starts and ends the day empty (steady state). The `summary` point carries `expected_profit_pence` for the plan. Mirror the windows in the inverter's TOU schedule, or feed the points to an automation.

## Daily tariff report

When `REPORT_ENABLED=true`, each morning at `REPORT_TIME` (UK) the poller emails an HTML report for the previous day (site `REPORT_SITE`) that replays the day's **actual** import/export profile (from the Sigenergy telemetry bucket) under every tariff combination:

- current tariff (no export deal)
- Go import + Outgoing VAR / Agile / Prime export
- Agile import + Agile export
- **Go + Agile + optimised battery** — the same day replayed with the battery strategy: grid-charge overnight in the Go cheap window → export into the highest morning rates → solar refills through midday → export most of it 16:00–19:00 → hold back the reserve to cover evening load until the cheap window restarts. Each cycle only counts when profitable on the day's actual prices.

Standing charges are fetched live from the Octopus API (including the current tariff's daily standing charge). Figures use a money-flow sign convention — export revenue positive, import cost and standing charges negative, so the net-gain column reads directly as profit or loss. Each day's figures are stored as `octopus_tariff_report` points and the email shows **last-7-day, last-30-day and all-time** net-gain totals so weekly and monthly averages build up from real data. Mail goes through the LAN SMTP relay (`REPORT_SMTP_HOST`, e.g. yorkstorj's postfix relaying via Gmail). A day is only marked sent after the email leaves, so restarts never double-send (pass `force` to `runDailyReport` to re-send). Failed sends retry after a 10-minute backoff instead of skipping the day.

When `sma_pv` data exists, the email also carries a **Newport PV section**: yesterday's generation, peak power and time, the previous 7-day average and a daily strip for the last week (the day's kWh also appears in the subject line).

## Sunny Portal (Newport PV)

The Newport inverter (SB3000TL-20, Webconnect 1.0) has no local API and its Home Manager 1.0 has been retired from SMA's cloud, so generation is read from **Sunny Portal** (`SMA_ENABLED=true`):

1. The poller logs in headlessly with `SMA_USERNAME`/`SMA_PASSWORD` (the sunnyportal.com SMA ID): Keycloak login form → OAuth code → the portal's `Start.aspx` auto-post dance.
2. Every `SMA_POLL_INTERVAL_MINUTES` it renders the Analysis day chart (`presetting=day`) and reads the JSON data points (`mode=last_info`), writing them to `sma_pv` tagged `site=SMA_SITE`.
3. Session expiry is detected on the API response and re-login happens on the next cycle.

Chart timestamps are plant wall-clock values and are re-zoned via `POLLER_TIMEZONE`. Expect a **1–3 h lag**: the legacy Webconnect card uploads in bursts, and the portal only exposes 15-minute averages (no live power). Grid import/export are not available (dead Home Manager) — PV only.

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

- Outbound calls go to `https://api.octopus.energy` (Octopus API keys are sent only there, Basic auth) and, when the Sunny Portal module is enabled, `https://www.sunnyportal.com` + `https://login.sma.energy` (SMA ID credentials sent only to the Keycloak login form).
- Per-site sequential throttle (default ≥1 s between calls) with retry/backoff on 429/5xx.
- Export MPANs report exported kWh as "consumption" per Octopus docs; the poller labels them `direction=export`.
- If a site has no export meter, export prices and the signal are skipped with a log line.
