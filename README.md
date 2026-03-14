# fuzz-fleet

An [MCP](https://modelcontextprotocol.io/) server for distributed fuzzing.
Gives AI coding assistants (Copilot CLI, Claude, Cursor) direct access to crash
triage, coverage stats, remote execution, and — through the MCP bridge — any
tools running on your fuzz servers.

Works with libFuzzer, LibAFL, AFL++, or any fuzzer that writes stats to disk.

---

## What it does

You run fuzz-fleet on your dev machine. It connects to your fuzzing servers over
SSH and lets your AI assistant:

- **Triage crashes** — structured reports, stack-based dedup, severity tracking
- **Monitor campaigns** — execution counts, corpus growth, coverage trends,
  diminishing-returns analysis
- **Execute remotely** — run commands, read files, hex-dump crash inputs
- **Bridge to remote MCP servers** — call tools on other MCP servers (GDB,
  sanitizers, custom tooling) running on the fuzz box, directly over SSH

```
┌──────────────────┐                    ┌──────────────────────┐
│  Dev machine     │                    │  Fuzz server         │
│                  │                    │                      │
│  AI Assistant    │                    │                      │
│  └─ fuzz-fleet   │                    │                      │
│     ├─ crashes ◄─┼── sync_pull ──────── .crashes/            │
│     ├─ stats ◄───┼── sync_pull ──────── .stats/              │
│     ├─ remote ───┼── SSH ───────────►   (shell access)       │
│     └─ bridge ───┼── SSH + MCP ─────►   gdb-mcp, etc.       │
└──────────────────┘                    └──────────────────────┘
```

---

## Quick start

```bash
git clone https://github.com/foxyybb/fuzz-fleet.git
cd fuzz-fleet && npm install && npm run build
```

Create `fuzz-fleet.json` in your fuzzing project root:

```json
{
  "project": "my-project",
  "remotes": [{ "ssh": "user@fuzzbox", "base_dir": "$HOME/fuzzing" }],
  "targets": [
    {
      "name": "parser",
      "display_name": "Parser",
      "binary": "parser_fuzzer",
      "description": "Protocol parser"
    }
  ]
}
```

Register with your MCP client:

**Copilot CLI** — add to `~/.config/github-copilot/copilot-cli/mcp.json`:

```json
{
  "mcpServers": {
    "fuzz-fleet": {
      "command": "node",
      "args": ["/path/to/fuzz-fleet/dist/index.js"]
    }
  }
}
```

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fuzz-fleet": {
      "command": "node",
      "args": ["/path/to/fuzz-fleet/dist/index.js"]
    }
  }
}
```

The server auto-discovers `fuzz-fleet.json` by walking up from the working
directory.

---

## Tools

### Crash triage

| Tool | What it does |
|------|-------------|
| `report_crash` | Write a structured crash report (stack trace, analysis, repro steps, severity) |
| `list_crashes` | List reports, optionally filtered by target or severity |
| `read_crash` | Read a specific crash report |
| `deduplicate_crashes` | Compare two reports by normalizing top-5 stack frames |

Reports are saved as markdown in `.crashes/` and include the originating
hostname, timestamp, and optional hex dump of the crashing input.

### Stats & analysis

| Tool | What it does |
|------|-------------|
| `get_fuzzer_stats` | Read stats for one or all targets — execs, corpus, coverage, crashes, finds/k |
| `compare_coverage` | Coverage growth rate and discovery trend per target |
| `diminishing_returns` | Flag targets as 🟢 active / 🟡 slowing / 🟠 diminishing / 🔴 saturated |

Stats are read from `.stats/<target>/stats.json`. Compatible with any fuzzer
that writes stats in this format (see [Stats format](#stats-format) below).

### Remote execution

| Tool | What it does |
|------|-------------|
| `remote_exec` | Run a shell command on the fuzz server via SSH |
| `remote_fuzzer_status` | Comprehensive status — tmux sessions, processes, crashes, corpus, stats, disk |
| `remote_read_file` | Read a file from the server (crash inputs, logs) |
| `remote_hexdump` | Hex dump a file (first 100 lines) |
| `sync_push` | Push local code to the server (rsync or custom command) |
| `sync_pull` | Pull stats, corpus, and crashes from the server |

### MCP bridge

Call tools on **remote MCP servers** directly over SSH. If your fuzz server runs
a GDB MCP server, a sanitizer MCP server, or any other stdio-based MCP server,
fuzz-fleet can connect to it and proxy tool calls.

| Tool | What it does |
|------|-------------|
| `bridge_list_servers` | List configured remote MCP servers and connection status |
| `bridge_list_tools` | Discover tools on a remote MCP server |
| `bridge_call_tool` | Call a remote tool with arguments |
| `bridge_list_resources` | List resources on a remote MCP server |
| `bridge_read_resource` | Read a resource by URI |

Configure in `fuzz-fleet.json`:

```json
{
  "mcp_servers": [
    {
      "name": "gdb-debug",
      "host_index": 0,
      "command": "node",
      "args": ["/opt/gdb-mcp/dist/index.js"],
      "env": { "GDB_PATH": "/usr/bin/gdb" },
      "description": "GDB debugging server on fuzz box"
    }
  ]
}
```

`host_index` references `remotes[]` for SSH details. Connections are lazy
(established on first use) and pooled across calls.

### Resources

| URI | Content |
|-----|---------|
| `fuzz://stats` | All target stats (JSON) |
| `fuzz://config` | Current project configuration (JSON) |
| `fuzz://crashes` | List of crash report filenames (JSON) |

