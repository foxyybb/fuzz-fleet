/**
 * SSH and remote execution utilities.
 */

import { execSync } from "child_process";
import { RemoteHost } from "./config.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Build the SSH command prefix for a remote host. */
function sshPrefix(host: RemoteHost): string {
  const opts = host.ssh_options?.join(" ") ?? "";
  return `ssh -o ConnectTimeout=10 -o BatchMode=yes ${opts} ${host.ssh}`.trim();
}

/** Execute a command on a remote host via SSH. */
export function remoteExec(
  host: RemoteHost,
  command: string,
  timeoutMs: number = 30000
): ExecResult {
  const sshCmd = `${sshPrefix(host)} ${JSON.stringify(command)}`;
  try {
    const stdout = execSync(sshCmd, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
      exitCode: e.status ?? 1,
    };
  }
}

/** Execute a multi-line script on a remote host. */
export function remoteScript(
  host: RemoteHost,
  script: string,
  timeoutMs: number = 30000
): ExecResult {
  const sshCmd = `${sshPrefix(host)} bash -s <<'FUZZ_BRIDGE_EOF'\n${script}\nFUZZ_BRIDGE_EOF`;
  try {
    const stdout = execSync(sshCmd, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
      exitCode: e.status ?? 1,
    };
  }
}

/** Execute a local command. */
export function localExec(
  command: string,
  cwd?: string,
  timeoutMs: number = 60000
): ExecResult {
  try {
    const stdout = execSync(command, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      cwd,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
      exitCode: e.status ?? 1,
    };
  }
}

/** Get the local hostname. */
export function hostname(): string {
  try {
    return execSync("hostname", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}
