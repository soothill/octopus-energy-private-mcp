# Octopus Energy MCP landscape research

Checked on **14 August 2026**.

## Conclusion

No official Octopus Energy MCP was found in:

- the [official REST documentation](https://developer.octopus.energy/rest/);
- the [official GraphQL documentation](https://developer.octopus.energy/graphql/);
- public repository search within the [`octopus-energy`](https://github.com/octopus-energy) GitHub organisation.

That is an evidence-bounded “not found”, not proof that no private, experimental or later implementation exists.

Searches can be confused by the official [Octopus Deploy MCP](https://octopus.com/docs/octopus-ai/mcp). Octopus Deploy is unrelated to the UK energy supplier.

## Community projects found

| Project | Snapshot | Strengths | Gaps relevant to this project |
|---|---|---|---|
| [`samaxbytez/octopus-energy-mcp`](https://github.com/samaxbytez/octopus-energy-mcp) / npm `octopus-energy-mcp` | TypeScript; created February 2026; 4 commits when checked | Simple `npx` install, account auto-discovery, REST products/consumption/rates including dual-register rate feeds | No local usage-pattern engine, cost replay, explicit request queue/cache controls, GraphQL smart-device operations, Docker or documented outbound URL allowlist |
| [`DanielChicot/octopus-mcp`](https://github.com/DanielChicot/octopus-mcp) / PyPI `octopus-mcp` | Python; updated April 2026 | Keychain setup, SQLite cache, cost/tariff analysis, Saving Sessions, Octoplus, Claude plugin | README lists gas m3 normalisation and region-aware comparison as known limitations; exposes an arbitrary `kraken_query` escape hatch; no Docker path documented in the checked README |
| Pipeworx/Glama Octopus Energy connector | Hosted connector listing checked August 2026 | Public products and tariff data without account credentials | Hosted third-party path with incomplete account/meter coverage; incompatible with the requirement that private data go only to Octopus |

The npm and PyPI projects are independent community work and have zero GitHub stars as of the check date; star count is not a security or quality verdict.

## Official API facts used in the implementation

From Octopus’s [REST endpoint guide](https://docs.octopus.energy/rest/guides/endpoints/):

- the account endpoint discovers MPAN/MPRN, serials and tariff agreements and requires the customer API key;
- product and price endpoints are public;
- consumption is half-hourly by default, paginated, and should use explicit UTC ranges;
- supported server-side consumption grouping is day, week, month or quarter;
- export MPAN data uses the same consumption shape;
- gas is kWh for SMETS1 but m3 for SMETS2;
- billing rounds interval consumption half-to-even to 0.01 kWh before multiplying by price;
- rate records contain VAT-exclusive and VAT-inclusive pence/kWh values.

The [official GraphQL documentation](https://developer.octopus.energy/graphql/) now documents authentication, smart-meter telemetry, devices, completed/planned dispatches, loyalty balance and rate-limit information. This server implements only named, read-only operations for those fields. It does not offer an arbitrary query tool.

## Design response

The research directly led to these choices:

- local stdio only and a hard-coded Octopus origin;
- no hosted gateway or telemetry;
- REST for stable account/consumption/tariff work;
- a small allowlist of documented GraphQL read queries for newer features;
- conservative local throttling in addition to Octopus’s own GraphQL points system;
- explicit gas units and warnings instead of unreliable inference;
- bounded pagination and local analytics so repeated comparisons do not refetch unnecessarily;
- clear cost-estimate caveats and an exact-tariff-code interface.
