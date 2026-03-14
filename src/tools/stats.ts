/**
 * Fuzzer stats tools — read, compare, and analyze persisted metrics.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { Config, resolveDir } from "../lib/config.js";

interface StatsData {
  target_name?: string;
  total_execs?: number;
  total_run_time_secs?: number;
  corpus_count?: number;
  corpus_bytes?: number;
  max_coverage?: number;
  max_features?: number;
  crash_count?: number;
  peak_rss_mb?: number;
  run_count?: number;
  finds_per_k_history?: Array<{ value: number; timestamp: string }>;
  exec_speed_history?: Array<{ value: number; timestamp: string }>;
  coverage_history?: Array<{ value: number; timestamp: string }>;
}

function loadStats(statsDir: string, targetName: string): StatsData | null {
  const statsFile = path.join(statsDir, targetName, "stats.json");
  if (!fs.existsSync(statsFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(statsFile, "utf-8"));
  } catch {
    return null;
  }
}

function formatStats(name: string, data: StatsData): string {
  const findsK =
    data.finds_per_k_history?.length
      ? data.finds_per_k_history[data.finds_per_k_history.length - 1]?.value ?? 0
      : 0;
  const runTime = data.total_run_time_secs ?? 0;
  const hours = Math.floor(runTime / 3600);
  const mins = Math.floor((runTime % 3600) / 60);
  const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  return (
    `**${name}** (run #${data.run_count ?? "?"})\n` +
    `  Execs: ${data.total_execs ?? 0} (${timeStr} total)\n` +
    `  Corpus: ${data.corpus_count ?? 0} entries (${formatBytes(data.corpus_bytes ?? 0)})\n` +
    `  Coverage: ${data.max_coverage ?? 0} edges, ${data.max_features ?? 0} features\n` +
    `  Crashes: ${data.crash_count ?? 0}\n` +
    `  Finds/k: ${Number(findsK).toFixed(3)}\n` +
    `  Peak RSS: ${data.peak_rss_mb ?? 0} MB`
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} bytes`;
}

export function registerStatsTools(server: McpServer, config: Config): void {
  const statsDir = resolveDir(config, config.stats_dir);
  const targetNames = config.targets.map((t) => t.name);

  server.tool(
    "get_fuzzer_stats",
    "Read persisted fuzzer stats — execs, corpus, coverage, crashes, finds/k.",
    {
      target: z.string().optional().describe("Target name. Omit for all targets."),
    },
    async ({ target }) => {
      const names = target ? [target] : targetNames;
      if (names.length === 0) {
        // No targets configured — scan stats dir
        if (fs.existsSync(statsDir)) {
          const dirs = fs.readdirSync(statsDir).filter((d) =>
            fs.existsSync(path.join(statsDir, d, "stats.json"))
          );
          names.push(...dirs);
        }
      }

      const results = names.map((n) => {
        const data = loadStats(statsDir, n);
        return data ? formatStats(n, data) : `**${n}**: no stats (not yet run)`;
      });

      return {
        content: [
          { type: "text" as const, text: `## Fuzzer Stats\n\n${results.join("\n\n")}` },
        ],
      };
    }
  );

  server.tool(
    "compare_coverage",
    "Compare coverage growth rate between targets to identify which are still finding new edges.",
    {},
    async () => {
      const names = targetNames.length
        ? targetNames
        : fs.existsSync(statsDir)
        ? fs.readdirSync(statsDir).filter((d) => fs.existsSync(path.join(statsDir, d, "stats.json")))
        : [];

      const rows: string[] = [];
      for (const name of names) {
        const data = loadStats(statsDir, name);
        if (!data) continue;

        const covHistory = data.coverage_history ?? [];
        const findsHistory = data.finds_per_k_history ?? [];

        // Coverage growth: last 10 samples vs first 10
        let growthRate = "N/A";
        if (covHistory.length >= 20) {
          const early = covHistory.slice(0, 10).reduce((s, v) => s + v.value, 0) / 10;
          const recent = covHistory.slice(-10).reduce((s, v) => s + v.value, 0) / 10;
          const pctGrowth = early > 0 ? ((recent - early) / early) * 100 : 0;
          growthRate = `${pctGrowth.toFixed(1)}%`;
        }

        // Finds/k trend
        let findsTrend = "N/A";
        if (findsHistory.length >= 10) {
          const recentFinds = findsHistory.slice(-5).reduce((s, v) => s + v.value, 0) / 5;
          const earlierFinds = findsHistory.slice(-10, -5).reduce((s, v) => s + v.value, 0) / 5;
          if (recentFinds > earlierFinds * 1.1) findsTrend = "↑ increasing";
          else if (recentFinds < earlierFinds * 0.5) findsTrend = "↓ diminishing";
          else findsTrend = "→ stable";
        }

        rows.push(
          `| ${name} | ${data.max_coverage ?? 0} | ${growthRate} | ${
            Number(findsHistory[findsHistory.length - 1]?.value ?? 0).toFixed(3)
          } | ${findsTrend} |`
        );
      }

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: "No stats data available." }] };
      }

      const table =
        "| Target | Coverage | Growth | Finds/k | Trend |\n" +
        "|--------|----------|--------|---------|-------|\n" +
        rows.join("\n");

      return { content: [{ type: "text" as const, text: `## Coverage Comparison\n\n${table}` }] };
    }
  );

  server.tool(
    "diminishing_returns",
    "Analyze which targets are hitting diminishing returns and should be deprioritized or reconfigured.",
    {},
    async () => {
      const names = targetNames.length
        ? targetNames
        : fs.existsSync(statsDir)
        ? fs.readdirSync(statsDir).filter((d) => fs.existsSync(path.join(statsDir, d, "stats.json")))
        : [];

      const assessments: string[] = [];
      for (const name of names) {
        const data = loadStats(statsDir, name);
        if (!data) continue;

        const findsHistory = data.finds_per_k_history ?? [];
        const totalExecs = data.total_execs ?? 0;
        const corpus = data.corpus_count ?? 0;
        const currentFindsK = findsHistory[findsHistory.length - 1]?.value ?? 0;

        let assessment: string;
        let recommendation: string;

        if (findsHistory.length < 10) {
          assessment = "⏳ Too early to assess";
          recommendation = "Continue fuzzing to gather baseline data";
        } else if (currentFindsK >= 1.0) {
          assessment = "🟢 Active discovery";
          recommendation = "Keep running — still finding ~1+ new inputs per 1000 execs";
        } else if (currentFindsK >= 0.1) {
          assessment = "🟡 Slowing down";
          recommendation = "Consider adding dictionary tokens, new seed inputs, or increasing max_len";
        } else if (currentFindsK >= 0.01) {
          assessment = "🟠 Diminishing returns";
          recommendation = "Reallocate cores to more productive targets or try structural mutation";
        } else {
          assessment = "🔴 Saturated";
          recommendation = "Target is likely coverage-saturated. Focus on crash triage or move to next target";
        }

        assessments.push(
          `### ${name}\n` +
            `- Status: ${assessment}\n` +
            `- Finds/k: ${currentFindsK.toFixed(4)}\n` +
            `- Total execs: ${totalExecs}\n` +
            `- Corpus: ${corpus}\n` +
            `- Recommendation: ${recommendation}\n`
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: assessments.length
              ? `## Diminishing Returns Analysis\n\n${assessments.join("\n")}`
              : "No stats data available.",
          },
        ],
      };
    }
  );
}
