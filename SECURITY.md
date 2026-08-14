# Security policy

## Supported versions

Security fixes are applied to the latest release and the default branch.

## Credential boundary

The production server has exactly one permitted outbound origin: `https://api.octopus.energy`.

- REST account and consumption requests use the API key as the Basic-auth username with a blank password, as Octopus specifies.
- GraphQL authentication sends the key in the `obtainKrakenToken` mutation. The returned JWT is kept only in process memory and renewed before expiry.
- Neither credential is used in cache keys, filenames, MCP responses or logs.
- API errors are sanitised to replace any accidental API-key echo with `[REDACTED]`.
- The server has no telemetry, crash reporter or arbitrary HTTP/GraphQL execution tool.

Environment variables and `.env` are still local secret storage. Keep `.env` mode-restricted, never commit it, and prefer your operating system’s secret mechanism or inherited environment where practical. Anyone who can inspect the MCP host process may be able to inspect its environment.

## Local data

Account and consumption responses can be sensitive. The optional cache uses:

- a user-local cache directory created with mode `0700`;
- SHA-256 filenames that do not expose account IDs, meter IDs or URLs;
- cache files created with mode `0600`;
- atomic replacement;
- no credential values in the stored envelope.

The `octopus_clear_cache` MCP tool deletes only JSON entries inside the configured cache directory and requires `confirm=true`. Disable caching entirely with `OCTOPUS_CACHE_ENABLED=false`.

## Threat model and non-goals

This project protects against accidental credential forwarding, arbitrary-URL prompt injection, unbounded API pagination, ordinary transient failures and accidental cache-name disclosure. It does not protect a compromised local user account, malicious Node runtime/dependency, compromised container host, or a compromised Octopus Energy endpoint.

The server is intentionally stdio-only. Do not wrap it in a public HTTP endpoint without adding authentication, origin checks, transport security, per-user isolation and a separate security review.

## Reporting a vulnerability

Please use GitHub’s private vulnerability reporting for this repository. Do not include a real Octopus API key, account number, address, MPAN, MPRN, serial number or consumption trace in an issue or proof of concept. Revoke any exposed key in the Octopus dashboard.