---

## Configuration

```jsonc
{
  "project": "my-project",

  "remotes": [
    {
      "ssh": "user@hostname",
      "base_dir": "$HOME/fuzzing",
      "ssh_options": ["-p 2222"]       // optional
    }
  ],

  "targets": [
    {
      "name": "parser",
      "display_name": "Parser",
      "binary": "parser_fuzzer",
      "description": "Protocol parser fuzzer"
    }
  ],

  // Optional — falls back to rsync
  "sync": {
    "push_cmd": "./deploy.sh sync",
    "pull_cmd": "./deploy.sh fetch",
    "excludes": ["node_modules/", "target/"]
  },

  // Optional — remote MCP servers for bridge
  "mcp_servers": [
    {
      "name": "gdb-debug",
      "host_index": 0,
      "command": "node",
      "args": ["/opt/gdb-mcp/dist/index.js"]
    }
  ],

  // Directory layout (defaults shown)
  "stats_dir": ".stats",
  "crashes_dir": ".crashes"
}
```

Config is found by checking `FUZZ_FLEET_CONFIG` env var, then walking up from
cwd looking for `fuzz-fleet.json` (up to 5 levels).

---

## Stats format

Stats are read from `.stats/<target>/stats.json`. All fields are optional:

```json
{
  "total_execs": 12450000,
  "total_run_time_secs": 8100.5,
  "corpus_count": 3421,
  "corpus_bytes": 4400000,
  "max_coverage": 8912,
  "max_features": 15230,
  "crash_count": 3,
  "peak_rss_mb": 512,
  "run_count": 4,
  "finds_per_k_history": [{ "timestamp": "...", "value": 0.042 }],
  "coverage_history": [{ "timestamp": "...", "value": 8912 }]
}
```

---

## Project structure

```
src/
├── index.ts              # Entry point
├── lib/
│   ├── config.ts         # Config types, loader, directory setup
│   ├── mcp-bridge.ts     # MCP Client over SSH (connection pooling)
│   └── remote.ts         # SSH/local exec utilities
├── tools/
│   ├── bridge.ts         # bridge_* tools
│   ├── crashes.ts        # crash triage tools
│   ├── stats.ts          # stats & analysis tools
│   └── remote.ts         # remote execution & sync tools
└── resources/
    └── index.ts          # MCP resources
```

---

## Requirements

- Node.js ≥ 18
- SSH key-based auth to remote hosts
- `rsync` for sync (unless you provide custom `push_cmd`/`pull_cmd`)

## License

Apache-2.0
