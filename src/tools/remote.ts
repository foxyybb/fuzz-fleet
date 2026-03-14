/**
 * Remote execution tools — SSH commands, fuzzer status, sync.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Config, primaryRemote } from "../lib/config.js";
import { remoteExec, remoteScript, localExec } from "../lib/remote.js";

export function registerRemoteTools(server: McpServer, config: Config): void {
  server.tool(
    "remote_exec",
    "Execute a shell command on the remote fuzzing server via SSH.",
    {
      command: z.string().describe("Shell command to run"),
      host_index: z.number().default(0).describe("Index into remotes[] array (default: 0)"),
      timeout_secs: z.number().default(30),
    },
    async ({ command, host_index, timeout_secs }) => {
      const host = config.remotes[host_index];
      if (!host) {
        return {
          content: [
            { type: "text" as const, text: `No remote host at index ${host_index}. Configure remotes in fuzz-fleet.json.` },
          ],
        };
      }

      const result = remoteExec(host, command, timeout_secs * 1000);
      const output = result.exitCode === 0
        ? result.stdout
        : `Exit code: ${result.exitCode}\n\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`;

      return { content: [{ type: "text" as const, text: `\`\`\`\n${output}\n\`\`\`` }] };
    }
  );

  server.tool(
    "remote_fuzzer_status",
    "Get comprehensive fuzzer status from the remote server — processes, tmux sessions, crashes, corpus, stats.",
    {
      host_index: z.number().default(0),
    },
    async ({ host_index }) => {
      const host = config.remotes[host_index];
      if (!host) {
        return {
          content: [{ type: "text" as const, text: "No remote host configured." }],
        };
      }

      const binaries = config.targets.map((t) => t.binary).join("|");
      const baseDir = host.base_dir;

      const script = `
echo "=== tmux sessions ==="
tmux list-sessions 2>/dev/null || echo "  None"
echo ""
echo "=== fuzzer processes ==="
ps aux | grep -E '(${binaries})' | grep -v grep || echo "  None running"
echo ""
echo "=== crashes ==="
find ${baseDir} -name 'crash-*' -o -name 'timeout-*' 2>/dev/null | wc -l | xargs -I{} echo "  {} crash/timeout files"
echo ""
echo "=== corpus ==="
for d in ${baseDir}/.corpus/*/; do
  [ -d "$d" ] && echo "  $(basename $d): $(find $d -type f | wc -l) files ($(du -sh $d 2>/dev/null | cut -f1))"
done
echo ""
echo "=== stats ==="
for f in ${baseDir}/.stats/*/stats.json; do
  [ -f "$f" ] && python3 -c "
import json,os
d=json.load(open('$f'))
n=os.path.basename(os.path.dirname('$f'))
fk=d.get('finds_per_k_history',[])
fkv=fk[-1]['value'] if fk else 0
print(f'  {n}: {d.get(\"total_execs\",0)} execs | {d.get(\"corpus_count\",0)} corpus | {d.get(\"max_coverage\",0)} cov | {d.get(\"crash_count\",0)} crashes | finds/k={fkv:.3f}')
" 2>/dev/null
done
echo ""
echo "=== disk ==="
df -h ${baseDir} 2>/dev/null | tail -1
      `;

      const result = remoteScript(host, script, 15000);
      return { content: [{ type: "text" as const, text: result.stdout || result.stderr }] };
    }
  );

  server.tool(
    "remote_read_file",
    "Read a file from the remote server (useful for inspecting crash inputs or logs).",
    {
      path: z.string().describe("Absolute or base_dir-relative path on the server"),
      host_index: z.number().default(0),
      max_bytes: z.number().default(65536).describe("Maximum bytes to read"),
    },
    async ({ path: filePath, host_index, max_bytes }) => {
      const host = config.remotes[host_index];
      if (!host) {
        return { content: [{ type: "text" as const, text: "No remote host configured." }] };
      }

      const absPath = filePath.startsWith("/") ? filePath : `${host.base_dir}/${filePath}`;
      const result = remoteExec(host, `head -c ${max_bytes} ${JSON.stringify(absPath)}`, 10000);

      if (result.exitCode !== 0) {
        return { content: [{ type: "text" as const, text: `Failed to read: ${result.stderr}` }] };
      }
      return { content: [{ type: "text" as const, text: result.stdout }] };
    }
  );

  server.tool(
    "remote_hexdump",
    "Hex dump a crash input file from the remote server.",
    {
      path: z.string().describe("Path to crash input file on the server"),
      host_index: z.number().default(0),
    },
    async ({ path: filePath, host_index }) => {
      const host = config.remotes[host_index];
      if (!host) {
        return { content: [{ type: "text" as const, text: "No remote host configured." }] };
      }

      const absPath = filePath.startsWith("/") ? filePath : `${host.base_dir}/${filePath}`;
      const result = remoteExec(host, `xxd ${JSON.stringify(absPath)} | head -100`, 10000);

      return {
        content: [{ type: "text" as const, text: `\`\`\`\n${result.stdout || result.stderr}\n\`\`\`` }],
      };
    }
  );

  server.tool(
    "sync_push",
    "Push local fuzzer code to the remote server.",
    {},
    async () => {
      if (config.sync?.push_cmd) {
        const result = localExec(config.sync.push_cmd, config.project_root, 120000);
        return { content: [{ type: "text" as const, text: result.stdout || result.stderr }] };
      }

      const host = primaryRemote(config);
      if (!host) {
        return { content: [{ type: "text" as const, text: "No remote host or sync.push_cmd configured." }] };
      }

      const excludes = (config.sync?.excludes ?? ["node_modules/", "dist/", "target/", ".stats/", ".corpus/", ".crashes/"])
        .map((e) => `--exclude='${e}'`)
        .join(" ");

      const cmd = `rsync -avz --delete ${excludes} ${config.project_root}/ ${host.ssh}:${host.base_dir}/`;
      const result = localExec(cmd, undefined, 120000);
      return { content: [{ type: "text" as const, text: result.stdout || result.stderr }] };
    }
  );

  server.tool(
    "sync_pull",
    "Pull crashes, corpus, and stats from the remote server.",
    {},
    async () => {
      if (config.sync?.pull_cmd) {
        const result = localExec(config.sync.pull_cmd, config.project_root, 120000);
        return { content: [{ type: "text" as const, text: result.stdout || result.stderr }] };
      }

      const host = primaryRemote(config);
      if (!host) {
        return { content: [{ type: "text" as const, text: "No remote host or sync.pull_cmd configured." }] };
      }

      const pulls = [
        `rsync -avz ${host.ssh}:${host.base_dir}/.stats/ ${config.project_root}/.stats/`,
        `rsync -avz ${host.ssh}:${host.base_dir}/.corpus/ ${config.project_root}/.corpus/`,
        `rsync -avz ${host.ssh}:${host.base_dir}/.crashes/ ${config.project_root}/.crashes/`,
      ];

      const outputs: string[] = [];
      for (const cmd of pulls) {
        const result = localExec(cmd, undefined, 60000);
        outputs.push(result.stdout || result.stderr);
      }
      return { content: [{ type: "text" as const, text: outputs.join("\n") }] };
    }
  );
}
