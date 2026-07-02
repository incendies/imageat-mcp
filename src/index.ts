#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { ApiKeyAuthProvider } from "./auth.js";
import { ImageATClient } from "./client.js";
import { createImageatServer } from "./server.js";

async function main() {
  const config = loadConfig();
  const client = new ImageATClient(config, new ApiKeyAuthProvider(config.apiKey));

  const { server, toolCount } = await createImageatServer(client, (msg) =>
    process.stderr.write(`[imageat-mcp] ${msg}\n`),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[imageat-mcp] connected — ${toolCount} tools registered against ${config.baseUrl}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[imageat-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
