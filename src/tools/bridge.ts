/**
 * Bridge tools — discover and invoke tools on remote MCP servers over SSH.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Config } from "../lib/config.js";
import { McpBridge } from "../lib/mcp-bridge.js";

export function registerBridgeTools(server: McpServer, config: Config, bridge: McpBridge): void {
  server.tool(
    "bridge_list_servers",
    "List remote MCP servers configured for this project and their connection status.",
    {},
    async () => {
      const servers = config.mcp_servers;
      if (servers.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No remote MCP servers configured. Add entries to `mcp_servers` in fuzz-fleet.json.",
          }],
        };
      }

      const lines = servers.map((s) => {
        const host = config.remotes[s.host_index];
        const hostStr = host ? host.ssh : `(invalid host_index ${s.host_index})`;
        const connected = bridge.isConnected(s.name) ? "🟢 connected" : "⚪ disconnected";
        const desc = s.description ? ` — ${s.description}` : "";
        return `- **${s.name}** [${connected}] via ${hostStr}${desc}\n  Command: \`${s.command}${s.args?.length ? " " + s.args.join(" ") : ""}\``;
      });

      return {
        content: [{ type: "text" as const, text: `## Remote MCP Servers\n\n${lines.join("\n\n")}` }],
      };
    }
  );

  server.tool(
    "bridge_list_tools",
    "List all tools available on a remote MCP server. Connects if not already connected.",
    {
      server_name: z.string().describe("Name of the remote MCP server (from mcp_servers config)"),
    },
    async ({ server_name }) => {
      try {
        const conn = await bridge.connect(server_name);
        const result = await conn.client.listTools();
        const tools = result.tools;

        if (tools.length === 0) {
          return { content: [{ type: "text" as const, text: `Server "${server_name}" has no tools.` }] };
        }

        const lines = tools.map((t) => {
          const params = t.inputSchema?.properties
            ? Object.keys(t.inputSchema.properties as Record<string, unknown>).join(", ")
            : "none";
          return `- **${t.name}** — ${t.description ?? "(no description)"}\n  Params: ${params}`;
        });

        return {
          content: [{
            type: "text" as const,
            text: `## Tools on "${server_name}" (${tools.length})\n\n${lines.join("\n\n")}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Failed to list tools on "${server_name}": ${e.message}` }] };
      }
    }
  );

  server.tool(
    "bridge_call_tool",
    "Call a tool on a remote MCP server. Pass the tool name and its arguments as a JSON object.",
    {
      server_name: z.string().describe("Name of the remote MCP server"),
      tool_name: z.string().describe("Name of the tool to call on the remote server"),
      arguments: z.record(z.unknown()).default({}).describe("Arguments to pass to the remote tool (JSON object)"),
    },
    async ({ server_name, tool_name, arguments: args }) => {
      try {
        const conn = await bridge.connect(server_name);
        const result = await conn.client.callTool({ name: tool_name, arguments: args });

        const textParts = (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!);

        const output = textParts.length > 0
          ? textParts.join("\n\n")
          : JSON.stringify(result.content, null, 2);

        return { content: [{ type: "text" as const, text: output }] };
      } catch (e: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to call "${tool_name}" on "${server_name}": ${e.message}`,
          }],
        };
      }
    }
  );

  server.tool(
    "bridge_list_resources",
    "List resources exposed by a remote MCP server.",
    {
      server_name: z.string().describe("Name of the remote MCP server"),
    },
    async ({ server_name }) => {
      try {
        const conn = await bridge.connect(server_name);
        const result = await conn.client.listResources();
        const resources = result.resources;

        if (resources.length === 0) {
          return { content: [{ type: "text" as const, text: `Server "${server_name}" has no resources.` }] };
        }

        const lines = resources.map((r) =>
          `- **${r.name}** \`${r.uri}\`${r.description ? ` — ${r.description}` : ""}`
        );

        return {
          content: [{
            type: "text" as const,
            text: `## Resources on "${server_name}" (${resources.length})\n\n${lines.join("\n")}`,
          }],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to list resources on "${server_name}": ${e.message}` }],
        };
      }
    }
  );

  server.tool(
    "bridge_read_resource",
    "Read a resource from a remote MCP server by URI.",
    {
      server_name: z.string().describe("Name of the remote MCP server"),
      uri: z.string().describe("Resource URI to read"),
    },
    async ({ server_name, uri }) => {
      try {
        const conn = await bridge.connect(server_name);
        const result = await conn.client.readResource({ uri });

        const textParts = result.contents
          .filter((c) => "text" in c && c.text)
          .map((c) => (c as { text: string }).text);

        const output = textParts.length > 0
          ? textParts.join("\n\n")
          : JSON.stringify(result.contents, null, 2);

        return { content: [{ type: "text" as const, text: output }] };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to read resource "${uri}" on "${server_name}": ${e.message}` }],
        };
      }
    }
  );
}
