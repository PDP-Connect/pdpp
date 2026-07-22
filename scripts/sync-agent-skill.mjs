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

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function listFiles(root, prefix = "") {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function sync() {
  await fs.rm(DIST_ROOT, { force: true, recursive: true });
  for (const relativePath of FILES) {
    const sourcePath = path.join(SOURCE_ROOT, relativePath);
    const distPath = path.join(DIST_ROOT, relativePath);
    await fs.mkdir(path.dirname(distPath), { recursive: true });
    await fs.copyFile(sourcePath, distPath);
  }
}

async function check() {
  const problems = [];
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
