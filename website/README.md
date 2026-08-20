# Octopus Energy Private MCP setup website

This folder contains the public, beginner-friendly installation website for the MCP. It is intentionally separate from the MCP runtime so publishing the guide does not change its local-only security model.

Public site: <https://octopus-energy-private-mcp-guide.darren138956.chatgpt.site>

## Local development

```bash
cd website
npm ci
npm run dev
```

## Verification

```bash
npm test
npm run lint
```

`npm test` creates the production Cloudflare Worker build and checks the rendered guide, metadata, structured data, and sharing-preview asset.

The site is deployed with OpenAI Sites using `.openai/hosting.json`. It has no database, object storage, authentication, analytics, forms, or credential collection.
