import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { ServerConfig } from "./config.js";
import { createServer } from "./server.js";
import type { UpdateStatus } from "./update-check.js";
import { CURRENT_VERSION } from "./version.js";

export interface HttpEndpoint {
  host: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Stateless streamable-HTTP MCP endpoint served by a plain node:http server,
 * matching the deployment pattern of the other MCP hub containers (bluelink,
 * volvo). Every request is served by a fresh McpServer over the shared local
 * caches and history store; GET/DELETE session negotiation answers 405 as
 * required for stateless servers.
 */
export async function serveHttpEndpoint(
  config: ServerConfig,
  updateStatus?: UpdateStatus
): Promise<HttpEndpoint> {
  const handler: McpHttpHandler = createMcpHandler(() => createServer(config, { updateStatus }));

  const server = createHttpServer((request, response) => {
    void handleHttpRequest(handler, request, response, config).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: `Unexpected MCP error: ${message(error)}` }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.httpPort, config.httpHost, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.httpPort;

  return {
    host: config.httpHost,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        void handler.close();
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}

async function handleHttpRequest(
  handler: McpHttpHandler,
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", server: "octopus-energy-private-mcp", version: CURRENT_VERSION }));
    return;
  }
  if (url.pathname !== "/mcp") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found; MCP endpoint is /mcp" }));
    return;
  }
  if (config.httpToken) {
    const header = request.headers.authorization ?? "";
    if (header !== `Bearer ${config.httpToken}`) {
      response.writeHead(401, {
        "content-type": "application/json",
        "WWW-Authenticate": "Bearer"
      });
      response.end(JSON.stringify({ error: "Missing or invalid bearer token" }));
      return;
    }
  }

  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
  }
  headers.set("host", request.headers.host ?? "localhost");
  const webRequest = new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: Uint8Array.from(body).buffer as ArrayBuffer })
  });
  const webResponse = await handler.fetch(webRequest);
  const payload = await webResponse.text();
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
