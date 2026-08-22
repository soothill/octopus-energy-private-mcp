# Octopus Energy Private MCP

A privacy-first, local Model Context Protocol server for querying and analysing an Octopus Energy account. It exposes 23 read/analysis tools for meters, consumption, products, conventional tariff rates, four-rate EV pricing, Octopus-priced EV charge costs, cost replay, time-of-use patterns, smart-device telemetry, dispatches and Octoplus points.

This is an independent community project. It is not affiliated with or endorsed by Octopus Energy.

## New to MCP? Start here

You do not need coding experience to install this project. Follow the [interactive setup website](https://octopus-energy-private-mcp-guide.darren138956.chatgpt.site) or the [beginner installation guide](docs/INSTALLATION.md). Both explain every step for Mac, Windows and Linux, including where to click, what to copy, how to keep your API key private, how to connect ChatGPT desktop or Codex, and how to fix the most common problems.

After preparing the project, run `npm run setup:codex` to print the exact, secret-free connection details for your computer.

## What the research found

As of **14 August 2026**, I found no MCP server published by Octopus Energy in its official API documentation or public `octopus-energy` GitHub organisation. I did find community implementations:

- [`samaxbytez/octopus-energy-mcp`](https://github.com/samaxbytez/octopus-energy-mcp), a Node server focused on REST account, consumption, product and tariff endpoints.
- [`DanielChicot/octopus-mcp`](https://github.com/DanielChicot/octopus-mcp), a Python/PyPI server with usage and cost analysis, caching, Saving Sessions and Octoplus features.

There is also an official **Octopus Deploy** MCP, but Octopus Deploy is a separate deployment-software company and is unrelated to Octopus Energy. See [the full research note](docs/RESEARCH.md).

This implementation was built because the available projects did not combine all of the requested properties: strict outbound isolation, bounded/rate-limited API access, REST plus named read-only GraphQL operations, detailed local analytics, transparent gas-unit handling, Docker, and an MCP integration test suite.

## Privacy and safety by design

- Runs as a local stdio process; it does not listen on a network port.
- Restricts authenticated energy requests to `https://api.octopus.energy` and disables automatic HTTP redirects.
- Sends the API key only to Octopus: REST uses Basic authentication; GraphQL exchanges it for a short-lived token held only in memory.
- Has no telemetry or analytics service. A separate anonymous startup check reads the public package version from `api.github.com`, sends no Octopus credentials or energy data, rejects redirects, times out after two seconds, and can be disabled.
- Stores repeatable responses only in a local cache with hashed filenames, a private directory and private files.
- Omits addresses from the account tool unless `include_addresses=true` is explicitly supplied.
- Exposes only named, read-only Octopus operations. There is no arbitrary URL or arbitrary GraphQL tool.
- Queues requests, waits at least one second by default, caps calls at 30 requests/minute, follows `Retry-After`, backs off on transient failures, coalesces duplicate in-flight requests, and limits pagination/records per tool call.
- Uses expired cache data only after transient failures and labels it with cache status, age and analysis warnings.
- Marks every remote tool read-only. The only destructive tool clears local cache files and requires `confirm=true`.

Read [SECURITY.md](SECURITY.md) for the threat model and credential-handling details.

## Quick start

Requirements: Node.js 22 or newer, an Octopus Energy API key, and your account number.

If terms such as Terminal, Node.js, or `.env` are unfamiliar, use the [plain-English beginner guide](docs/INSTALLATION.md) instead of this condensed section.

```bash
git clone https://github.com/soothill/octopus-energy-private-mcp.git
cd octopus-energy-private-mcp
npm ci
cp .env.example .env
# Edit .env with OCTOPUS_API_KEY and OCTOPUS_ACCOUNT_NUMBER
npm run build
npm start
```

The process waits for MCP messages on stdin, so a quiet-looking terminal is expected. It never prints protocol data or secrets to ordinary logs. If a newer version is available, it prints a safe update notice and supplies the same instructions to the connected MCP client.

Your API key is available in the Octopus account dashboard under Personal details → Developer settings. Public product and tariff tools work without a key; account and consumption tools need both variables.

## Add it to Codex or ChatGPT desktop

The safest Codex setup forwards credentials already present in your local environment instead of copying their values into `config.toml`:

```toml
[mcp_servers.octopus_energy]
command = "node"
args = ["/absolute/path/to/octopus-energy-private-mcp/dist/index.js"]
env_vars = ["OCTOPUS_API_KEY", "OCTOPUS_ACCOUNT_NUMBER", "OCTOPUS_TIMEZONE"]
startup_timeout_sec = 20
tool_timeout_sec = 120
required = false
```

Export `OCTOPUS_API_KEY` and `OCTOPUS_ACCOUNT_NUMBER` in the environment that launches Codex, add the table to `~/.codex/config.toml`, then restart. In ChatGPT desktop you can instead open **Settings → MCP servers → Add server**, select **STDIO**, and enter the same `node` command and absolute script path. The current [official OpenAI MCP setup documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) confirms that the desktop app, CLI and IDE extension share this configuration.

You can also use the CLI, although `--env` values are persisted in local configuration:

```bash
codex mcp add octopus-energy \
  --env OCTOPUS_API_KEY=sk_live_replace_me \
  --env OCTOPUS_ACCOUNT_NUMBER=A-REPLACE_ME \
  -- node /absolute/path/to/octopus-energy-private-mcp/dist/index.js
```

Use `/mcp` or `codex mcp list` to verify the connection.

## Docker option

Build and run locally:

```bash
cp .env.example .env
# Edit .env
docker compose build
docker compose run --rm --no-TTY octopus-energy-mcp
```

For an MCP client that already receives the credentials in its environment:

```json
{
  "mcpServers": {
    "octopus-energy": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env", "OCTOPUS_API_KEY",
        "--env", "OCTOPUS_ACCOUNT_NUMBER",
        "--env", "OCTOPUS_TIMEZONE",
        "--volume", "octopus-energy-cache:/data/cache",
        "octopus-energy-private-mcp:local"
      ]
    }
  }
}
```

The image runs as an unprivileged user and persists only the cache volume. Docker is optional; the direct Node path is simpler and starts faster.

## Typical questions

- “Analyse my electricity usage over the last 30 days and show peak times and data gaps.”
- “Compare this month with the immediately preceding equivalent period.”
- “Find the ten cheapest two-hour windows on my Agile tariff tomorrow.”
- “Replay last month’s actual use against these three exact tariff codes.”
- “Show the four rates on my new Intelligent Octopus Go tariff.”
- “How much energy and money did Octopus record for my smart and boost EV charging last month?”
- “Show my current import and export meters and their active agreements.”
- “What smart devices does Octopus know about, and what dispatches are planned?”
- “How many Octoplus points do I have?”
- “Show Octopus’s GraphQL quota status and the local request queue.”

## Tools

| Area | Tools |
|---|---|
| Setup | `octopus_connection_status`, `octopus_discover_meters`, `octopus_get_account` |
| Products | `octopus_list_products`, `octopus_get_product` |
| Consumption | `octopus_get_consumption`, `octopus_analyse_usage`, `octopus_compare_usage` |
| Tariffs | `octopus_get_tariff_rates`, `octopus_get_current_rates`, `octopus_find_cheapest_windows`, `octopus_estimate_cost`, `octopus_compare_tariffs` |
| EV pricing | `octopus_get_ev_tariff_pricing`, `octopus_get_ev_charge_costs` |
| Smart devices | `octopus_get_smart_flex_devices`, `octopus_get_smart_meter_devices`, `octopus_get_smart_meter_telemetry`, `octopus_get_completed_dispatches`, `octopus_get_planned_dispatches` |
| Octoplus/limits | `octopus_get_octoplus_balance`, `octopus_get_api_rate_limits` |
| Local maintenance | `octopus_clear_cache` |

The server also publishes two resources (`octopus://server/configuration` and `octopus://help/capabilities`) and two reusable prompts for usage analysis and tariff comparison.

### Periods and meters

Tools accept `today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `last_7_days`, `last_30_days`, `this_year`, or `last_year`. You can instead provide both `period_from` and `period_to` as ISO timestamps or dates. Date-only end values are inclusive; timestamp ends are exclusive. Timestamps without an explicit offset use `OCTOPUS_TIMEZONE`; timestamps with `Z` or another offset preserve it.

Meter details are auto-discovered. If more than one meter matches, provide a fuel, direction, property ID, MPAN/MPRN (`meter_point`) or serial number. The server fails with a useful list instead of silently choosing the wrong meter.

### Gas units

Octopus documents that SMETS1 gas consumption is returned in kWh while SMETS2 is returned in m3. The response itself does not safely identify which applies. The default `auto` mode therefore preserves the number, marks the unit unknown and refuses cost calculations. Set `OCTOPUS_GAS_CONSUMPTION_UNIT=kwh` or `m3` only after confirming your meter’s output.

For m3, the default 11.184 kWh/m3 conversion is an estimate. Real bills use a volume correction and the period’s calorific value, so gas cost results are deliberately labelled estimates.

### Cost caveats

Cost tools match each consumption interval to published VAT-inclusive rates, round interval consumption half-to-even to 0.01 kWh as documented by Octopus, and add the applicable daily standing charge. They do not reproduce discounts, credits, export payments, debt, taxes outside the published rate, special eligibility rules, meter-specific gas calorific values or Octopus’s complete billing engine. Results are comparisons and estimates, not quotes or bills.

Two-register electricity tariffs expose separate day and night feeds through the rate tools. Cost replay rejects those tariffs because aggregate half-hour consumption does not identify the billed register. Export meters are also rejected by cost tools because their readings represent tariff revenue rather than import cost. Cheapest-window analysis accepts only finite, contiguous 30-minute rate records.

The newer Intelligent Octopus Go model separates home peak, home off-peak, EV peak and EV off-peak prices. It can price the home and car differently in the same half-hour and applies an EV smart-charge allowance, so aggregate smart-meter readings cannot reproduce the bill. `octopus_get_ev_tariff_pricing` reads the active account-specific four-rate tariff directly from Octopus GraphQL. `octopus_get_ev_charge_costs` reads Octopus-calculated EV consumption and cost records, split between smart and non-smart charging, for a chosen period. Octopus accepts whole dates for this charge history, so a rolling or timestamp period is expanded to the whole local dates that cover it; the response shows both the requested and effective periods. If any returned charge record lacks a consumption or cost value, the affected aggregate is `null` and marked incomplete instead of presenting a partial subtotal; a complete empty list correctly returns zero totals, while an unavailable (`null`) Octopus dataset produces an error. The result is validated against `OCTOPUS_MAX_RECORDS_PER_CALL` before it can be cached or summarized; request a shorter period or weekly/monthly frequency if the limit is exceeded. Conventional REST rate/window tools and local tariff replay deliberately reject known four-rate Intelligent Octopus Go, Drive Pack and Power Pack codes and direct the caller to these account-aware tools. Legacy `INTELLI-VAR` tariffs remain supported by the conventional REST tools.

Under Octopus’s published rollout rules, the home normally receives its off-peak price from 23:30–05:30, while the EV receives up to six actual smart-charging hours per midday-to-midday day. Octopus-scheduled charging outside the home window can also make the home off-peak for that half-hour; charging beyond the allowance or using Boost can move the EV to its peak price. See Octopus’s [four-rate and Charge Cap explanation](https://octopus.energy/blog/intelligent-octopus-go-smarter-charging-for-a-greener-grid/). Drive Pack and Power Pack are type-of-use arrangements whose subscription, credits or other account-level adjustments may be separate from the returned charge records; see the [smart tariff terms](https://octopus.energy/policies/smart-tariffs-terms-and-condition/). The Octopus app and statement remain definitive.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `OCTOPUS_API_KEY` | — | API key; needed for private data |
| `OCTOPUS_ACCOUNT_NUMBER` | — | Default `A-...` account |
| `OCTOPUS_TIMEZONE` | `Europe/London` | Local period and analysis timezone |
| `OCTOPUS_SMART_METER_DEVICE_ID` | — | Optional GraphQL telemetry device |
| `OCTOPUS_SMART_FLEX_DEVICE_ID` | — | Optional planned-dispatch device |
| `OCTOPUS_CACHE_ENABLED` | `true` | Enable local response cache |
| `OCTOPUS_CACHE_DIR` | platform user cache | Override private cache path |
| `OCTOPUS_UPDATE_CHECK_ENABLED` | `true` | Check the public GitHub `main` version at startup |
| `OCTOPUS_REQUESTS_PER_MINUTE` | `30` | Conservative local rolling cap, 1–120 |
| `OCTOPUS_MIN_REQUEST_INTERVAL_MS` | `1000` | Minimum spacing between API attempts |
| `OCTOPUS_REQUEST_TIMEOUT_MS` | `20000` | Per-attempt timeout |
| `OCTOPUS_MAX_RETRIES` | `3` | Transient retry count |
| `OCTOPUS_PAGE_SIZE` | `1500` | Consumption records requested per page |
| `OCTOPUS_MAX_PAGES_PER_CALL` | `25` | Pagination safety limit |
| `OCTOPUS_MAX_RECORDS_PER_CALL` | `25000` | Result safety limit |
| `OCTOPUS_GAS_CONSUMPTION_UNIT` | `auto` | `auto`, `kwh`, or `m3` |
| `OCTOPUS_GAS_M3_TO_KWH_FACTOR` | `11.184` | Explicit estimated conversion factor |

## API behaviour and limits

The implementation follows Octopus’s [REST endpoint guide](https://developer.octopus.energy/guides/rest/api-endpoints/) for account discovery, products, half-hourly consumption, pagination, timezones, gas units and prices. Smart-device and device-aware EV pricing features use named queries from the official [GraphQL documentation](https://developer.octopus.energy/graphql/), including the documented [`FourRateEvTariff`](https://developer.octopus.energy/graphql/reference/objects/fourrateevtariff/) and [`costOfCharge`](https://developer.octopus.energy/graphql/reference/queries/costofcharge/) fields.

Octopus does not publish one simple REST request-per-minute limit in the REST guide, so the server uses a deliberately conservative configurable local cap. GraphQL has a points-based allowance and field-specific limits; `octopus_get_api_rate_limits` reports both the live Octopus status and local queue. Reducing local limits is safe. Increasing them can cause longer Octopus throttles and is capped by configuration validation.

## Automatic version check

At startup, the MCP anonymously reads `package.json` from this repository’s public `main` branch and compares its semantic version with the installed version. The request goes only to `api.github.com`, includes the installed version in a generic user-agent, and never includes an Octopus API key, account number, energy result, cache entry or other private value. Redirects are rejected and the check is abandoned after two seconds, so a GitHub or network failure never prevents the MCP from starting.

When a newer version exists, the MCP adds a prominent notice to its startup instructions, writes the same secret-free notice to the local error/log channel, and reports it through `octopus_connection_status`. The notice includes separate Git and ZIP update steps plus a link to the [beginner update guide](docs/INSTALLATION.md#updating-later).

Set `OCTOPUS_UPDATE_CHECK_ENABLED=false` in `.env` to disable all startup contact with GitHub. Future releases must update the version in `package.json` for the comparison to detect them.

## Development

```bash
npm ci
npm run check
```

`npm run check` performs strict type checking, the unit/integration suite, an in-memory MCP handshake/tool call, a compiled stdio process smoke test, and a production build. CI also audits dependencies and builds the Dockerfile. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT
