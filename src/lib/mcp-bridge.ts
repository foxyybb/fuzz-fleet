/**
 * MCP Bridge — connect to remote MCP servers over SSH.
 *
 * Uses the MCP SDK Client with StdioClientTransport, spawning SSH as the
 * child process. The remote MCP server's stdin/stdout is tunneled through
 * SSH transparently.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Config, McpServerConfig, RemoteHost } from "./config.js";

export interface BridgeConnection {
  client: Client;
  transport: StdioClientTransport;
  serverConfig: McpServerConfig;
  connectedAt: Date;
}

export class McpBridge {
  private connections = new Map<string, BridgeConnection>();
  private connecting = new Map<string, Promise<BridgeConnection>>();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /** Get or create a connection to a named remote MCP server. */
  async connect(serverName: string): Promise<BridgeConnection> {
    const existing = this.connections.get(serverName);
    if (existing) return existing;

    // Prevent duplicate concurrent connections
    const pending = this.connecting.get(serverName);
    if (pending) return pending;

    const promise = this.createConnection(serverName);
    this.connecting.set(serverName, promise);

    try {
      const conn = await promise;
      this.connections.set(serverName, conn);
      return conn;
    } finally {
      this.connecting.delete(serverName);
    }
  }

  private async createConnection(serverName: string): Promise<BridgeConnection> {
    const serverConfig = this.config.mcp_servers.find((s) => s.name === serverName);
    if (!serverConfig) {
      throw new Error(`No MCP server configured with name "${serverName}". Check mcp_servers in fuzz-fleet.json.`);
    }

    const host = this.config.remotes[serverConfig.host_index];
    if (!host) {
      throw new Error(
        `MCP server "${serverName}" references host_index ${serverConfig.host_index}, but no remote at that index.`
      );
    }

    const sshArgs = buildSshArgs(host, serverConfig);

    const transport = new StdioClientTransport({
      command: "ssh",
      args: sshArgs,
      stderr: "pipe",
    });

    const client = new Client({
      name: `fuzz-fleet-bridge/${serverName}`,
      version: "1.0.0",
    });

    transport.onclose = () => {
      this.connections.delete(serverName);
    };

    await client.connect(transport);
    const conn: BridgeConnection = { client, transport, serverConfig, connectedAt: new Date() };
    return conn;
  }

  /** Disconnect a specific server. */
  async disconnect(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (conn) {
      await conn.client.close();
      this.connections.delete(serverName);
    }
  }

  /** Disconnect all servers. */
  async disconnectAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.allSettled(names.map((n) => this.disconnect(n)));
  }

  /** Check if a server is currently connected. */
  isConnected(serverName: string): boolean {
    return this.connections.has(serverName);
  }

  /** Get all configured server names. */
  getServerNames(): string[] {
    return this.config.mcp_servers.map((s) => s.name);
  }

  /** Get config for a server by name. */
  getServerConfig(name: string): McpServerConfig | undefined {
    return this.config.mcp_servers.find((s) => s.name === name);
  }
}

/** Build SSH args that launch the remote MCP server over SSH stdio. */
function buildSshArgs(host: RemoteHost, serverConfig: McpServerConfig): string[] {
  const args: string[] = [
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
    ...(host.ssh_options ?? []),
    host.ssh,
  ];

  // Build the remote command with optional env vars
  const envPrefix = serverConfig.env
    ? Object.entries(serverConfig.env)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ") + " "
    : "";

  const remoteCmd = `${envPrefix}${serverConfig.command}${
    serverConfig.args?.length ? " " + serverConfig.args.map(shellQuote).join(" ") : ""
  }`;

  args.push(remoteCmd);
  return args;
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
