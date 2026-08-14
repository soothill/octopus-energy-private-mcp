# Contributing

Contributions are welcome, especially tests against documented Octopus schema changes.

## Local checks

```bash
npm ci
npm run check
npm audit --audit-level=high
```

Node.js 22 or newer is required. Tests must use fake responses; never commit or print real API keys, accounts, addresses, meter identifiers or consumption.

## Design rules

- Preserve the single-origin outbound allowlist.
- Do not add arbitrary URL fetchers or arbitrary GraphQL execution tools.
- Keep remote operations read-only unless a future change has a separate threat model and explicit opt-in.
- Route all Octopus attempts through the shared limiter and bound every pagination path.
- Keep credentials out of cache keys, cache payloads, logs, exceptions and fixtures.
- Add tests for schema changes, unit rules, retry behaviour and MCP registration.
- Use exact dependencies and commit `package-lock.json`.

Open an issue before adding a large feature or any operation that changes an Octopus account/device.
