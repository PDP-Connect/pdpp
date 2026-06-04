/**
 * Reusable external-tool adapter for OSS-wrapping connectors.
 *
 * Generalizes the proven slackdump wrap (`connectors/slack/index.ts`): resolve a
 * binary (env override → PATH), spawn it arms-length, surface a clear
 * missing-binary error with install hints, and (for JSONL/JSON-on-stdout tools
 * like HPI) parse its output into records. This is how PDPP scales OOTB
 * connectors by delegating to maintained OSS tools instead of hand-authoring +
 * testing each source.
 *
 * Tools that emit a side artifact (slackdump → SQLite) keep their own readback;
 * this module covers the common stdout-streaming case (HPI `hpi query … -o json`,
 * DiscordChatExporter `-f Json`, rexport JSON, tg-archive, etc.) plus the shared
 * binary-resolution + spawn + honesty plumbing every wrap needs.
 *
 * Boundary: no browser/runtime-only imports — filesystem-class connectors and
 * the local-collector runner can import this.
 */

import { spawn } from "node:child_process";

/** Declaration of the external tool a connector wraps (mirrors manifest entry). */
export interface ExternalToolSpec {
  /** Env var that overrides the binary path, e.g. "HPI_BIN". */
  readonly binEnvVar: string;
  /** Default binary name on PATH when the env var is unset. */
  readonly defaultBin: string;
  /** Default spawn timeout in ms (default 1h). */
  readonly defaultTimeoutMs?: number;
  /** Human-facing install hint shown when the binary is missing. */
  readonly installHint: string;
  /** Tool name, e.g. "hpi", "slackdump", "DiscordChatExporter". Must match the
   * manifest `runtime_requirements.external_tools[].name` (honesty test). */
  readonly name: string;
  /** Env var that overrides the spawn timeout in ms (optional). */
  readonly timeoutEnvVar?: string;
}

export interface SpawnResult {
  readonly stderr: string;
  readonly stdout: string;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/** Resolve the tool binary: env override wins, else the default on PATH. */
export function resolveToolBin(spec: ExternalToolSpec): string {
  return process.env[spec.binEnvVar] || spec.defaultBin;
}

/** Build the standard missing-binary error message with install guidance. */
export function formatMissingToolError(spec: ExternalToolSpec, bin: string): string {
  return [
    `${spec.name} binary not found: ${bin}`,
    `Install ${spec.name} and either put it on PATH or set ${spec.binEnvVar} to its absolute path.`,
    spec.installHint,
  ].join(" ");
}

function resolveTimeoutMs(spec: ExternalToolSpec): number {
  const fromEnv = spec.timeoutEnvVar ? Number(process.env[spec.timeoutEnvVar]) : Number.NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return spec.defaultTimeoutMs ?? 60 * 60 * 1000;
}

/**
 * Spawn an external tool arms-length and capture stdout/stderr. Rejects with a
 * clear ENOENT-translated error when the binary is missing, a `<name>_timeout`
 * error on timeout, and a `<name>_exit_<code>` error on non-zero exit.
 */
export function runExternalTool(
  spec: ExternalToolSpec,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; stdin?: string } = {}
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const bin = resolveToolBin(spec);
    const child = spawn(bin, [...args], {
      env: options.env ?? process.env,
      ...(options.cwd == null ? {} : { cwd: options.cwd }),
      stdio: [options.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${spec.name}_timeout`));
    }, resolveTimeoutMs(spec));
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${spec.name}_exit_${code}: ${stderr.slice(0, 400) || stdout.slice(0, 400)}`));
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      if (isErrnoException(e) && e.code === "ENOENT") {
        reject(new Error(formatMissingToolError(spec, bin)));
        return;
      }
      reject(e);
    });
    if (options.stdin != null) {
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    }
  });
}

/**
 * Parse a tool's stdout as records. Accepts either a JSON array (the default of
 * `hpi query -o json`) or JSONL (one object per line, `hpi query --stream`).
 * Non-object lines are skipped. This is the common readback for JSON-emitting
 * OSS tools.
 */
export function parseToolRecords(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isPlainObject) : [];
  }
  // JSONL fallback.
  const records: Record<string, unknown>[] = [];
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      const obj = JSON.parse(t) as unknown;
      if (isPlainObject(obj)) {
        records.push(obj);
      }
    } catch {
      // Skip non-JSON progress/log lines the tool may interleave.
    }
  }
  return records;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
