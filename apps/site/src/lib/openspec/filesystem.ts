// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import path from "node:path";

let cachedRepoRoot: string | null = null;

export async function resolveRepoRoot(): Promise<string> {
  if (cachedRepoRoot) {
    return cachedRepoRoot;
  }

  let dir = process.cwd();
  const { root } = path.parse(dir);

  while (true) {
    const hasWorkspace = await fileExists(path.join(dir, "pnpm-workspace.yaml"));
    const hasOpenSpec = await dirExists(path.join(dir, "openspec"));
    if (hasWorkspace && hasOpenSpec) {
      cachedRepoRoot = dir;
      return dir;
    }
    if (dir === root) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  throw new Error(
    `Repo-root resolver: could not resolve repo root from ${process.cwd()} ` +
      "(needs a directory containing both pnpm-workspace.yaml and openspec/)."
  );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
