// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Clean self-host startup and teardown for the blessed
// deploy/docker/docker-compose.yml stack. Modeled directly on
// scripts/docker-smoke.sh's wait/cleanup posture, but exposed as an
// importable module so the friend-journey CLI can drive the same stack the
// documented self-service runbook uses (docs/operator/self-service-gmail-mcp.md)
// and hand a running origin to journey.ts.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface DockerComposeConfig {
  composeFile: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  projectName: string;
}

interface RunResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function composeArgs(config: DockerComposeConfig, ...rest: string[]): string[] {
  return ["compose", "-f", config.composeFile, "--project-name", config.projectName, ...rest];
}

export function generateOwnerPassword(): string {
  return randomBytes(24).toString("base64url");
}

export function generateCredentialEncryptionKey(): string {
  return randomBytes(32).toString("hex");
}

/** `docker compose up -d --build`. Throws on non-zero exit. */
export async function composeUp(config: DockerComposeConfig): Promise<void> {
  const result = await run("docker", composeArgs(config, "up", "-d", "--build"), config.env, config.cwd);
  if (result.code !== 0) {
    throw new Error(`docker compose up failed (exit ${result.code}):\n${result.stderr || result.stdout}`);
  }
}

/** `docker compose down --volumes --remove-orphans`. Never throws — teardown is best-effort. */
export async function composeDown(config: DockerComposeConfig): Promise<RunResult> {
  return await run("docker", composeArgs(config, "down", "--volumes", "--remove-orphans"), config.env, config.cwd);
}

/** `docker compose ps --format json` parsed into per-service state. Empty array on any docker/parse failure. */
export async function composePs(config: DockerComposeConfig): Promise<{ name: string; state: string }[]> {
  const result = await run("docker", composeArgs(config, "ps", "--format", "json"), config.env, config.cwd);
  if (result.code !== 0) {
    return [];
  }
  const services: { name: string; state: string }[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { Service?: string; State?: string };
      if (parsed.Service) {
        services.push({ name: parsed.Service, state: parsed.State ?? "unknown" });
      }
    } catch {
      // one malformed line must not hide the rest
    }
  }
  return services;
}

export interface WaitForOptions {
  headers?: Record<string, string>;
  intervalMs?: number;
  timeoutMs?: number;
}

/** Poll a URL until it returns 2xx or the timeout elapses. Throws with the last error/status on timeout. */
export async function waitForHttpOk(url: string, options: WaitForOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 2000;
  const started = Date.now();
  let lastError = "not attempted";
  while (Date.now() - started < timeoutMs) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: this IS the poll loop — sequential retry against a real origin is the point.
      const resp = await fetch(url, options.headers ? { headers: options.headers } : {});
      if (resp.status >= 200 && resp.status < 300) {
        return;
      }
      lastError = `status ${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${url} to return 2xx (last: ${lastError})`);
}

/** Verify teardown left no running containers or volumes for this project. */
export async function verifyCleanTeardown(config: DockerComposeConfig): Promise<{ detail: string; ok: boolean }> {
  const services = await composePs(config);
  if (services.length > 0) {
    return {
      ok: false,
      detail: `${services.length} container(s) still reported by 'docker compose ps' after teardown: ${services
        .map((s) => `${s.name}=${s.state}`)
        .join(", ")}`,
    };
  }
  const volumeResult = await run(
    "docker",
    ["volume", "ls", "--filter", `label=com.docker.compose.project=${config.projectName}`, "--format", "{{.Name}}"],
    config.env,
    config.cwd
  );
  const leftoverVolumes = volumeResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (leftoverVolumes.length > 0) {
    return {
      ok: false,
      detail: `${leftoverVolumes.length} volume(s) survived teardown: ${leftoverVolumes.join(", ")}`,
    };
  }
  return { ok: true, detail: "no containers or volumes remain for this project" };
}
