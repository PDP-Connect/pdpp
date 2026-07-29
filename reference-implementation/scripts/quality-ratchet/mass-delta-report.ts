// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BASELINE_PATH } from "./check-mass-ratchet.ts";
import type { MassObject } from "./measure-mass.ts";
import { measureMass, normalizeFileList, PROJECT_ROOT, splitFilesArgument } from "./measure-mass.ts";

const GIT_TARGET_PATHS = [
  "reference-implementation/server",
  "reference-implementation/lib",
  "reference-implementation/runtime",
];

const LINE_SPLIT_PATTERN = /\r?\n/;

interface RunCommandResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function runCommand(command: string, args: string[], options: { cwd?: string } = {}): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr, stdout }));
  });
}

async function runGit(args: string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd: PROJECT_ROOT });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function gitRoot(): Promise<string> {
  return runGit(["rev-parse", "--show-toplevel"]);
}

async function changedFilesForRange(range: string): Promise<string[]> {
  const [base, head] = parseRange(range);
  const stdout = await runGit(["diff", "--name-only", base, head, "--", ...GIT_TARGET_PATHS]);
  return normalizeFileList(stdout.split(LINE_SPLIT_PATTERN).filter(Boolean));
}

function parseRange(range: string): [string, string] {
  const parts = range.split("..");
  const [base, head] = parts;
  if (parts.length !== 2 || !base || !head) {
    throw new Error("Expected --range in A..B form.");
  }
  return [base, head];
}

async function archiveReferenceImplementation(ref: string, destination: string): Promise<void> {
  const root = await gitRoot();
  await new Promise<void>((resolve, reject) => {
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
    git.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    tar.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    git.stdout.pipe(tar.stdin);
    git.on("error", reject);
    tar.on("error", reject);
    tar.on("close", (tarStatus) => {
      if (tarStatus === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || "tar extraction failed"));
      }
    });
    git.on("close", (gitStatus) => {
      if (gitStatus !== 0) {
        reject(new Error(stderr.trim() || "git archive failed"));
      }
    });
  });
}

async function measureRef(ref: string, files: string[]): Promise<MassObject> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pdpp-mass-delta-"));
  try {
    await archiveReferenceImplementation(ref, tempDir);
    const rootDir = path.join(tempDir, "reference-implementation");
    return (
      await measureMass({
        commandCwd: PROJECT_ROOT,
        files,
        rootDir,
      })
    ).files;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function currentMass(files: string[]): Promise<MassObject> {
  return (await measureMass({ files })).files;
}

async function baselineMass(files: string[]): Promise<MassObject> {
  const raw: { files?: MassObject } & MassObject = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  const all = raw.files ?? raw;
  return Object.fromEntries(files.map((file) => [file, all[file] ?? 0]));
}

function formatDelta(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }
  return String(value);
}

interface DeltaRow {
  after: number;
  before: number;
  delta: number;
  file: string;
}

function printMarkdownTable(rows: DeltaRow[]): void {
  const totalBefore = rows.reduce((sum, row) => sum + row.before, 0);
  const totalAfter = rows.reduce((sum, row) => sum + row.after, 0);
  console.log("| File | Before | After | Delta |");
  console.log("| --- | ---: | ---: | ---: |");
  for (const row of rows) {
    console.log(`| \`${row.file}\` | ${row.before} | ${row.after} | ${formatDelta(row.delta)} |`);
  }
  console.log(`| **Total** | **${totalBefore}** | **${totalAfter}** | **${formatDelta(totalAfter - totalBefore)}** |`);
}

interface ParsedArgs {
  files: string[];
  range: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let range: string | null = null;
  const files: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--range") {
      range = argv[i + 1] ?? null;
      i += 1;
    } else if (arg?.startsWith("--range=")) {
      range = arg.slice("--range=".length);
    } else if (arg === "--files") {
      let next = argv[i + 1];
      while (next && !next.startsWith("--")) {
        files.push(...splitFilesArgument(next));
        i += 1;
        next = argv[i + 1];
      }
    } else if (arg?.startsWith("--files=")) {
      files.push(...splitFilesArgument(arg.slice("--files=".length)));
    }
  }

  if (!range && files.length === 0) {
    throw new Error("Usage: mass-delta-report.ts --range A..B | --files a,b,c");
  }

  return { files: normalizeFileList(files), range };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let { files } = args;
  let before: MassObject;
  let after: MassObject;

  if (args.range) {
    files = files.length > 0 ? files : await changedFilesForRange(args.range);
    const [base, head] = parseRange(args.range);
    [before, after] = await Promise.all([measureRef(base, files), measureRef(head, files)]);
  } else {
    before = await baselineMass(files);
    after = await currentMass(files);
  }

  const rows: DeltaRow[] = files.map((file) => {
    const beforeMass = before[file] ?? 0;
    const afterMass = after[file] ?? 0;
    return {
      after: afterMass,
      before: beforeMass,
      delta: afterMass - beforeMass,
      file,
    };
  });

  printMarkdownTable(rows);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
