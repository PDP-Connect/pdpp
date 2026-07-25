// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Opt-in clean-shell command-freshness probe.
//
// The default freshness check (scan.ts) grounds "is this command published?"
// in the package *source* — fast, offline, and correct for the working tree.
// This module adds the stronger, owner-facing check the walkthrough implied:
// run the published package from a clean shell and confirm the subcommands the
// UI renders actually exist in what `npx` resolves.
//
// It is OFF by default because it executes `npx -y <pkg>@<tag>` against the
// registry (network + install). The CLI enables it with `--clean-shell`. Each
// package is invoked once with `--help`; rendered subcommands are checked
// against the help text. We never pass owner auth or secrets to these probes.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExecImpl = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number }
) => Promise<{ stdout: string; stderr: string }>;

export interface ProbeResult {
  error: string | null;
  help: string;
  ok: boolean;
}

interface ExecFailure {
  stderr?: string;
  stdout?: string;
}

/**
 * Run `npx -y <specifier> --help` from a throwaway working directory (so no
 * repo-local resolution can mask a missing published command) and return the
 * combined stdout/stderr. Failures are captured, not thrown.
 */
export async function probePackageHelp({
  specifier,
  timeoutMs = 120_000,
  execImpl = execFileAsync,
}: {
  specifier: string;
  timeoutMs?: number;
  execImpl?: ExecImpl;
}): Promise<ProbeResult> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "ojh-clean-shell-"));
    const { stdout, stderr } = await execImpl("npx", ["-y", specifier, "--help"], {
      cwd: dir,
      timeout: timeoutMs,
      // A clean environment: no owner auth, no PDPP_* leakage into the probe.
      env: sanitizedEnv(),
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, help: `${stdout ?? ""}\n${stderr ?? ""}`, error: null };
  } catch (err) {
    // `--help` may exit non-zero on some CLIs but still print usage; keep output.
    const failure = err as ExecFailure;
    const help = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim();
    return { ok: help.length > 0, help, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {
        // best-effort temp-dir cleanup only
      });
    }
  }
}

/** Strip PDPP_* / auth-bearing vars so a clean-shell probe is truly clean. */
const SENSITIVE_ENV_KEY_PATTERN = /TOKEN|COOKIE|SECRET|PASSWORD/i;

function sanitizedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("PDPP_") || SENSITIVE_ENV_KEY_PATTERN.test(k)) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

export interface RenderedCommand {
  packageName?: string;
  subcommand?: string;
}
export interface PublishedPackageMeta {
  binName: string;
  commandDispatchFile: string;
  specifier: string;
  verificationMode: string;
}
export interface CleanShellFinding {
  class: string;
  excerpt: string;
  line: number;
  path: string;
  rationale: string;
  ruleId: string;
}
export interface CleanShellProbeRecord {
  error: string | null;
  ok: boolean;
  package: string;
  specifier: string;
}

const REGEX_METACHARACTER_PATTERN = /[.*+?^${}()|[\]\\]/g;

/**
 * Verify each rendered PDPP-package command against the package's published
 * `--help`. A subcommand the help text never mentions is an unpublished-command
 * finding — the exact `owner-agent connectors explain` class from the
 * walkthrough.
 */
export async function checkCleanShellFreshness({
  renderedCommands,
  publishedPackages,
  probe = probePackageHelp,
}: {
  renderedCommands: RenderedCommand[];
  publishedPackages: Record<string, PublishedPackageMeta>;
  probe?: (args: { specifier: string }) => Promise<ProbeResult>;
}): Promise<{ findings: CleanShellFinding[]; probes: CleanShellProbeRecord[] }> {
  const findings: CleanShellFinding[] = [];
  const probes: CleanShellProbeRecord[] = [];
  // Probe each distinct package once.
  const byPackage = new Map<string, Set<string>>();
  for (const cmd of renderedCommands) {
    if (cmd.packageName && publishedPackages[cmd.packageName] && cmd.subcommand) {
      if (!byPackage.has(cmd.packageName)) {
        byPackage.set(cmd.packageName, new Set());
      }
      byPackage.get(cmd.packageName)?.add(cmd.subcommand);
    }
  }

  for (const [pkgName, subcommands] of byPackage) {
    const meta = publishedPackages[pkgName];
    if (!meta) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: preserves the original sequential probe order (one npx invocation per distinct package, not run concurrently); parallelizing is a behavior change out of scope for this migration.
    const result = await probe({ specifier: meta.specifier });
    probes.push({ package: pkgName, specifier: meta.specifier, ok: result.ok, error: result.error });
    if (!result.ok) {
      findings.push({
        ruleId: "clean-shell-probe-failed",
        class: "unpublished-command",
        path: `clean-shell:${meta.specifier}`,
        line: 0,
        excerpt: result.error ?? "probe produced no output",
        rationale: `Could not verify ${pkgName} from a clean shell (${meta.specifier}). The UI advertises its commands; the published package must resolve.`,
      });
      continue;
    }
    for (const sub of subcommands) {
      // Word-boundary match for the subcommand token in the help text.
      const re = new RegExp(`\\b${sub.replace(REGEX_METACHARACTER_PATTERN, "\\$&")}\\b`);
      if (!re.test(result.help)) {
        findings.push({
          ruleId: "clean-shell-missing-subcommand",
          class: "unpublished-command",
          path: `clean-shell:${meta.specifier}`,
          line: 0,
          excerpt: `${meta.binName} ${sub}`,
          rationale: `Subcommand '${sub}' rendered in owner UI is not present in the published ${meta.specifier} --help output.`,
        });
      }
    }
  }

  return { findings, probes };
}
