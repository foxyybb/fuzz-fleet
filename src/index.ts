#!/usr/bin/env node
/**
 * fuzz-fleet — MCP server for distributed fuzzing coordination.
 *
 * Provides tools for crash triage, stats analysis, remote execution, and
 * MCP bridge access to remote servers. Configured via fuzz-fleet.json.
 *
 * Usage:
 *   node dist/index.js              # stdio transport (for Copilot CLI)
 *   FUZZ_FLEET_CONFIG=/path/to/fuzz-fleet.json node dist/index.js
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./lib/config.js";
import { registerCrashTools } from "./tools/crashes.js";
import { registerStatsTools } from "./tools/stats.js";
import { registerRemoteTools } from "./tools/remote.js";
import { registerBridgeTools } from "./tools/bridge.js";
import { registerResources } from "./resources/index.js";
import { McpBridge } from "./lib/mcp-bridge.js";

const config = loadConfig();

const server = new McpServer({
  name: "fuzz-fleet",
  version: "1.0.0",
});

// Register all tool modules
registerCrashTools(server, config);
registerStatsTools(server, config);
registerRemoteTools(server, config);

const bridge = new McpBridge(config);
registerBridgeTools(server, config, bridge);

registerResources(server, config);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);

// Clean up bridge connections on exit
process.on("SIGINT", async () => {
  await bridge.disconnectAll();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await bridge.disconnectAll();
  process.exit(0);
});
