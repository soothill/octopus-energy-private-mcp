import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveHttpEndpoint } from "../src/http.js";
import { testConfig } from "./helpers.js";

let storageDir: string;

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "octopus-http-"));
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

async function startServer(token?: string) {
  const config = testConfig({
    cacheDir: storageDir,
    historyEnabled: false,
    updateCheckEnabled: false,
    httpPort: 0,
    httpHost: "127.0.0.1",
    httpToken: token
  });
  const endpoint = await serveHttpEndpoint(config);
  return { endpoint, url: `http://127.0.0.1:${endpoint.port}/mcp`, root: `http://127.0.0.1:${endpoint.port}/` };
}

async function mcpPost(url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json: any = null;
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const dataLine = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .at(-1);
    if (dataLine) {
      try {
        json = JSON.parse(dataLine.slice(6));
      } catch {
        // non-JSON error bodies surface in status assertions
      }
    }
  } else {
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON error bodies surface in status assertions
    }
  }
  return { status: response.status, json };
}

describe("HTTP transport", () => {
  it("reports health at / and 404s unknown paths", async () => {
    const { endpoint, root, url } = await startServer();
    try {
      const health = await fetch(root);
      expect(health.status).toBe(200);
      expect((await health.json()).server).toBe("octopus-energy-private-mcp");

      const missing = await fetch(`${root}nope`);
      expect(missing.status).toBe(404);
    } finally {
      await endpoint.close();
    }
  });

  it("answers initialize and tools/list over streamable HTTP", async () => {
    const { endpoint, url } = await startServer();
    try {
      const init = await mcpPost(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0" }
        }
      });
      expect(init.status).toBe(200);
      expect(init.json?.result?.serverInfo?.name).toBe("octopus-energy-private-mcp");

      const ready = await mcpPost(url, { jsonrpc: "2.0", method: "notifications/initialized" });
      expect(ready.status).toBeLessThan(300);

      const tools = await mcpPost(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      expect(tools.json?.result?.tools?.map((tool: { name: string }) => tool.name)).toContain("octopus_whatif_usage");
      expect(tools.json?.result?.tools?.map((tool: { name: string }) => tool.name)).toContain("octopus_sync_history");
    } finally {
      await endpoint.close();
    }
  });

  it("enforces the bearer token when configured", async () => {
    const { endpoint, url } = await startServer("s3cret");
    try {
      const anonymous = await mcpPost(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      expect(anonymous.status).toBe(401);

      const good = await mcpPost(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "s3cret");
      expect(good.status).toBe(200);
      expect(good.json?.result?.tools?.length).toBeGreaterThan(0);
    } finally {
      await endpoint.close();
    }
  });

  it("surfaces a broken downstream (no API key) as a tool error, not a crash", async () => {
    const { endpoint, url } = await startServer();
    try {
      await mcpPost(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } }
      });
      await mcpPost(url, { jsonrpc: "2.0", method: "notifications/initialized" });
      const call = await mcpPost(url, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "octopus_connection_status", arguments: {} }
      });
      expect(call.status).toBe(200);
      expect(call.json?.result?.structuredContent?.configuration?.transport_http).toBe(false);
    } finally {
      await endpoint.close();
    }
  });
});
