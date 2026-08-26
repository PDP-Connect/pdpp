// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * canary/collectors
 *
 * The side-effecting half of the harness: everything that reads a number out
 * of the live system. Kept apart from `manifest.ts` so the judgment (which
 * predicate, which verdict) stays pure and testable while the I/O stays here.
 *
 * Every collector is READ-ONLY except `triggerConnectorRun`, which is
 * additionally gated by the OTP denylist at manifest-parse time.
 */

import { spawnSync } from "node:child_process";

export interface CommandResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Runs a command with argv passed as an array — never a shell string — so a
 * value containing spaces or quotes cannot break out into the command line.
 */
export function run(command: string, args: readonly string[], timeoutMs = 120_000): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: (result.stderr ?? "").trim(),
    stdout: (result.stdout ?? "").trim(),
  };
}

/**
 * Executes a scalar SQL query inside the Postgres container.
 *
 * `-tAc` yields a bare value with no header or padding. An empty result is
 * returned as `null` rather than coerced to 0, because "no rows" and "zero"
 * are different facts and a predicate that confuses them lies.
 */
export function sqlScalar(postgresContainer: string, sql: string): string | null {
  const result = run("docker", ["exec", postgresContainer, "psql", "-U", "pdpp", "-d", "pdpp", "-tAc", sql]);
  if (!result.ok) {
    throw new Error(`SQL failed: ${result.stderr || result.stdout}`);
  }
  const value = result.stdout.split("\n")[0]?.trim() ?? "";
  return value.length === 0 ? null : value;
}

/**
 * First column of a single-row query, parsed as a number. Used for counts.
 */
export function sqlNumber(postgresContainer: string, sql: string): number | null {
  const raw = sqlScalar(postgresContainer, sql);
  if (raw === null) {
    return null;
  }
  const first = raw.split("|")[0]?.trim() ?? "";
  const parsed = Number(first);
  return Number.isFinite(parsed) ? parsed : null;
}

export function inspectContainer(container: string): unknown | null {
  const result = run("docker", ["inspect", container, "--format", "{{json .}}"]);
  if (!result.ok) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}

export function containerExists(container: string): boolean {
  return inspectContainer(container) !== null;
}

/**
 * `.Config.Env` of an image (not a container). Used as the right-hand side of
 * env derivation; see `env-derivation.ts` for why it must be the NEW image.
 */
export function imageEnv(image: string): string[] {
  const result = run("docker", ["inspect", image, "--format", "{{json .Config.Env}}"]);
  if (!result.ok) {
    throw new Error(`cannot inspect image ${image}: ${result.stderr}`);
  }
  const parsed: unknown = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

export function imageDigest(image: string): string {
  const result = run("docker", ["inspect", image, "--format", "{{.Id}}"]);
  return result.ok ? result.stdout : "";
}

/**
 * Counts matches of `pattern` in a file INSIDE the image, without running the
 * application. This is the check that distinguishes "deployed" from
 * "restarted onto the same bytes".
 *
 * A tag is a label anyone can move; a commit sha describes the source, not
 * the artifact. Production once restarted onto the SAME image tag and the fix
 * was believed live for hours while data was being destroyed. Only a
 * byte-level grep inside the image caught it, so that grep is a REQUIRED
 * pre-deploy gate here, not an optional diagnostic.
 */
export function greppedCountInImage(image: string, path: string, pattern: string): number {
  const result = run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    image,
    "-c",
    // `grep -c` exits 1 with "0" on no match, which is not an error here.
    `grep -c -- ${shellQuote(pattern)} ${shellQuote(path)} 2>/dev/null || echo 0`,
  ]);
  const parsed = Number(result.stdout.split("\n").pop()?.trim() ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Single-quotes a value for the one place a shell string is unavoidable
 * (`sh -c` inside the container).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/**
 * Occurrences of `pattern` in the container's recent logs.
 *
 * `--since` bounds the window so a pre-existing historical error cannot fail
 * a fresh deploy, and a fresh error cannot hide among old ones.
 */
export function logPatternCount(container: string, pattern: string, sinceSeconds: number): number {
  const result = run("docker", ["logs", "--since", `${Math.max(1, Math.floor(sinceSeconds))}s`, container]);
  const haystack = `${result.stdout}\n${result.stderr}`;
  if (haystack.length === 0) {
    return 0;
  }
  let count = 0;
  for (const line of haystack.split("\n")) {
    if (line.includes(pattern)) {
      count += 1;
    }
  }
  return count;
}

export async function httpStatus(url: string, timeoutMs = 15_000): Promise<number | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.status;
  } catch {
    return null;
  }
}
