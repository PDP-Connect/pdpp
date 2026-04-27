#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = exec("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() }).trim();
const commonGitDir = resolve(repoRoot, exec("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot }).trim());
const tmpReportsDir = join(repoRoot, "tmp", "workstreams");
const hubDir = join(commonGitDir, "workstreams");

const now = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const noFail = process.argv.includes("--no-fail");

function exec(cmd, args, { cwd = repoRoot, allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFail) {
      return "";
    }
    const stderr = error.stderr ? String(error.stderr) : "";
    const stdout = error.stdout ? String(error.stdout) : "";
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${stderr || stdout}`);
  }
}

function listFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function parseWorktrees() {
  const raw = exec("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const blocks = raw.trim().split(/\n\n+/).filter(Boolean);
  return blocks.map((block) => {
    const item = { path: "", head: "", branch: "", detached: false };
    for (const line of block.split("\n")) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") item.path = value;
      if (key === "HEAD") item.head = value;
      if (key === "branch") item.branch = value.replace(/^refs\/heads\//, "");
      if (key === "detached") item.detached = true;
    }
    if (!item.branch) {
      item.branch = item.detached ? "(detached)" : "(unknown)";
    }
    return item;
  });
}

function branchStatus(cwd, branch) {
  const status = exec("git", ["status", "--short", "--branch"], { cwd, allowFail: true }).trim();
  const lines = status.split("\n").filter(Boolean);
  const header = lines[0] ?? "";
  const dirty = lines.slice(1);
  const aheadBehind = header.match(/\[(?<body>[^\]]+)\]/)?.groups?.body ?? "";
  const ahead = Number(aheadBehind.match(/ahead (?<n>\d+)/)?.groups?.n ?? 0);
  const behind = Number(aheadBehind.match(/behind (?<n>\d+)/)?.groups?.n ?? 0);
  const upstream = header.match(/## [^.]+\.{3}(?<upstream>[^\s\[]+)/)?.groups?.upstream ?? "";
  const unmergedMain =
    branch && branch !== "main" && branch !== "(detached)" && branch !== "(unknown)"
      ? exec("git", ["rev-list", "--count", `main..${branch}`], { cwd, allowFail: true }).trim()
      : "0";
  return {
    ahead,
    behind,
    dirty,
    header,
    upstream,
    unmergedMain: Number(unmergedMain || 0),
  };
}

function parseTmuxPanes() {
  const raw = exec(
    "tmux",
    [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}",
    ],
    { allowFail: true }
  ).trim();
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [paneId, session, windowIndex, windowName, command, path] = line.split("\t");
      return { paneId, session, windowIndex, windowName, command, path };
    })
    .filter((pane, index, panes) => panes.findIndex((candidate) => candidate.paneId === pane.paneId) === index);
}

function fileInfo(file) {
  const stat = statSync(file);
  return {
    file,
    rel: relative(repoRoot, file),
    mtimeMs: stat.mtimeMs,
    ageHours: Math.round(((now - stat.mtimeMs) / (60 * 60 * 1000)) * 10) / 10,
  };
}

function readFirstHeading(file) {
  try {
    const body = readFileSync(file, "utf8");
    return body.split("\n").find((line) => line.trim())?.slice(0, 140) ?? "";
  } catch {
    return "";
  }
}

function printSection(title, lines) {
  console.log(`\n## ${title}`);
  if (lines.length === 0) {
    console.log("OK: none");
    return;
  }
  for (const line of lines) {
    console.log(line);
  }
}

const worktrees = parseWorktrees().map((worktree) => ({
  ...worktree,
  status: branchStatus(worktree.path, worktree.branch),
}));
const tmuxPanes = parseTmuxPanes();
const claudePanes = tmuxPanes.filter((pane) => pane.command === "claude");
const reportFiles = listFiles(tmpReportsDir).filter((file) => file.endsWith(".md")).map(fileInfo);
const recentReports = reportFiles.filter((report) => now - report.mtimeMs < 3 * DAY_MS);
const mergeQueueFiles = listFiles(join(hubDir, "merge-queue")).filter((file) => file.endsWith(".md")).map(fileInfo);
const blockerFiles = listFiles(join(hubDir, "blockers")).filter((file) => file.endsWith(".md")).map(fileInfo);
const cardFiles = listFiles(join(hubDir, "cards")).filter((file) => file.endsWith(".md")).map(fileInfo);
const openSpecChanges = listFiles(join(repoRoot, "openspec", "changes"))
  .filter((file) => file.endsWith("proposal.md"))
  .map((file) => relative(join(repoRoot, "openspec", "changes"), file).replace(/\/proposal\.md$/, ""))
  .filter((name) => !name.startsWith("archive/"))
  .sort();

const risks = [];

for (const worktree of worktrees) {
  if (worktree.status.dirty.length > 0) {
    risks.push(`DIRTY worktree ${labelWorktree(worktree)} has ${worktree.status.dirty.length} changed paths`);
  }
  if (worktree.status.ahead > 0) {
    risks.push(`UNPUSHED ${labelWorktree(worktree)} is ahead of upstream by ${worktree.status.ahead}`);
  }
}

for (const pane of claudePanes) {
  const inRepo = pane.path?.startsWith(repoRoot);
  const inWorktree = worktrees.some((worktree) => sameOrChild(pane.path, worktree.path));
  if (inRepo && !inWorktree) {
    risks.push(`CLAUDE pane ${pane.session}:${pane.windowIndex}:${pane.windowName} is in repo path but not a listed worktree`);
  }
}

for (const queue of mergeQueueFiles) {
  risks.push(`MERGE-QUEUE pending ${queue.rel} (${queue.ageHours}h old)`);
}
for (const blocker of blockerFiles) {
  risks.push(`BLOCKER pending ${blocker.rel} (${blocker.ageHours}h old)`);
}

console.log("# PDPP Workstreams Status");
console.log(`Generated: ${new Date().toISOString()}`);
console.log(`Repo: ${repoRoot}`);
console.log(`Git common dir: ${commonGitDir}`);

printSection(
  "Risks Requiring Owner Attention",
  risks.length === 0 ? [] : risks.map((risk) => `! ${risk}`)
);

printSection(
  "Claude Tmux Panes",
  claudePanes.map(
    (pane) =>
      `- ${pane.paneId} ${pane.session}:${pane.windowIndex}:${pane.windowName} cmd=${pane.command} path=${formatPath(pane.path)}`
  )
);

printSection(
  "Git Worktrees",
  worktrees.map((worktree) => {
    const dirty = worktree.status.dirty.length ? ` dirty=${worktree.status.dirty.length}` : "";
    const ahead = worktree.status.ahead ? ` ahead=${worktree.status.ahead}` : "";
    const behind = worktree.status.behind ? ` behind=${worktree.status.behind}` : "";
    const unmerged = worktree.status.unmergedMain ? ` unmerged-main=${worktree.status.unmergedMain}` : "";
    return `- ${labelWorktree(worktree)}${dirty}${ahead}${behind}${unmerged}`;
  })
);

printSection(
  "Unmerged Branch Inventory",
  worktrees
    .filter((worktree) => worktree.status.unmergedMain > 0)
    .map((worktree) => `- ${labelWorktree(worktree)} unmerged-main=${worktree.status.unmergedMain}`)
);

printSection(
  "Recent Worker Reports",
  recentReports
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 30)
    .map((report) => `- ${report.rel} age=${report.ageHours}h first-line=${JSON.stringify(readFirstHeading(report))}`)
);

printSection(
  "Merge Queue",
  mergeQueueFiles.map((entry) => `- ${entry.rel} age=${entry.ageHours}h first-line=${JSON.stringify(readFirstHeading(entry))}`)
);

printSection(
  "Blockers",
  blockerFiles.map((entry) => `- ${entry.rel} age=${entry.ageHours}h first-line=${JSON.stringify(readFirstHeading(entry))}`)
);

printSection(
  "OpenSpec Changes",
  openSpecChanges.map((name) => `- ${name}`)
);

printSection(
  "Workstream Cards",
  cardFiles.map((entry) => `- ${entry.rel} age=${entry.ageHours}h first-line=${JSON.stringify(readFirstHeading(entry))}`)
);

if (risks.length > 0 && !noFail) {
  process.exitCode = 1;
}

function labelWorktree(worktree) {
  return `${worktree.branch} @ ${formatPath(worktree.path)}`;
}

function formatPath(path) {
  if (!path) return "(unknown)";
  return path.startsWith(repoRoot) ? relative(repoRoot, path) || "." : path;
}

function sameOrChild(child, parent) {
  if (!(child && parent)) return false;
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !resolve(parent, rel).startsWith(".."));
}
