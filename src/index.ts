#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { checkForUpdates, formatUpdateNotice } from "./update-check.js";
import { CURRENT_VERSION } from "./version.js";

try {
  const config = loadConfig();
  const updateStatus = await checkForUpdates({
    enabled: config.updateCheckEnabled,
    currentVersion: CURRENT_VERSION
  });
  const updateNotice = formatUpdateNotice(updateStatus);
  if (updateNotice) {
    process.stderr.write(`${updateNotice}\n`);
  }

  const handle = serveStdio(() => createServer(config, { updateStatus }), {
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
