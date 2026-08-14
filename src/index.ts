#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

try {
  const config = loadConfig();
  const handle = serveStdio(() => createServer(config), {
    onerror: (error) => process.stderr.write(`[octopus-energy-mcp] ${error.message}\n`)
  });

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`[octopus-energy-mcp] Startup failed: ${message}\n`);
  process.exitCode = 1;
}
