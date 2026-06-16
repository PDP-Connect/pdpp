#!/usr/bin/env node
// Classify active OpenSpec changes by task-completion ratio.
//
// Output groups every non-archived change under one of:
//   - in-flight: at least one task done, at least one task open
//   - zero-progress: no tasks done
//   - complete: all tasks done (awaiting owner archive sweep; archive is owner-only)
//
// Default mode prints a compact summary to stdout. Use --json to emit a
// machine-readable shape for tooling.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const repoRoot = resolve(here, "..", "..");
const changesDir = join(repoRoot, "openspec", "changes");

const wantJson = process.argv.includes("--json");

function classify(changeName) {
  const tasksFile = join(changesDir, changeName, "tasks.md");
  if (!existsSync(tasksFile)) {
    return { name: changeName, done: 0, total: 0, status: "no-tasks-file" };
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
  let status;
  if (total === 0) {
    status = "no-tasks";
  } else if (done === 0) {
    status = "zero-progress";
  } else if (done === total) {
    status = "complete";
  } else {
    status = "in-flight";
  }
  return { name: changeName, done, total, status };
}

function listActiveChanges() {
  if (!existsSync(changesDir)) {
    return [];
  }
  return readdirSync(changesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "archive")
    .map((entry) => entry.name)
    .sort();
}

const records = listActiveChanges().map(classify);

const byStatus = {
  "in-flight": [],
  "zero-progress": [],
  complete: [],
  "no-tasks": [],
  "no-tasks-file": [],
};
for (const record of records) {
  byStatus[record.status].push(record);
}

// Sort in-flight by progress (least-progressed first) so the loudest
// "stuck" changes surface at the top.
byStatus["in-flight"].sort((a, b) => {
  const ratioA = a.done / a.total;
  const ratioB = b.done / b.total;
  if (ratioA !== ratioB) {
    return ratioA - ratioB;
  }
  return a.name.localeCompare(b.name);
});

if (wantJson) {
  console.log(JSON.stringify({ records, byStatus }, null, 2));
  process.exit(0);
}

function formatBucket(label, items, { showRatio = true } = {}) {
  console.log(`\n## ${label} (${items.length})`);
  if (items.length === 0) {
    console.log("OK: none");
    return;
  }
  for (const item of items) {
    if (showRatio && item.total > 0) {
      const ratio = `[${String(item.done).padStart(2, " ")}/${String(item.total).padStart(2, " ")}]`;
      console.log(`- ${ratio} ${item.name}`);
    } else {
      console.log(`- ${item.name}`);
    }
  }
}

console.log("# OpenSpec change status");
console.log(`Repo: ${repoRoot}`);
console.log(`Active changes: ${records.length} (archive bucket not scanned)`);

formatBucket("In-flight (some tasks done, some open)", byStatus["in-flight"]);
formatBucket("Zero-progress (proposed, no tasks done yet)", byStatus["zero-progress"]);
formatBucket(
  "Complete (all tasks done — awaiting owner archive sweep)",
  byStatus.complete
);

if (byStatus["no-tasks"].length > 0 || byStatus["no-tasks-file"].length > 0) {
  formatBucket("Without task tracking", [...byStatus["no-tasks"], ...byStatus["no-tasks-file"]], {
    showRatio: false,
  });
}
