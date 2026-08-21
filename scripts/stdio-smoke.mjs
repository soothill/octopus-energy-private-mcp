import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    PATH: process.env.PATH ?? "",
    OCTOPUS_CACHE_ENABLED: "false",
    OCTOPUS_UPDATE_CHECK_ENABLED: process.env.OCTOPUS_UPDATE_CHECK_ENABLED ?? "false"
  },
  stderr: "pipe"
});
const client = new Client({ name: "octopus-energy-private-mcp-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  if (tools.length < 21) throw new Error(`Expected at least 21 tools, received ${tools.length}`);
  const response = await client.callTool({ name: "octopus_connection_status", arguments: {} });
  if (response.isError || response.structuredContent?.ready_for_account_queries !== false) {
    throw new Error("Compiled stdio server returned an invalid status response");
  }
  process.stdout.write(`stdio smoke test passed (${tools.length} tools)\n`);
} finally {
  await client.close();
}
