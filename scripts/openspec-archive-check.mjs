#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Flag OpenSpec changes that are archive-due but still sitting active.
//
// The OpenSpec process is worth keeping for ratifying design/contract
// decisions, but implemented changes rot under `openspec/changes/` because the
// *post-merge* half of the closeout never happens: live-deploy and owner-review
// checkboxes structurally never get ticked (they are the owner's, not the
// merger's), so `openspec/README.md`'s "a ✓ Complete change should not remain
// active for more than one merge cycle" rule is never triggered and nobody
// archives anything.
//
// This check surfaces that rot mechanically. A change under
// `openspec/changes/` (excluding `archive/`) is ARCHIVE-DUE when EITHER:
//
//   (1) all of its *implementation* checkboxes are done — where implementation
//       excludes owner/deploy/live-acceptance gate sections, the checkboxes
//       that never get ticked by design; OR
//   (2) the concrete code paths it references now exist on the target ref
//       (default `main`) — i.e. the work has landed even if the boxes weren't
//       updated.
//
// It is a REPORTER, not a gate: it prints archive-due changes and exits 0 so it
// can run as a non-blocking pre-push warning and a non-failing CI step. Pass
// `--strict` to exit non-zero when anything is archive-due (for a human-run
// audit), and `--json` for a machine-readable shape.
//
// Usage:
//   node scripts/openspec-archive-check.mjs
//   node scripts/openspec-archive-check.mjs --json
//   node scripts/openspec-archive-check.mjs --strict
//   node scripts/openspec-archive-check.mjs --ref origin/main
//
// The code-exists probe reads paths from the target git ref so it is stable in
// CI (where the working tree is the branch under test). If the ref is absent
// (shallow clone, fresh repo) it falls back to the working tree and says so.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const repoRoot = resolve(here, "..", "..");
const changesDir = join(repoRoot, "openspec", "changes");

// ---------------------------------------------------------------------------
// Section classification.
//
// tasks.md sections come in two flavors:
//   - implementation: the code/tests/spec-delta work a contributor can finish
//     and tick honestly as it lands.
//   - post-merge gate: owner review, live deploy, live acceptance, the "return
//     gate" preambles. These are the owner's to verify against production and
//     are the checkboxes that never get ticked. Per openspec/README.md they are
//     residual risk, not blockers — so they must NOT hold a change active.
//
// We classify by the section HEADER text. A section is a post-merge gate when
// its header matches any of these markers (case-insensitive, whole-word-ish).
// ---------------------------------------------------------------------------
const POST_MERGE_SECTION_PATTERNS = [
  /\bowner\b/i, // "Owner Decisions", "RI Owner Return Gate", "Live Owner Gate"
  /\blive\b/i, // "Live Acceptance", "Live rollout", "Live Owner Gate"
  /\bdeploy(ment)?\b/i, // "Deployment Posture", "Deploy gate"
  /\brollout\b/i, // "Live rollout (owner)"
  /\bpublish\b/i, // "Publish Gate", "Publish-Readiness" is impl though — see note
  /\bacceptance\b/i, // "Acceptance checks" / "Acceptance Checks" / "Acceptance gate"
  /\breturn gate\b/i,
];

// Publish-*readiness* metadata authoring is implementation work; only the
// owner-gated "Publish Gate" gate itself is post-merge. Keep the impl ones in.
const POST_MERGE_SECTION_EXCEPTIONS = [/publish-?readiness/i];

