// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BASELINE_PATH } from "./check-mass-ratchet.mjs";
import { PROJECT_ROOT, measureMass, normalizeFileList, splitFilesArgument } from "./measure-mass.mjs";

const GIT_TARGET_PATHS = [
  "reference-implementation/server",
  "reference-implementation/lib",
  "reference-implementation/runtime",
];

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function runGit(args) {
  const result = await runCommand("git", args, { cwd: PROJECT_ROOT });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function gitRoot() {
  return runGit(["rev-parse", "--show-toplevel"]);
}

async function changedFilesForRange(range) {
  const [base, head] = parseRange(range);
  const stdout = await runGit(["diff", "--name-only", base, head, "--", ...GIT_TARGET_PATHS]);
  return normalizeFileList(stdout.split(/\r?\n/).filter(Boolean));
}

function parseRange(range) {
  const parts = range.split("..");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Expected --range in A..B form.");
  }
  return parts;
}

async function archiveReferenceImplementation(ref, destination) {
  const root = await gitRoot();
  await new Promise((resolve, reject) => {
    const git = spawn("git", ["archive", ref, "--", "reference-implementation"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tar = spawn("tar", ["-x", "-C", destination], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    git.stderr.setEncoding("utf8");
    tar.stderr.setEncoding("utf8");
    git.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    tar.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    git.stdout.pipe(tar.stdin);
    git.on("error", reject);
    tar.on("error", reject);
    tar.on("close", (tarStatus) => {
      if (tarStatus !== 0) {
        reject(new Error(stderr.trim() || "tar extraction failed"));
      } else {
        resolve();
      }
    });
    git.on("close", (gitStatus) => {
      if (gitStatus !== 0) {
        reject(new Error(stderr.trim() || "git archive failed"));
      }
    });
  });
}

async function measureRef(ref, files) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pdpp-mass-delta-"));
  try {
    await archiveReferenceImplementation(ref, tempDir);
    const rootDir = path.join(tempDir, "reference-implementation");
    return (
      await measureMass({
        files,
        rootDir,
        commandCwd: PROJECT_ROOT,
      })
    ).files;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function currentMass(files) {
  return (await measureMass({ files })).files;
}

async function baselineMass(files) {
  const raw = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  const all = raw.files ?? raw;
  return Object.fromEntries(files.map((file) => [file, all[file] ?? 0]));
}

function formatDelta(value) {
  if (value > 0) return `+${value}`;
  return String(value);
}

function printMarkdownTable(rows) {
  const totalBefore = rows.reduce((sum, row) => sum + row.before, 0);
  const totalAfter = rows.reduce((sum, row) => sum + row.after, 0);
  console.log("| File | Before | After | Delta |");
  console.log("| --- | ---: | ---: | ---: |");
  for (const row of rows) {
    console.log(`| \`${row.file}\` | ${row.before} | ${row.after} | ${formatDelta(row.delta)} |`);
  }
  console.log(`| **Total** | **${totalBefore}** | **${totalAfter}** | **${formatDelta(totalAfter - totalBefore)}** |`);
}

function parseArgs(argv) {
  let range = null;
  const files = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--range") {
      range = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--range=")) {
      range = arg.slice("--range=".length);
    } else if (arg === "--files") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        files.push(...splitFilesArgument(argv[i + 1]));
        i += 1;
      }
    } else if (arg.startsWith("--files=")) {
      files.push(...splitFilesArgument(arg.slice("--files=".length)));
    }
  }

  if (!range && files.length === 0) {
    throw new Error("Usage: mass-delta-report.mjs --range A..B | --files a,b,c");
  }

  return { range, files: normalizeFileList(files) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let files = args.files;
  let before;
  let after;

  if (args.range) {
    files = files.length > 0 ? files : await changedFilesForRange(args.range);
    const [base, head] = parseRange(args.range);
    [before, after] = await Promise.all([measureRef(base, files), measureRef(head, files)]);
  } else {
    before = await baselineMass(files);
    after = await currentMass(files);
  }

  const rows = files.map((file) => {
    const beforeMass = before[file] ?? 0;
    const afterMass = after[file] ?? 0;
    return {
      file,
      before: beforeMass,
      after: afterMass,
      delta: afterMass - beforeMass,
    };
  });

  printMarkdownTable(rows);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
