/**
 * Crash triage tools — report, list, read, and compare crash reports.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { Config, resolveDir } from "../lib/config.js";
import { hostname } from "../lib/remote.js";

export function registerCrashTools(server: McpServer, config: Config): void {
  const crashDir = resolveDir(config, config.crashes_dir);

  server.tool(
    "report_crash",
    "Write a structured crash triage report for sharing with other instances.",
    {
      crash_id: z.string().describe("Crash identifier (hash or filename)"),
      target: z.string().describe("Fuzzer target name"),
      stack_trace: z.string().describe("Stack trace"),
      analysis: z.string().describe("Root cause analysis"),
      reproduction: z.string().describe("Command to reproduce"),
      severity: z.enum(["critical", "high", "medium", "low"]),
      input_hex: z.string().optional().describe("Hex dump of crashing input"),
      notes: z.string().optional().describe("Additional notes"),
    },
    async ({ crash_id, target, stack_trace, analysis, reproduction, severity, input_hex, notes }) => {
      const timestamp = new Date().toISOString();
      const filename = `${target}-${crash_id}.md`;
      const filepath = path.join(crashDir, filename);

      let report = `# Crash Report: ${crash_id}

| Field | Value |
|-------|-------|
| Target | ${target} |
| Severity | ${severity} |
| Timestamp | ${timestamp} |
| Reporter | ${hostname()} |

## Stack Trace

\`\`\`
${stack_trace}
\`\`\`

## Analysis

${analysis}

## Reproduction

\`\`\`bash
${reproduction}
\`\`\`
`;

      if (input_hex) {
        report += `\n## Crashing Input\n\n\`\`\`\n${input_hex}\n\`\`\`\n`;
      }
      if (notes) {
        report += `\n## Notes\n\n${notes}\n`;
      }

      fs.writeFileSync(filepath, report);
      return {
        content: [
          { type: "text" as const, text: `Crash report written: ${filename}` },
        ],
      };
    }
  );

  server.tool(
    "list_crashes",
    "List all crash triage reports with severity and target.",
    {
      target: z.string().optional().describe("Filter by target name"),
      severity: z.enum(["critical", "high", "medium", "low"]).optional(),
    },
    async ({ target, severity }) => {
      if (!fs.existsSync(crashDir)) {
        return { content: [{ type: "text" as const, text: "No crash reports." }] };
      }

      let files = fs.readdirSync(crashDir).filter((f) => f.endsWith(".md"));

      const summaries: string[] = [];
      for (const f of files) {
        const content = fs.readFileSync(path.join(crashDir, f), "utf-8");
        const sevMatch = content.match(/Severity \| (\w+)/);
        const tgtMatch = content.match(/Target \| ([\w-]+)/);
        const sev = sevMatch?.[1] ?? "unknown";
        const tgt = tgtMatch?.[1] ?? "unknown";

        if (target && tgt !== target) continue;
        if (severity && sev !== severity) continue;

        summaries.push(`- **${f}** [${sev}] target=${tgt}`);
      }

      if (summaries.length === 0) {
        return { content: [{ type: "text" as const, text: "No matching crash reports." }] };
      }

      return {
        content: [
          { type: "text" as const, text: `## Crash Reports (${summaries.length})\n\n${summaries.join("\n")}` },
        ],
      };
    }
  );

  server.tool(
    "read_crash",
    "Read a specific crash triage report.",
    { filename: z.string() },
    async ({ filename }) => {
      const filepath = path.join(crashDir, filename);
      if (!fs.existsSync(filepath)) {
        return { content: [{ type: "text" as const, text: `Not found: ${filename}` }] };
      }
      return { content: [{ type: "text" as const, text: fs.readFileSync(filepath, "utf-8") }] };
    }
  );

  server.tool(
    "deduplicate_crashes",
    "Compare two crash reports and assess whether they are likely the same root cause.",
    {
      crash_a: z.string().describe("Filename of first crash report"),
      crash_b: z.string().describe("Filename of second crash report"),
    },
    async ({ crash_a, crash_b }) => {
      const pathA = path.join(crashDir, crash_a);
      const pathB = path.join(crashDir, crash_b);

      if (!fs.existsSync(pathA)) return { content: [{ type: "text" as const, text: `Not found: ${crash_a}` }] };
      if (!fs.existsSync(pathB)) return { content: [{ type: "text" as const, text: `Not found: ${crash_b}` }] };

      const contentA = fs.readFileSync(pathA, "utf-8");
      const contentB = fs.readFileSync(pathB, "utf-8");

      // Extract stack traces for comparison
      const extractStack = (content: string): string[] => {
        const match = content.match(/## Stack Trace\s*\n```\n([\s\S]*?)\n```/);
        if (!match) return [];
        return match[1]
          .split("\n")
          .filter((l) => l.includes("#") || l.includes("at "))
          .map((l) => l.replace(/0x[0-9a-f]+/g, "ADDR").trim());
      };

      const stackA = extractStack(contentA);
      const stackB = extractStack(contentB);

      // Compare top N frames
      const topN = Math.min(5, stackA.length, stackB.length);
      let matching = 0;
      for (let i = 0; i < topN; i++) {
        if (stackA[i] === stackB[i]) matching++;
      }
      const similarity = topN > 0 ? (matching / topN) * 100 : 0;

      const verdict =
        similarity >= 80
          ? "LIKELY DUPLICATE"
          : similarity >= 40
          ? "POSSIBLY RELATED"
          : "LIKELY DISTINCT";

      return {
        content: [
          {
            type: "text" as const,
            text: `## Dedup: ${crash_a} vs ${crash_b}\n\n` +
              `Top-${topN} frame similarity: ${similarity.toFixed(0)}%\n` +
              `Verdict: **${verdict}**\n\n` +
              `### ${crash_a} top frames:\n${stackA.slice(0, 5).map((l) => `  ${l}`).join("\n")}\n\n` +
              `### ${crash_b} top frames:\n${stackB.slice(0, 5).map((l) => `  ${l}`).join("\n")}`,
          },
        ],
      };
    }
  );
}