/** True when a section header is a post-merge / owner gate, not impl work. */
export function isPostMergeSection(header) {
  const text = header.replace(/^#+\s*/, "").trim();
  if (POST_MERGE_SECTION_EXCEPTIONS.some((re) => re.test(text))) {
    return false;
  }
  return POST_MERGE_SECTION_PATTERNS.some((re) => re.test(text));
}

const CHECKED = /^\s*- \[x\]/i;
const UNCHECKED = /^\s*- \[ \]/;
const SECTION = /^##\s+.+/;

/**
 * Parse tasks.md into checkbox tallies, split by whether the enclosing section
 * is implementation or a post-merge gate.
 *
 * @returns {{ impl: {done:number,total:number}, gate: {done:number,total:number}, hasTasks: boolean }}
 */
export function tallyTasks(body) {
  const impl = { done: 0, total: 0 };
  const gate = { done: 0, total: 0 };
  // Lines before the first `## ` header count as implementation (there is no
  // gate context yet). In practice tasks.md always opens with a section.
  let inGate = false;
  for (const line of body.split("\n")) {
    if (SECTION.test(line)) {
      inGate = isPostMergeSection(line);
      continue;
    }
    const bucket = inGate ? gate : impl;
    if (CHECKED.test(line)) {
      bucket.done += 1;
      bucket.total += 1;
    } else if (UNCHECKED.test(line)) {
      bucket.total += 1;
    }
  }
  return { impl, gate, hasTasks: impl.total + gate.total > 0 };
}

// ---------------------------------------------------------------------------
// Code-exists probe.
//
// Extract concrete file paths a change names, then check whether they exist on
// the target ref. We only trust MULTI-SEGMENT paths (`server/postgres-search.js`)
// — bare filenames (`index.js`) are too common to attribute to one change.
// ---------------------------------------------------------------------------

// Backtick-quoted path with at least one `/` and a code/spec extension.
const PATH_REF = /`([a-zA-Z0-9_@][a-zA-Z0-9_./@-]*\/[a-zA-Z0-9_./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs))`/g;

/**
 * Collect distinct multi-segment code paths referenced anywhere in a change.
 *
 * `readFile` is injectable for tests; it MUST throw for a missing file (as
 * `readFileSync` does) so we can skip absent artifacts without a separate
 * existence probe (which would not see an injected in-memory file system).
 */
export function extractReferencedPaths(changeDir, readFile = readFileSync) {
  const refs = new Set();
  const files = ["proposal.md", "design.md", "tasks.md"];
  for (const file of files) {
    const p = join(changeDir, file);
    let body;
    try {
      body = readFile(p, "utf8");
    } catch {
      continue; // artifact absent
    }
    for (const match of body.matchAll(PATH_REF)) {
      refs.add(match[1]);
    }
  }
  return [...refs].sort();
}

/**
 * Resolve a referenced path to a real repo path. Change bodies sometimes name a
 * path relative to a package root (`postgres-search.js` lives at
 * `reference-implementation/server/...`). We accept the path as-is if it exists
 * from the repo root, else probe a small set of known package roots.
 */
const PACKAGE_ROOTS = [
  "",
  "reference-implementation",
  "packages/polyfill-connectors",
  "apps/console",
  "apps/site",
  "scripts",
];

/** Build a lookup that answers "does this repo-relative path exist on ref?". */
function makeExistsOnRef(ref) {
  // Prefer the git tree of `ref` so CI (working tree == branch under test) and
  // local checkouts agree on "landed on main". Fall back to the working tree
  // when the ref is unavailable.
  let treePaths = null;
  let usedRef = ref;
  if (ref) {
    try {
      const out = execFileSync("git", ["ls-tree", "-r", "--name-only", ref], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      treePaths = new Set(out.split("\n").filter(Boolean));
    } catch {
      treePaths = null; // ref missing → working-tree fallback
      usedRef = "(working tree — ref unavailable)";
    }
  } else {
    usedRef = "(working tree)";
  }

  const existsRepoRel = (relPath) => {
    if (treePaths) {
      return treePaths.has(relPath);
    }
    const abs = join(repoRoot, relPath);
    return existsSync(abs) && statSync(abs).isFile();
  };

  return { usedRef, existsRepoRel };
}

/**
 * For each referenced path, find whether it resolves under any known package
 * root on the target ref. Returns the matched repo-relative paths.
 */
export function resolveReferencedPaths(referenced, existsRepoRel) {
  const found = [];
  for (const ref of referenced) {
    for (const root of PACKAGE_ROOTS) {
      const candidate = root ? `${root}/${ref}` : ref;
      if (existsRepoRel(candidate)) {
        found.push(candidate);
        break;
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Classification per change.
// ---------------------------------------------------------------------------

/**
 * @returns one record describing a change and whether it is archive-due.
 */
export function classifyChange(changeName, { existsRepoRel, readFile = readFileSync } = {}) {
  const changeDir = join(changesDir, changeName);
  const tasksFile = join(changeDir, "tasks.md");

  let tasks;
  try {
    tasks = tallyTasks(readFile(tasksFile, "utf8"));
  } catch {
    tasks = { impl: { done: 0, total: 0 }, gate: { done: 0, total: 0 }, hasTasks: false };
  }

  const referenced = extractReferencedPaths(changeDir, readFile);
  const codeLanded =
    typeof existsRepoRel === "function" ? resolveReferencedPaths(referenced, existsRepoRel) : [];

  // Signal 1: every implementation checkbox is done (and there is at least one).
  const implComplete = tasks.impl.total > 0 && tasks.impl.done === tasks.impl.total;

  // Signal 2: the change references concrete code that now exists on the ref.
  const codeExists = codeLanded.length > 0;

  const reasons = [];
  if (implComplete) {
    reasons.push(`all ${tasks.impl.total} implementation task(s) done`);
  }
  if (codeExists) {
    reasons.push(`referenced code exists on ref (${codeLanded.length} path(s))`);
  }

  const archiveDue = implComplete || codeExists;

  return {
    name: changeName,
    archiveDue,
    implComplete,
    codeExists,
    reasons,
    tasks,
    referencedPaths: referenced,
    landedPaths: codeLanded,
  };
}

export function listActiveChanges(dir = changesDir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "archive")
    .map((entry) => entry.name)
    .sort();
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { json: false, strict: false, ref: "main" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      args.json = true;
    } else if (a === "--strict") {
      args.strict = true;
    } else if (a === "--ref") {
      args.ref = argv[++i] ?? args.ref;
    } else if (a.startsWith("--ref=")) {
      args.ref = a.slice("--ref=".length);
    } else if (a === "--working-tree") {
      args.ref = "";
    }
  }
  return args;
}

export function runCli(argv, { log = console.log } = {}) {
  const args = parseArgs(argv);
  const { usedRef, existsRepoRel } = makeExistsOnRef(args.ref);

  const records = listActiveChanges().map((name) => classifyChange(name, { existsRepoRel }));
  const archiveDue = records.filter((r) => r.archiveDue);

  if (args.json) {
    log(JSON.stringify({ ref: usedRef, records, archiveDue: archiveDue.map((r) => r.name) }, null, 2));
    return archiveDue.length;
  }

  log("# OpenSpec archive-due check");
  log(`Ref: ${usedRef}`);
  log(`Active changes: ${records.length}`);
  log("");

  if (archiveDue.length === 0) {
    log("OK: no active change is archive-due. Nothing rotting.");
    return 0;
  }

  log(`⚠ ${archiveDue.length} change(s) look archive-due (implemented but still active):`);
  log("");
  for (const r of archiveDue) {
    log(`- ${r.name}`);
    log(`    why: ${r.reasons.join("; ")}`);
    if (r.tasks.gate.total > 0) {
      log(
        `    note: ${r.tasks.gate.total - r.tasks.gate.done} open owner/deploy gate box(es) — ` +
          "record as residual risk, do not leave the change active for them"
      );
    }
    if (r.landedPaths.length > 0) {
      const shown = r.landedPaths.slice(0, 4).join(", ");
      const more = r.landedPaths.length > 4 ? `, +${r.landedPaths.length - 4} more` : "";
      log(`    landed: ${shown}${more}`);
    }
  }
  log("");
  log("These should be archived (owner-only): move to openspec/changes/archive/,");
  log("fold Requirement deltas into openspec/specs/, and track any residual");
  log("live-deploy / owner-review work in the issue tracker — not in tasks.md.");

  return args.strict ? archiveDue.length : 0;
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === here;
}

if (isMain()) {
  const exitCount = runCli(process.argv.slice(2));
  const args = parseArgs(process.argv.slice(2));
  // Non-blocking by default (warn-only). --strict turns findings into failure.
  process.exit(args.strict ? Math.min(exitCount, 1) : 0);
}
