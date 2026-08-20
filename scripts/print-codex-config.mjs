import { resolve } from "node:path";

function tomlString(value) {
  return JSON.stringify(value);
}

export function createCodexSetup(projectDirectory = process.cwd(), nodePath = process.execPath) {
  const root = resolve(projectDirectory);
  const envFile = resolve(root, ".env");
  const serverFile = resolve(root, "dist", "index.js");
  const args = [`--env-file-if-exists=${envFile}`, serverFile];

  return {
    command: nodePath,
    args,
    toml: [
      "[mcp_servers.octopus_energy]",
      `command = ${tomlString(nodePath)}`,
      `args = [${args.map(tomlString).join(", ")}]`,
      "startup_timeout_sec = 20",
      "tool_timeout_sec = 120",
      "required = false"
    ].join("\n")
  };
}

const setup = createCodexSetup();

process.stdout.write(`
Octopus Energy Private MCP — connection details
================================================

In ChatGPT desktop, open Settings → MCP servers → Add server.

Name:      Octopus Energy
Type:      STDIO
Command:   ${setup.command}
Arguments: ${setup.args[0]}
           ${setup.args[1]}

If you prefer to edit Codex configuration directly, copy this block:

${setup.toml}

Your API key is not printed or copied by this helper.
`);
