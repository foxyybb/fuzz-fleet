/**
 * MCP resources — expose fuzzer data for context injection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { Config, resolveDir } from "../lib/config.js";

export function registerResources(server: McpServer, config: Config): void {
  const statsDir = resolveDir(config, config.stats_dir);

  server.resource(
    "fuzzer-stats",
    "fuzz://stats",
    async () => {
      const result: Record<string, unknown> = { project: config.project };
      const names = config.targets.map((t) => t.name);

      // Also scan the stats dir for any targets not in config
      if (fs.existsSync(statsDir)) {
        for (const d of fs.readdirSync(statsDir)) {
          if (!names.includes(d) && fs.existsSync(path.join(statsDir, d, "stats.json"))) {
            names.push(d);
          }
        }
      }

      for (const name of names) {
        const file = path.join(statsDir, name, "stats.json");
        if (fs.existsSync(file)) {
          try {
            result[name] = JSON.parse(fs.readFileSync(file, "utf-8"));
          } catch {
            result[name] = { error: "parse error" };
          }
        }
      }

      return {
        contents: [
          { uri: "fuzz://stats", text: JSON.stringify(result, null, 2), mimeType: "application/json" },
        ],
      };
    }
  );

  server.resource(
    "project-config",
    "fuzz://config",
    async () => {
      return {
        contents: [
          {
            uri: "fuzz://config",
            text: JSON.stringify(
              { ...config, project_root: config.project_root },
              null,
              2
            ),
            mimeType: "application/json",
          },
        ],
      };
    }
  );

  server.resource(
    "crash-list",
    "fuzz://crashes",
    async () => {
      const crashDir = resolveDir(config, config.crashes_dir);
      if (!fs.existsSync(crashDir)) {
        return { contents: [{ uri: "fuzz://crashes", text: "[]", mimeType: "application/json" }] };
      }
      const files = fs.readdirSync(crashDir).filter((f) => f.endsWith(".md"));
      return {
        contents: [{ uri: "fuzz://crashes", text: JSON.stringify(files), mimeType: "application/json" }],
      };
    }
  );
}
