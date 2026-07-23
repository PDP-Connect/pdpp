// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { access, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const npmCandidates = process.platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];

export function boundRuntimeEnvironment({ env = process.env, nodePath = process.execPath } = {}) {
  const runtimeDirectory = path.dirname(nodePath);
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const boundPath = [runtimeDirectory, env[pathKey], env.PATH]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(path.delimiter);

  return {
    ...env,
    [pathKey]: boundPath,
    PATH: boundPath,
  };
}

export async function resolveNpmExecutable(env = process.env) {
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidate of npmCandidates) {
      const executable = path.resolve(directory, candidate);
      try {
        await access(executable, constants.X_OK);
        return executable;
      } catch {
        // Continue searching the PATH in the same order the process launcher uses.
      }
    }
  }
  throw new Error(`npm executable was not found in PATH: ${pathValue}`);
}

export async function readNpmVersion(npmExecutable, env) {
  const { stdout } = await execFileAsync(npmExecutable, ['--version'], { env });
  const version = stdout.trim();
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, `npm --version must be a semantic version: ${version}`);
  return version;
}

export async function resolveNpmRuntime(env = process.env) {
  const executable = await resolveNpmExecutable(env);
  const version = await readNpmVersion(executable, env);
  return { env, executable, version };
}

export function assertNpmBinding(actual, expected) {
  assert.equal(actual.executable, expected.executable, 'npm executable drifted during package verification');
  assert.equal(actual.version, expected.version, 'npm version drifted during package verification');
}

export async function runNpm(runtime, args, options = {}) {
  const current = {
    executable: runtime.executable,
    version: await readNpmVersion(runtime.executable, runtime.env),
  };
  assertNpmBinding(current, runtime);
  return execFileAsync(runtime.executable, args, {
    maxBuffer: 1024 * 1024,
    ...options,
    env: runtime.env,
  });
}
