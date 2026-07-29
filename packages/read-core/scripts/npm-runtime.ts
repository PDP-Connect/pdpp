// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const npmCandidates = process.platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];
const npmVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface BoundedRuntimeEnvironment extends NodeJS.ProcessEnv {
  PATH: string;
  Path?: string;
}

export interface NpmRuntime {
  env: BoundedRuntimeEnvironment;
  executable: string;
  version: string;
}

export function boundRuntimeEnvironment({
  env = process.env,
  nodePath = process.execPath,
}: {
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
} = {}): BoundedRuntimeEnvironment {
  const runtimeDirectory = path.dirname(nodePath);
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const boundPath = [runtimeDirectory, env[pathKey], env.PATH]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(path.delimiter);

  return {
    ...env,
    [pathKey]: boundPath,
    PATH: boundPath,
  } as BoundedRuntimeEnvironment;
}

export async function resolveNpmExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const pathValue = env.PATH ?? env.Path ?? "";
  const candidates = pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => npmCandidates.map((candidate) => path.resolve(directory, candidate)));
  const checks = await Promise.all(
    candidates.map(async (executable) => {
      try {
        await access(executable, constants.X_OK);
        return executable;
      } catch {
        return null;
      }
    })
  );
  const resolvedExecutable = checks.find((candidate): candidate is string => candidate !== null);
  if (resolvedExecutable) {
    return resolvedExecutable;
  }
  throw new Error(`npm executable was not found in PATH: ${pathValue}`);
}

export async function readNpmVersion(npmExecutable: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(npmExecutable, ["--version"], { env });
  const version = stdout.trim();
  assert.match(version, npmVersionPattern, `npm --version must be a semantic version: ${version}`);
  return version;
}

export async function resolveNpmRuntime(env: NodeJS.ProcessEnv = process.env): Promise<NpmRuntime> {
  const executable = await resolveNpmExecutable(env);
  const version = await readNpmVersion(executable, env);
  return { env: env as BoundedRuntimeEnvironment, executable, version };
}

export function assertNpmBinding(
  actual: { executable: string; version: string },
  expected: { executable: string; version: string }
): void {
  assert.equal(actual.executable, expected.executable, "npm executable drifted during package verification");
  assert.equal(actual.version, expected.version, "npm version drifted during package verification");
}

export async function runNpm(
  runtime: NpmRuntime,
  args: string[],
  options: Record<string, unknown> = {}
): Promise<{ stdout: string; stderr: string }> {
  const current = {
    executable: runtime.executable,
    version: await readNpmVersion(runtime.executable, runtime.env),
  };
  assertNpmBinding(current, runtime);
  return execFileAsync(runtime.executable, args, {
    maxBuffer: 1024 * 1024,
    ...options,
    env: runtime.env,
  }) as Promise<{ stdout: string; stderr: string }>;
}
