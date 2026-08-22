# Octopus Energy MCP landscape research

MCP landscape checked on **14 August 2026**. EV pricing/API changes checked on **22 August 2026**.

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

From Octopus’s [REST endpoint guide](https://developer.octopus.energy/guides/rest/api-endpoints/):

- the account endpoint discovers MPAN/MPRN, serials and tariff agreements and requires the customer API key;
- product and price endpoints are public;
- consumption is half-hourly by default, paginated, and should use explicit UTC ranges;
- supported server-side consumption grouping is day, week, month or quarter;
- export MPAN data uses the same consumption shape;
- gas is kWh for SMETS1 but m3 for SMETS2;
- billing rounds interval consumption half-to-even to 0.01 kWh before multiplying by price;
- rate records contain VAT-exclusive and VAT-inclusive pence/kWh values.

The [official GraphQL documentation](https://developer.octopus.energy/graphql/) now documents authentication, smart-meter telemetry, devices, completed/planned dispatches, loyalty balance, rate-limit information and device-aware EV pricing. This server implements only named, read-only operations for those fields. It does not offer an arbitrary query tool.

## August 2026 EV pricing change

Octopus announced that Intelligent Octopus Go is moving to a dynamic four-rate model:

- home off-peak remains 23:30–05:30;
- the EV receives up to six off-peak smart-charging hours per midday-to-midday day;
- an Octopus-scheduled EV charge outside the home window can give the home the off-peak price for that half-hour while it is within the allowance; and
- EV charging beyond the allowance, or Boost charging, can use the EV peak price even while the home is off-peak.

Octopus also says billing is in half-hour chunks and that the new home/car breakdown can arrive roughly a day behind real time. Source: [Intelligent Octopus Go: Smart charging and Charge Cap explained](https://octopus.energy/blog/intelligent-octopus-go-smarter-charging-for-a-greener-grid/).

The GraphQL schema now exposes [`FourRateEvTariff`](https://developer.octopus.energy/graphql/reference/objects/fourrateevtariff/) with separate VAT-inclusive and VAT-exclusive home peak, home off-peak, EV device peak and EV device off-peak prices, plus the standing charge. The authenticated account agreement exposes this tariff union, allowing the MCP to return the prices actually attached to the account rather than a hard-coded advertised rate.

The documented [`costOfCharge`](https://developer.octopus.energy/graphql/reference/queries/costofcharge/) query accepts an account, frequency and whole-date bounds. Its records identify smart versus non-smart charging and return consumption in kWh plus costs in pence excluding and including tax. This is the safest available source for historic EV charging prices because aggregate household consumption cannot distinguish car energy or reconstruct the allowance. The MCP therefore reports any expansion from timestamp boundaries to effective whole dates, refuses to treat a subtotal as complete when any record omits a value, treats an empty array as a complete zero-charge result, and rejects a null or missing dataset as unavailable.

Octopus’s [public product catalogue](https://api.octopus.energy/v1/products/?is_business=false) on 22 August 2026 lists newer fixed Intelligent Octopus Go families including `INTELLI-FIX-OEV` and `IOG-SMB-FIX`; older `INTELLI-VAR` products predate the four-rate GraphQL model. The MCP’s conventional-tool guard is intentionally limited to known new families so it does not remove REST rate and replay support from legacy accounts.

Octopus’s [smart tariff terms](https://octopus.energy/policies/smart-tariffs-terms-and-condition/) describe Intelligent Drive Pack and Power Pack as type-of-use arrangements. Drive Pack covers Octopus-controlled EV smart charging while other usage and Boost are charged on the household tariff; Power Pack applies later credits under its own eligibility rules. Subscription fees, credits, exports and other ledger-level adjustments therefore must not be assumed to be included in individual `costOfCharge` records.

## Design response

The research directly led to these choices:

- local stdio only and a hard-coded Octopus origin;
- no hosted gateway or telemetry;
- REST for stable account/consumption/tariff work;
- a small allowlist of documented GraphQL read queries for newer features;
- conservative local throttling in addition to Octopus’s own GraphQL points system;
- explicit gas units and warnings instead of unreliable inference;
- bounded pagination and local analytics so repeated comparisons do not refetch unnecessarily;
- clear cost-estimate caveats and an exact-tariff-code interface;
- account-specific `FourRateEvTariff` prices instead of hard-coded EV advertising rates;
- Octopus-priced EV charge history for device-aware tariffs; and
- a fail-closed block on local cost replay for Intelligent Octopus Go, Drive Pack and Power Pack codes.
