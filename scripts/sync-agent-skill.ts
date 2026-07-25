#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = path.join(REPO_ROOT, "docs/agent-skills/pdpp-data-access");
const DIST_ROOT = path.join(REPO_ROOT, "skills/pdpp-data-access");

const FILES = [
  "SKILL.md",
  "references/grant-design.md",
  "references/query-cookbook.md",
  "references/security.md",
  "references/troubleshooting.md",
];

const mode = process.argv.includes("--write") ? "write" : "check";

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

async function readIfExists(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      // biome-ignore lint/performance/noAwaitInLoops: recursive directory walk — each subdirectory's listing depends on nothing else, but sequential recursion keeps this a plain depth-first walk rather than an unbounded-fanout Promise.all over an unknown tree depth.
      files.push(...(await listFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort(compareStrings);
}

async function sync(): Promise<void> {
  await fs.rm(DIST_ROOT, { recursive: true, force: true });
  for (const relativePath of FILES) {
    const sourcePath = path.join(SOURCE_ROOT, relativePath);
    const distPath = path.join(DIST_ROOT, relativePath);
    // biome-ignore lint/performance/noAwaitInLoops: this is a small, fixed FILES list — sequential mkdir+copy keeps a failure attributable to one file instead of a partial concurrent write.
    await fs.mkdir(path.dirname(distPath), { recursive: true });
    await fs.copyFile(sourcePath, distPath);
  }
}

async function check(): Promise<void> {
  const problems: string[] = [];
  const expected = [...FILES].sort();
  const actual = await listFiles(DIST_ROOT);

  const extraFiles = actual.filter((file) => !expected.includes(file));
  const missingFiles = expected.filter((file) => !actual.includes(file));
  for (const file of missingFiles) {
    problems.push(`missing ${path.join("skills/pdpp-data-access", file)}`);
  }
  for (const file of extraFiles) {
    problems.push(`unexpected ${path.join("skills/pdpp-data-access", file)}`);
  }

  for (const relativePath of expected) {
    // biome-ignore lint/performance/noAwaitInLoops: this is a small, fixed FILES list — sequential drift checks keep each file's problem message ordered and attributable.
    const source = await readIfExists(path.join(SOURCE_ROOT, relativePath));
    const dist = await readIfExists(path.join(DIST_ROOT, relativePath));
    if (!(source && dist)) {
      continue;
    }
    if (!source.equals(dist)) {
      problems.push(`drift ${relativePath}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "pdpp-data-access skill distribution is out of sync.",
        ...problems.map((problem) => `- ${problem}`),
        "Run `pnpm agent-skill:sync` and review the generated dist copy.",
      ].join("\n")
    );
  }
}

if (mode === "write") {
  await sync();
} else {
  await check();
}
