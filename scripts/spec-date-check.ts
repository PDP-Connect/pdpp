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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
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

interface Options {
  baseRef?: string;
  write: boolean;
}

function parseOptions(args: string[]): Options {
  let baseRef: string | undefined;
  let write = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--base") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || baseRef) {
        throw new Error("usage: spec-date-check.ts [--write] [--base <commit-ish>]");
      }
      baseRef = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { baseRef, write };
}

function resolvedBase(baseRef: string): string {
  try {
    return git(["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
  } catch {
    throw new Error(`--base must resolve to a commit: ${baseRef}`);
  }
}

function filesChangedFrom(baseCommit: string): string[] {
  return specFiles().filter((file) => git(["diff", "--name-only", baseCommit, "HEAD", "--", file]).trim() !== "");
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
// Captures both sides of a unified-diff hunk header: `-oldStart,oldCount +newStart,newCount @@`.
// `-U0` omits the count entirely for a single-line range, and a pure-deletion
// or pure-insertion range can carry an explicit `,0` — both must be told apart
// from "no count given" (which defaults to a span of 1), so the count capture
// stays optional and its presence is checked before defaulting.
const HUNK_HEADER_PATTERN = /^-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// A range is wholly inside the header block if it's empty (count 0 — nothing
// on that side to have left the header) or its last line is within
// HEADER_LINE_COUNT. `count` is `undefined` when the diff omitted it (single
// line, span 1), so the "no count" case must default the span to 1, not use
// falsy-string coercion — a literal count of "0" is a real, meaningful value,
// not an absent one.
function rangeIsWithinHeader(start: number, count: number | undefined): boolean {
  if (count === 0) {
    return true;
  }
  const span = count === undefined ? 1 : count;
  return start + span - 1 <= HEADER_LINE_COUNT;
}

function commitIsSubstantive(diffText: string): boolean {
  const hunks = diffText.split(HUNK_SPLIT_PATTERN).slice(1);
  for (const hunk of hunks) {
    const hunkHeaderMatch = hunk.match(HUNK_HEADER_PATTERN);
    const lines = hunk
      .split("\n")
      .slice(1)
      .filter((l) => l.startsWith("+") || l.startsWith("-"));

    // A hunk confined to the header block (lines 1..HEADER_LINE_COUNT) on
    // BOTH sides is header-only regardless of what it says, because the
    // header IS the title/Status/Date housekeeping this check must not treat
    // as a revision. Checking only the new side let a deletion whose new-side
    // range collapsed to the header boundary (e.g. `@@ -6 +5,0 @@`, deleting
    // the first body line) get misclassified as header-only, because the
    // deleted content only ever appears on the OLD side.
    //
    // `isHeaderOnlyOrWhitespaceHunk` cannot decide this: it only recognises
    // WHITESPACE, so a `Date:` edit came back "substantive" and every stamp
    // became the next run's revision date. That made the check self-triggering
    // — the exact loop the file comment says it prevents — and it is why the
    // specs carried dates nobody had edited on.
    if (hunkHeaderMatch) {
      const oldStart = Number.parseInt(hunkHeaderMatch[1], 10);
      const oldCount = hunkHeaderMatch[2] === undefined ? undefined : Number.parseInt(hunkHeaderMatch[2], 10);
      const newStart = Number.parseInt(hunkHeaderMatch[3], 10);
      const newCount = hunkHeaderMatch[4] === undefined ? undefined : Number.parseInt(hunkHeaderMatch[4], 10);

      const oldWithinHeader = rangeIsWithinHeader(oldStart, oldCount);
      const newWithinHeader = rangeIsWithinHeader(newStart, newCount);
      if (oldWithinHeader && newWithinHeader) {
        continue;
      }
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
    // Replace only the ISO date, never the whole line. Several of these carry
    // an editorial tail — "(revised from 2026-03-30)", "(original); superseded
    // 2026-04-12" — that is real provenance, and spec-check.ts compares the
    // full string against the sidecar, so dropping it here would both destroy
    // information and fail that check.
    const updated = text.replace(DATE_LINE_PATTERN, (line) => line.replace(ISO_DATE_PATTERN, today));
    writeFileSync(join(REPO_ROOT, entry.file), updated);
    console.log(`${entry.file}: stamped Date: ${today} (was ${entry.declared})`);
    stampSidecar(entry.file, today);
  }
}

// The site renders each spec through a committed header sidecar that repeats
// the root's Status and Date inside a <Callout>. spec-check.ts compares the two
// and fails on a mismatch, so stamping only the root would trade one red check
// for another. Stamping both keeps them in step.
//
// The sidecar's date is prose, not a bare value: several read
// "2026-07-07 (revised from 2026-03-30)". Only the leading date is replaced, so
// that editorial tail survives.
function stampSidecar(specFile: string, today: string): void {
  const sidecar = join(REPO_ROOT, "apps/site/spec-headers", specFile.replace(/\.md$/, ".header.md"));
  if (!existsSync(sidecar)) {
    return;
  }
  const text = readFileSync(sidecar, "utf8");
  const updated = text.replace(/^(\s*Date:\s*)\d{4}-\d{2}-\d{2}/m, `$1${today}`);
  if (updated === text) {
    return;
  }
  writeFileSync(sidecar, updated);
  console.log(`  ${basename(sidecar)}: mirrored Date: ${today}`);
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
  let parsed: Options;
  try {
    parsed = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`spec:dates failed: ${(error as Error).message}`);
    process.exit(1);
  }

  let files = specFiles();
  if (parsed.baseRef) {
    let baseCommit: string;
    try {
      baseCommit = resolvedBase(parsed.baseRef);
    } catch (error) {
      console.error(`spec:dates failed: ${(error as Error).message}`);
      process.exit(1);
    }
    files = filesChangedFrom(baseCommit);
  }
  const { stale, errors } = collectResults(files);

  if (parsed.write) {
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
