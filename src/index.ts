#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { serveHttpEndpoint } from "./http.js";
import { createServer } from "./server.js";
import { checkForUpdates, formatUpdateNotice, type UpdateStatus } from "./update-check.js";
import { CURRENT_VERSION } from "./version.js";

function unavailableUpdateStatus(error: unknown): UpdateStatus {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[octopus-energy-mcp] Version check unavailable: ${message}\n`);
  return { status: "unavailable", current_version: CURRENT_VERSION, reason: "request_failed" };
}

async function main(): Promise<void> {
  const config = loadConfig();
  let updateStatus: UpdateStatus;
  try {
    updateStatus = await checkForUpdates({
      enabled: config.updateCheckEnabled,
      currentVersion: CURRENT_VERSION
    });
  } catch (error) {
    updateStatus = unavailableUpdateStatus(error);
  }
  const updateNotice = formatUpdateNotice(updateStatus);
  if (updateNotice) {
    process.stderr.write(`${updateNotice}\n`);
  }

  const shutdown = async (close: () => Promise<void>) => {
    await close();
    process.exit(0);
  };

  if (config.transportHttp) {
    const endpoint = await serveHttpEndpoint(config, updateStatus);
    process.stderr.write(
      `[octopus-energy-mcp] HTTP transport listening on http://${endpoint.host}:${endpoint.port}/mcp (v${CURRENT_VERSION})\n`
    );
    process.once("SIGINT", () => void shutdown(endpoint.close));
    process.once("SIGTERM", () => void shutdown(endpoint.close));
    return;
  }

  const handle = serveStdio(() => createServer(config, { updateStatus }), {
    onerror: (error) => process.stderr.write(`[octopus-energy-mcp] ${error.message}\n`)
  });
  process.once("SIGINT", () => void shutdown(handle.close));
  process.once("SIGTERM", () => void shutdown(handle.close));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[octopus-energy-mcp] Startup failed: ${message}\n`);
  process.exitCode = 1;
});
