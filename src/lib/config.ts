/**
 * Configuration schema and loader for fuzz-fleet.
 *
 * Reads from fuzz-fleet.json in the project root (or path specified via
 * FUZZ_FLEET_CONFIG env var). Defines targets, remote hosts, and directory
 * conventions without hardcoding any project-specific values.
 */

import * as fs from "fs";
import * as path from "path";

export interface RemoteHost {
  /** SSH connection string (e.g. "user@hostname") */
  ssh: string;
  /** Remote base directory for fuzzing artifacts */
  base_dir: string;
  /** Optional SSH options */
  ssh_options?: string[];
}

export interface FuzzTarget {
  /** Unique target identifier */
  name: string;
  /** Human-readable display name */
  display_name: string;
  /** Binary name (for process detection) */
  binary: string;
  /** Short description */
  description: string;
  /** Corpus directory relative to project root */
  corpus_dir?: string;
  /** Stats file path relative to project root */
  stats_dir?: string;
}

export interface McpServerConfig {
  /** Unique name for this MCP server */
  name: string;
  /** Index into remotes[] for SSH connection details */
  host_index: number;
  /** Command to launch the remote MCP server */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Extra environment variables on the remote */
  env?: Record<string, string>;
  /** Human-readable description */
  description?: string;
}

export interface SyncConfig {
  /** Command to push local changes to remote */
  push_cmd?: string;
  /** Command to pull remote changes to local */
  pull_cmd?: string;
  /** Directories to exclude from sync */
  excludes?: string[];
}

export interface Config {
  /** Project name */
  project: string;
  /** Project root directory (resolved at load time) */
  project_root: string;
  /** Remote hosts for fuzzing */
  remotes: RemoteHost[];
  /** Fuzzer targets */
  targets: FuzzTarget[];
  /** Sync configuration */
  sync?: SyncConfig;
  /** Remote MCP servers accessible over SSH */
  mcp_servers: McpServerConfig[];
  /** Directory for persisted stats (relative to project root) */
  stats_dir: string;
  /** Directory for crash artifacts (relative to project root) */
  crashes_dir: string;
}

const DEFAULT_CONFIG: Partial<Config> = {
  stats_dir: ".stats",
  crashes_dir: ".crashes",
};

/**
 * Load configuration from file or environment.
 *
 * Resolution order:
 * 1. FUZZ_FLEET_CONFIG env var (explicit path)
 * 2. fuzz-fleet.json in current working directory
 * 3. fuzz-fleet.json in parent directories (up to 5 levels)
 * 4. Default config with no targets/remotes
 */
export function loadConfig(): Config {
  const configPath = findConfigFile();

  if (configPath) {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const projectRoot = path.dirname(configPath);

    const config: Config = {
      ...DEFAULT_CONFIG,
      project: raw.project ?? path.basename(projectRoot),
      project_root: projectRoot,
      remotes: raw.remotes ?? [],
      targets: raw.targets ?? [],
      sync: raw.sync,
      mcp_servers: raw.mcp_servers ?? [],
      stats_dir: raw.stats_dir ?? DEFAULT_CONFIG.stats_dir!,
      crashes_dir: raw.crashes_dir ?? DEFAULT_CONFIG.crashes_dir!,
    };

    ensureDirs(config);
    return config;
  }

  // No config file — use defaults with cwd as root
  const config: Config = {
    ...DEFAULT_CONFIG,
    project: "fuzzing",
    project_root: process.cwd(),
    remotes: [],
    targets: [],
    mcp_servers: [],
    stats_dir: DEFAULT_CONFIG.stats_dir!,
    crashes_dir: DEFAULT_CONFIG.crashes_dir!,
  };

  ensureDirs(config);
  return config;
}

function findConfigFile(): string | null {
  // Explicit env var
  const envPath = process.env.FUZZ_FLEET_CONFIG;
  if (envPath && fs.existsSync(envPath)) return path.resolve(envPath);

  // Walk up from cwd
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "fuzz-fleet.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function ensureDirs(config: Config): void {
  const dirs = [
    resolveDir(config, config.crashes_dir),
    resolveDir(config, config.stats_dir),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

/** Resolve a config-relative directory to an absolute path. */
export function resolveDir(config: Config, relPath: string): string {
  return path.resolve(config.project_root, relPath);
}

/** Get the primary remote host (first in the list). */
export function primaryRemote(config: Config): RemoteHost | null {
  return config.remotes[0] ?? null;
}
