import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { testConfig } from "./helpers.js";

describe("MCP server", () => {
  it("negotiates MCP, advertises its tools, and runs a local status tool", async () => {
    const server = createServer(testConfig({ apiKey: undefined, accountNumber: undefined }));
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listing = await client.listTools();
      expect(listing.tools.length).toBeGreaterThanOrEqual(21);
      expect(listing.tools.map((tool) => tool.name)).toContain("octopus_compare_tariffs");
      const response = await client.callTool({ name: "octopus_connection_status", arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ ready_for_account_queries: false });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
