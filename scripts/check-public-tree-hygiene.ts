#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Public-tree hygiene gate: catch operator-private residue before it ships in
// a public squash (github.com/PDP-Connect/pdpp).
//
// This is deliberately NARROW — six exact, previously-reintroduced private-
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
//   5. a maintainer's personal mailbox at a consumer mail host
//   6. an identifiable person's address at a real institution (.edu/.gov/.mil
//      or a project domain)
//
// For 5 and 6 the synthetic convention is an RFC 2606 reserved domain
// (example.com/net/org, *.example, .test, .invalid), so the fix for a hit is
// always to move the address there — never to widen an allowlist.
//
// Scope: tracked, non-archive files only (git ls-files, excluding any path
// segment literally named `archive`) — archived openspec history and this
// script's own definition are exempt so the check doesn't flag itself or
// frozen historical record.
//
// Usage:
//   node scripts/check-public-tree-hygiene.ts
//   node scripts/check-public-tree-hygiene.ts --json

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SELF_PATH = "scripts/check-public-tree-hygiene.ts";

interface ResidueClass {
  describe: (match: string) => string;
  id: string;
  pattern: RegExp;
}

export const RESIDUE_CLASSES: ResidueClass[] = [
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
  {
    id: "personal-email-address",
    // A deliverable personal mailbox at a real consumer mail host. Narrow on
    // BOTH sides on purpose:
    //
    //   - domain: only the consumer/personal mail hosts a maintainer or a
    //     third party would actually read mail at. Corporate and vendor
    //     domains (github.com, costco.com, ...) are excluded because the
    //     addresses the tree holds at those domains are role senders in
    //     fixture data, not anyone's mailbox.
    //   - local-part: excludes role mailboxes (noreply@, support@, ...) and
    //     placeholder locals (user@, owner@, you@, ...), which are the
    //     established synthetic convention and carry no identity.
    //
    // Synthetic addresses belong at an RFC 2606 reserved domain
    // (example.com/net/org, *.example, .test, .invalid) — those never match
    // here, so the fix for a hit is always "move it to a reserved domain",
    // never "add an allowlist entry".
    pattern:
      /\b(?!(?:no-?reply|do-?not-?reply|noreply|support|help|info|admin|contact|hello|team|sales|billing|security|abuse|postmaster|webmaster|maintainers|owner|user|test|example|sample|fixture|you|me|someone|anyone|placeholder|your-[a-z-]*)\b)[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*(?:\+[a-z0-9._-]+)?@(?:gmail|googlemail|icloud|me|mac|outlook|hotmail|live|msn|yahoo|ymail|aol|proton|protonmail|pm|gmx|mail|zoho|fastmail|hey|tutanota|yandex|qq|163|126)\.(?:com|me|ru|cn|net|org)\b/i,
    describe: (match) => `a real personal email address (${match}) — use a reserved example/test domain`,
  },
  {
    id: "identifiable-institution-email",
    // The other half of the same leak: a named third party's address at a
    // real institution, copied out of live captured data (a Gmail `cc`
    // field) into a fixture. Registry-restricted TLDs (.edu/.gov/.mil) and
    // the project's own real domains cannot be squatted for test data, so
    // any address there identifies an actual person or office.
    //
    // Deliberately NOT extended to open TLDs (.com/.app/...): the tree's
    // fixture personas legitimately live at real-looking corporate domains
    // (a Figma sender, an airline, a bank), and flagging those would need a
    // sprawling allowlist — the failure mode this check exists to avoid.
    pattern:
      /\b[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*(?:\+[a-z0-9._-]+)?@(?![a-z0-9-]*\.?example\b)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:edu|gov|mil)\b|\b[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*@(?:opendatalabs\.xyz|pdp-connect\.org)\b/i,
    describe: (match) =>
      `an identifiable person's address at a real institution (${match}) — use a reserved example/test domain`,
  },
];

function isArchivePath(path: string): boolean {
  return path.split("/").includes("archive");
}

export function listScannedFiles(repoRoot: string = REPO_ROOT): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !isArchivePath(p))
    .filter((p) => p !== SELF_PATH && !p.endsWith("check-public-tree-hygiene.test.ts"));
}

interface ResidueHit {
  classId: string;
  line: string;
  lineNumber: number;
  match: string;
}

/** Scan one file's text for residue-class hits. */
export function scanText(text: string, classes: ResidueClass[] = RESIDUE_CLASSES): ResidueHit[] {
  const hits: ResidueHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const cls of classes) {
      const match = line.match(cls.pattern);
      if (match) {
        hits.push({ classId: cls.id, lineNumber: i + 1, line, match: match[0] });
      }
    }
  }
  return hits;
}

function readFileIfText(path: string, repoRoot: string): string | null {
  try {
    return readFileSync(resolve(repoRoot, path), "utf8");
  } catch {
    return null; // binary or unreadable — skip, not a text-residue candidate
  }
}

export interface HygieneFinding {
  classId: string;
  description: string;
  file: string;
  line: number;
}

export function runScan({
  repoRoot = REPO_ROOT,
  files = null,
  readFile = readFileIfText,
}: {
  files?: string[] | null;
  readFile?: (path: string, repoRoot: string) => string | null;
  repoRoot?: string;
} = {}): HygieneFinding[] {
  const scanFiles = files ?? listScannedFiles(repoRoot);
  const findings: HygieneFinding[] = [];
  for (const path of scanFiles) {
    const text = readFile(path, repoRoot);
    if (text === null) {
      continue;
    }
    for (const hit of scanText(text)) {
      const cls = RESIDUE_CLASSES.find((c) => c.id === hit.classId);
      if (!cls) {
        continue;
      }
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

function parseArgs(argv: string[]): { json: boolean } {
  return { json: argv.includes("--json") };
}

export function runCli(argv: string[], { log = console.log }: { log?: (message: string) => void } = {}): number {
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

function isMain(): boolean {
  const here = fileURLToPath(import.meta.url);
  return Boolean(process.argv[1]) && resolve(process.argv[1] ?? "") === here;
}

if (isMain()) {
  const count = runCli(process.argv.slice(2));
  process.exit(count > 0 ? 1 : 0);
}
