#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Every root spec-*.md declares `Date: <yyyy-mm-dd>` in its header. That date
// is a manual claim, not derived from anything, so it silently rots: an
// editor can rewrite Section 6 and simply forget to touch the Date line.
// This check fails when a spec's declared Date is older than the last
// SUBSTANTIVE commit that touched it, and offers --write to stamp today's
// date so the fix is one command. It never rewrites dates on its own.
//
// "Substantive" excludes commits whose diff to a given spec file only
// touches:
//   - the header block itself (lines 1-4: title/blank/Status/Date) — so
//     running --write does not re-trigger the check on its own commit
//   - whitespace-only changes (trailing space, blank-line reflow)
// Everything else — any body wording, structure, or section change, however
// small — counts as substantive. This mirrors the W3C pattern described in
// the task: stamp on a real edit, not on typo/header housekeeping.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const WRITE = process.argv.includes("--write");

const SPEC_FILENAME_PATTERN = /^spec-.*\.md$/;

function specFiles(): string[] {
  return readdirSync(REPO_ROOT)
    .filter((name) => SPEC_FILENAME_PATTERN.test(name))
    .sort();
}

const DATE_LINE_PATTERN = /^Date:\s*(.+)$/m;
const ISO_DATE_PATTERN = /(\d{4}-\d{2}-\d{2})/;

function declaredDate(text: string): { raw: string; iso: string } | null {
  const raw = text.match(DATE_LINE_PATTERN)?.[1]?.trim();
  if (!raw) {
    return null;
  }
  const iso = raw.match(ISO_DATE_PATTERN)?.[1];
  if (!iso) {
    return null;
  }
  return { raw, iso };
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

// Header block = lines 1-4 (title, blank, Status:, Date:), uniform across
// every root spec-*.md (verified against all 10 files before writing this).
const HEADER_LINE_COUNT = 4;

function isHeaderOnlyOrWhitespaceHunk(hunkLines: string[]): boolean {
  for (const line of hunkLines) {
    const content = line.slice(1); // strip the +/- marker
    if (content.trim() === "") {
      continue; // whitespace-only line change
    }
    return false;
  }
  return true;
}

const COMMIT_SPLIT_PATTERN = /^COMMIT /m;

// Parses `git log -p` output for one file into per-commit substantive-ness,
// looking only at whether every changed hunk in that commit's diff to this
// file falls within the header block or is whitespace-only.
function lastSubstantiveCommitDate(file: string): string | null {
  const log = git(["log", "-p", "--format=COMMIT %H %cd", "--date=format:%Y-%m-%d", "-U0", "--", file]);
  if (!log.trim()) {
    return null;
  }

  const commitBlocks = log.split(COMMIT_SPLIT_PATTERN).filter(Boolean);
  for (const block of commitBlocks) {
    const [headerLine, ...rest] = block.split("\n");
    const date = headerLine?.split(" ")[1];
    if (!date) {
      continue;
    }
    const diffText = rest.join("\n");
    if (commitIsSubstantive(diffText)) {
      return date;
    }
  }
  return null;
}

const HUNK_SPLIT_PATTERN = /^@@ /m;
const HUNK_HEADER_PATTERN = /^-(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function commitIsSubstantive(diffText: string): boolean {
  const hunks = diffText.split(HUNK_SPLIT_PATTERN).slice(1);
  for (const hunk of hunks) {
    const hunkHeaderMatch = hunk.match(HUNK_HEADER_PATTERN);
    const newStartRaw = hunkHeaderMatch?.[2];
    const newStart = newStartRaw ? Number.parseInt(newStartRaw, 10) : null;
    const lines = hunk
      .split("\n")
      .slice(1)
      .filter((l) => l.startsWith("+") || l.startsWith("-"));

    // A hunk that starts at or before the header block's last line and whose
    // touched lines are all within the header window is header-only.
    const withinHeader = newStart !== null && newStart <= HEADER_LINE_COUNT;
    if (withinHeader && lines.every((l) => isHeaderOnlyOrWhitespaceHunk([l]))) {
      continue;
    }
    if (isHeaderOnlyOrWhitespaceHunk(lines)) {
      continue;
    }
    return true; // a real, non-header, non-whitespace change
  }
  return false;
}

interface StaleReport {
  daysStale: number;
  declared: string;
  file: string;
  lastSubstantive: string;
}

function daysBetween(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function collectResults(files: string[]): { stale: StaleReport[]; errors: string[] } {
  const stale: StaleReport[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    const date = declaredDate(text);
    if (!date) {
      errors.push(`${file}: no parseable 'Date: yyyy-mm-dd' header line`);
      continue;
    }
    const lastSubstantive = lastSubstantiveCommitDate(file);
    if (!lastSubstantive) {
      continue; // no commit history (new/untracked file) — nothing to compare
    }
    if (date.iso < lastSubstantive) {
      stale.push({
        file,
        declared: date.iso,
        lastSubstantive,
        daysStale: daysBetween(date.iso, lastSubstantive),
      });
    }
  }
  return { stale, errors };
}

// Stamps "now" (the date of this fix), not the historical
// last-substantive-edit date — matching what a human fixing this by hand
// would type.
function writeStaleDates(stale: StaleReport[]): void {
  if (stale.length === 0) {
    console.log("spec:dates — nothing to write, no stale dates found");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const entry of stale) {
    const text = readFileSync(join(REPO_ROOT, entry.file), "utf8");
    const updated = text.replace(DATE_LINE_PATTERN, `Date: ${today}`);
    writeFileSync(join(REPO_ROOT, entry.file), updated);
    console.log(`${entry.file}: stamped Date: ${today} (was ${entry.declared})`);
  }
}

function reportFailures(stale: StaleReport[], errors: string[]): void {
  const total = errors.length + stale.length;
  console.error(`spec:dates failed (${total} issue${total === 1 ? "" : "s"})`);
  for (const error of errors) {
    console.error(`\n- ${error}`);
  }
  for (const entry of stale) {
    console.error(
      `\n- ${entry.file}: Date: ${entry.declared} is stale — last substantive commit was ${entry.lastSubstantive} ` +
        `(${entry.daysStale} day${entry.daysStale === 1 ? "" : "s"} behind). ` +
        `Run 'pnpm spec:dates -- --write' to stamp, or update Date by hand if you disagree it's substantive.`
    );
  }
  process.exit(1);
}

function main(): void {
  const files = specFiles();
  const { stale, errors } = collectResults(files);

  if (WRITE) {
    writeStaleDates(stale);
    return;
  }

  if (errors.length > 0 || stale.length > 0) {
    reportFailures(stale, errors);
    return;
  }

  console.log(`spec:dates passed (${files.length} spec${files.length === 1 ? "" : "s"} checked)`);
}

main();
