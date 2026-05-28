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

const openSpecBuckets = classifyOpenSpecChanges(openSpecChanges);
const wrapperLanes = loadWrapperLanes(join(repoRoot, "tmp", "workstreams", "claude-wrapper"));

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
for (const lane of wrapperLanes) {
  if (lane.status === "failed") {
    risks.push(`WRAPPER-LANE failed lane=${lane.lane} run=${lane.startedAt} report_state=${lane.reportState}`);
  } else if (lane.status === "running") {
    risks.push(`WRAPPER-LANE still-running lane=${lane.lane} started=${lane.startedAt}`);
  }
  // "aborted" = process was killed before completing; surfaces in the Wrapper Lanes table but
  // is historical evidence, not a live risk requiring owner action.
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

// Group OpenSpec changes by task-completion status so the in-flight bucket
// surfaces above the complete-but-not-archived backlog. Archive is owner-only
// per AGENTS.md, so completed changes accumulate until an owner sweep — without
// grouping, the in-flight set drowns in noise.
printSection(
  `OpenSpec Changes — In-flight (${openSpecBuckets.inFlight.length})`,
  openSpecBuckets.inFlight.map(formatOpenSpecLine)
);

printSection(
  `OpenSpec Changes — Zero-progress (${openSpecBuckets.zeroProgress.length})`,
  openSpecBuckets.zeroProgress.map(formatOpenSpecLine)
);

printSection(
  `OpenSpec Changes — Complete, awaiting owner archive (${openSpecBuckets.complete.length})`,
  openSpecBuckets.complete.map(formatOpenSpecLine)
);

if (openSpecBuckets.untracked.length > 0) {
  printSection(
    `OpenSpec Changes — Without task tracking (${openSpecBuckets.untracked.length})`,
    openSpecBuckets.untracked.map((entry) => `- ${entry.name}`)
  );
}

printSection(
  "Workstream Cards",
  cardFiles.map((entry) => `- ${entry.rel} age=${entry.ageHours}h first-line=${JSON.stringify(readFirstHeading(entry))}`)
);

printSection(
  "Claude Wrapper Lanes",
  wrapperLanes.length === 0
    ? []
    : wrapperLanes.map((lane) => {
        const recovered = lane.recovered ? " recovered=true" : "";
        const branch = lane.branch ? ` branch=${lane.branch}` : "";
        return `- [${lane.status}] lane=${lane.lane}${branch} run=${lane.startedAt} report=${lane.reportState}${recovered}`;
      })
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

function classifyOpenSpecChanges(names) {
  const buckets = { inFlight: [], zeroProgress: [], complete: [], untracked: [] };
  for (const name of names) {
    const tasksFile = join(repoRoot, "openspec", "changes", name, "tasks.md");
    if (!existsSync(tasksFile)) {
      buckets.untracked.push({ name, done: 0, total: 0 });
      continue;
    }
    const body = readFileSync(tasksFile, "utf8");
    let done = 0;
    let total = 0;
    for (const line of body.split("\n")) {
      if (/^\s*- \[x\]/i.test(line)) {
        done += 1;
        total += 1;
      } else if (/^\s*- \[ \]/.test(line)) {
        total += 1;
      }
    }
    const entry = { name, done, total };
    if (total === 0) {
      buckets.untracked.push(entry);
    } else if (done === 0) {
      buckets.zeroProgress.push(entry);
    } else if (done === total) {
      buckets.complete.push(entry);
    } else {
      buckets.inFlight.push(entry);
    }
  }
  // Sort in-flight by least-progressed first so stuck changes surface at the top.
  buckets.inFlight.sort((a, b) => a.done / a.total - b.done / b.total || a.name.localeCompare(b.name));
  return buckets;
}

function formatOpenSpecLine(entry) {
  const ratio = `[${String(entry.done).padStart(2, " ")}/${String(entry.total).padStart(2, " ")}]`;
  return `- ${ratio} ${entry.name}`;
}

// Scan tmp/workstreams/claude-wrapper/<lane>/<ts>/status.json.
// Returns one entry per lane: the most recent run for each lane name.
function loadWrapperLanes(wrapperDir) {
  if (!existsSync(wrapperDir)) return [];
  const byLane = new Map();
  for (const laneEntry of readdirSync(wrapperDir, { withFileTypes: true })) {
    if (!laneEntry.isDirectory()) continue;
    const laneName = laneEntry.name;
    const laneDir = join(wrapperDir, laneName);
    const runs = readdirSync(laneDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (runs.length === 0) continue;
    const latestRun = runs[runs.length - 1];
    const statusFile = join(laneDir, latestRun, "status.json");
    if (!existsSync(statusFile)) continue;
    try {
      const data = JSON.parse(readFileSync(statusFile, "utf8"));
      byLane.set(laneName, {
        lane: data.lane ?? laneName,
        branch: data.branch ?? "",
        status: data.status ?? "unknown",
        reportState: data.report_state ?? "unknown",
        recovered: data.recovered ?? false,
        startedAt: data.started_at ?? latestRun,
        endedAt: data.ended_at ?? "",
        exitCode: data.exit_code ?? -1,
      });
    } catch {
      // Corrupt status.json — surface as a failed lane.
      byLane.set(laneName, {
        lane: laneName,
        branch: "",
        status: "failed",
        reportState: "absent",
        recovered: false,
        startedAt: latestRun,
        endedAt: "",
        exitCode: -1,
      });
    }
  }
  return [...byLane.values()].sort((a, b) => a.lane.localeCompare(b.lane));
}
