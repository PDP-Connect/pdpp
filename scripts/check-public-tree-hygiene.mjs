#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Public-tree hygiene gate: catch operator-private residue before it ships in
// a public squash (github.com/PDP-Connect/pdpp).
//
// This is deliberately NARROW — four exact, previously-reintroduced private-
// residue classes, not a broad "no internal words" filter. It must never flag
// legitimate product/connector names (`Claude`, `Codex`, `Anthropic`, etc.);
// those are load-bearing content, not residue. See
// docs/research/... 2026-07-20 public-delta audit for the incident this
// check exists to prevent recurring a third time (it recurred once already
// after the 2026-07-10 residue-zero pass).
//
// Classes:
//   1. operator's real absolute home path (`/home/tnunamak`)
//   2. operator's personal machine codename (`peregrine`)
//   3. operator's private internal network domain (`*.vivid.fish`)
//   4. internal cross-provider orchestrator branch jargon (`waspflow/<slug>`)
//
// Scope: tracked, non-archive files only (git ls-files, excluding any path
// segment literally named `archive`) — archived openspec history and this
// script's own definition are exempt so the check doesn't flag itself or
// frozen historical record.
//
// Usage:
//   node scripts/check-public-tree-hygiene.mjs
//   node scripts/check-public-tree-hygiene.mjs --json

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SELF_PATH = "scripts/check-public-tree-hygiene.mjs";

export const RESIDUE_CLASSES = [
  {
    id: "operator-home-path",
    pattern: /\/home\/tnunamak\b/,
    describe: () => "operator's real absolute home path (/home/tnunamak)",
  },
  {
    id: "machine-codename",
    pattern: /\bperegrine\b/i,
    describe: () => "operator's personal machine codename (peregrine)",
  },
  {
    id: "internal-hostname",
    pattern: /[a-z0-9-]*\.vivid\.fish\b/i,
    describe: (match) => `operator's private internal network domain (${match})`,
  },
  {
    id: "orchestrator-branch-jargon",
    pattern: /\bwaspflow\/[a-zA-Z0-9._-]+/,
    describe: (match) => `internal cross-provider orchestrator branch reference (${match})`,
  },
];

function isArchivePath(path) {
  return path.split("/").includes("archive");
}

export function listScannedFiles(repoRoot = REPO_ROOT) {
  const out = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !isArchivePath(p))
    .filter((p) => p !== SELF_PATH && !p.endsWith("check-public-tree-hygiene.test.mjs"));
}

/** Scan one file's text for residue-class hits. Returns a list of {classId, line, lineNumber, match}. */
export function scanText(text, classes = RESIDUE_CLASSES) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const cls of classes) {
      const match = line.match(cls.pattern);
      if (match) {
        hits.push({ classId: cls.id, lineNumber: i + 1, line, match: match[0] });
      }
    }
  }
  return hits;
}

function readFileIfText(path, repoRoot) {
  try {
    return readFileSync(resolve(repoRoot, path), "utf8");
  } catch {
    return null; // binary or unreadable — skip, not a text-residue candidate
  }
}

export function runScan({ repoRoot = REPO_ROOT, files = null, readFile = readFileIfText } = {}) {
  const scanFiles = files ?? listScannedFiles(repoRoot);
  const findings = [];
  for (const path of scanFiles) {
    const text = readFile(path, repoRoot);
    if (text === null) continue;
    for (const hit of scanText(text)) {
      const cls = RESIDUE_CLASSES.find((c) => c.id === hit.classId);
      findings.push({
        file: path,
        line: hit.lineNumber,
        classId: hit.classId,
        description: cls.describe(hit.match),
      });
    }
  }
  return findings;
}

function parseArgs(argv) {
  return { json: argv.includes("--json") };
}

export function runCli(argv, { log = console.log } = {}) {
  const args = parseArgs(argv);
  const findings = runScan();

  if (args.json) {
    log(JSON.stringify({ findings }, null, 2));
    return findings.length;
  }

  log("# Public-tree hygiene check");
  log("");

  if (findings.length === 0) {
    log("OK: no private-residue class found in the tracked non-archive tree.");
    return 0;
  }

  log(`FAIL: ${findings.length} private-residue hit(s):`);
  log("");
  for (const f of findings) {
    log(`- ${f.file}:${f.line} — ${f.description}`);
  }
  log("");
  log("Fix: genericize the path/hostname/codename/branch reference before this");
  log("tree becomes (or feeds) a public squash.");

  return findings.length;
}

function isMain() {
  const here = fileURLToPath(import.meta.url);
  return process.argv[1] && resolve(process.argv[1]) === here;
}

if (isMain()) {
  const count = runCli(process.argv.slice(2));
  process.exit(count > 0 ? 1 : 0);
}
