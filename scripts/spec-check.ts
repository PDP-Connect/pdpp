#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SITE_DOCS = join(REPO_ROOT, "apps/site/content/docs");

// The site's spec-*.md pages are GENERATED from the root spec-*.md (single
// source) and are gitignored, so they may be absent on a fresh checkout. Run
// the sync first so the comparison below runs against freshly-built output —
// which also asserts the generator itself stays a faithful, drift-free
// transform of the root specs.
function syncSpecs(): void {
  execFileSync("node", [join(REPO_ROOT, "apps/site/scripts/sync-spec-docs.mjs")], {
    stdio: "inherit",
  });
}

// Optional extension profiles that are authored as site docs and have no root
// counterpart by design. This list is NOT a local convenience: it mirrors the
// ratified allowlist in
//   openspec/specs/reference-implementation-governance/spec.md
//   -> "Requirement: Public-site-only extension specs SHALL be limited to a named allowlist"
// Adding an entry here without an OpenSpec change to that requirement is drift.
// The two lists are compared below so they cannot silently diverge again.
const SITE_ONLY_EXTENSIONS = new Set([
  "spec-ext-aggregation.md",
  "spec-ext-lexical-search.md",
  "spec-semantic-retrieval-extension.md",
]);

const GOVERNANCE_SPEC = join(REPO_ROOT, "openspec/specs/reference-implementation-governance/spec.md");

// Parse the bullet list under the allowlist heading in the governance spec and
// assert it matches SITE_ONLY_EXTENSIONS. This closes the gap that let the code
// allowlist carry three entries while the governance spec named two, one of
// which (`spec-lexical-retrieval-extension`) never existed as a file.
function governanceAllowlistErrors(): string[] {
  const text = readFileSync(GOVERNANCE_SPEC, "utf8").replace(CRLF_PATTERN, "\n");
  const marker = "The current public-site-only extension allowlist:";
  const start = text.indexOf(marker);
  if (start === -1) {
    return [
      `openspec governance spec: could not find the allowlist marker ${JSON.stringify(marker)}; ` +
        "spec-check can no longer verify the code allowlist against governance",
    ];
  }
  const declared = new Set<string>();
  for (const line of text.slice(start + marker.length).split("\n")) {
    const entry = line.match(/^-\s+`([^`]+)`\s*$/)?.[1];
    if (entry) {
      declared.add(entry.endsWith(".md") ? entry : `${entry}.md`);
      continue;
    }
    // Stop at the first non-bullet, non-blank line: the list has ended.
    if (line.trim() !== "" && !line.startsWith("- ")) {
      break;
    }
  }

  const errors: string[] = [];
  for (const file of SITE_ONLY_EXTENSIONS) {
    if (!declared.has(file)) {
      errors.push(
        `${file}: allowlisted in scripts/spec-check.ts but NOT in the governance spec allowlist ` +
          "(openspec/specs/reference-implementation-governance/spec.md)"
      );
    }
  }
  for (const file of declared) {
    if (!SITE_ONLY_EXTENSIONS.has(file)) {
      errors.push(`${file}: named in the governance spec allowlist but NOT allowlisted in scripts/spec-check.ts`);
    }
  }
  return errors;
}

const REFERENCE_ONLY_ROOT_SPECS = new Set(["spec-reference-implementation-examples.md"]);

const SPEC_FILENAME_PATTERN = /^spec-.*\.md$/;

function specFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => SPEC_FILENAME_PATTERN.test(name))
    .sort();
}

const CRLF_PATTERN = /\r\n/g;

function stripFrontmatter(text: string): string {
  const normalized = text.replace(CRLF_PATTERN, "\n");
  if (!normalized.startsWith("---\n")) {
    return normalized;
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return normalized;
  }
  return normalized.slice(end + "\n---".length);
}

const HEADING_PATTERN = /^#\s+/;
const STATUS_LINE_PATTERN = /^Status:\s*/;
const DATE_LINE_PATTERN = /^Date:\s*/;
const HORIZONTAL_RULE_PATTERN = /^---\s*$/;

function stripTitleAndRootStatus(text: string): string {
  const lines = text.replace(CRLF_PATTERN, "\n").split("\n");
  if (HEADING_PATTERN.test(lines[0] ?? "")) {
    lines.shift();
  }
  stripLeadingBlank(lines);
  if (STATUS_LINE_PATTERN.test(lines[0] ?? "")) {
    lines.shift();
  }
  if (DATE_LINE_PATTERN.test(lines[0] ?? "")) {
    lines.shift();
  }
  stripLeadingBlank(lines);
  if (HORIZONTAL_RULE_PATTERN.test(lines[0] ?? "")) {
    lines.shift();
  }
  stripLeadingBlank(lines);
  return lines.join("\n");
}

const CALLOUT_OPEN_PATTERN = /^<Callout\b/;
const CALLOUT_CLOSE_PATTERN = /^<\/Callout>\s*$/;

function stripLeadingSiteCallout(text: string): string {
  const withoutFrontmatter = stripFrontmatter(text);
  const lines = withoutFrontmatter.split("\n");
  stripLeadingBlank(lines);
  if (!CALLOUT_OPEN_PATTERN.test(lines[0] ?? "")) {
    return lines.join("\n");
  }
  while (lines.length > 0) {
    const line = lines.shift();
    if (CALLOUT_CLOSE_PATTERN.test(line ?? "")) {
      break;
    }
  }
  stripLeadingBlank(lines);
  if (HEADING_PATTERN.test(lines[0] ?? "")) {
    lines.shift();
  }
  stripLeadingBlank(lines);
  if (HORIZONTAL_RULE_PATTERN.test(lines[0] ?? "")) {
    lines.shift();
  }
  stripLeadingBlank(lines);
  return lines.join("\n");
}

function stripLeadingBlank(lines: string[]): void {
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") {
    lines.shift();
  }
}

const ANCHOR_ID_PATTERN = /[ \t]+\{#[A-Za-z0-9_-]+\}/g;

function normalizeBody(text: string): string {
  return text
    .replace(CRLF_PATTERN, "\n")
    .replace(ANCHOR_ID_PATTERN, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

interface Metadata {
  date: string | null;
  status: string | null;
}

const STATUS_VALUE_PATTERN = /^Status:\s*(.+)$/m;
const DATE_VALUE_PATTERN = /^Date:\s*(.+)$/m;

function rootMetadata(text: string): Metadata {
  const status = text.match(STATUS_VALUE_PATTERN)?.[1]?.trim() ?? null;
  const date = text.match(DATE_VALUE_PATTERN)?.[1]?.trim() ?? null;
  return { status, date };
}

function leadingCallout(text: string): string | null {
  const lines = stripFrontmatter(text).split("\n");
  stripLeadingBlank(lines);
  if (!CALLOUT_OPEN_PATTERN.test(lines[0] ?? "")) {
    return null;
  }
  const out: string[] = [];
  while (lines.length > 0) {
    const line = lines.shift() ?? "";
    out.push(line);
    if (CALLOUT_CLOSE_PATTERN.test(line)) {
      break;
    }
  }
  return out.join("\n");
}

const BOLD_MARKER_PATTERN = /\*\*/g;

function cleanMetadataValue(value: string): string {
  return value.replace(BOLD_MARKER_PATTERN, "").trim();
}

const CALLOUT_STATUS_PATTERN = /^\s*Status:\s*(.+)$/m;
const CALLOUT_DATE_PATTERN = /^\s*Date:\s*(.+)$/m;

function calloutMetadata(text: string): Metadata {
  const callout = leadingCallout(text);
  if (!callout) {
    return { status: null, date: null };
  }
  const status = callout.match(CALLOUT_STATUS_PATTERN)?.[1] ?? null;
  const date = callout.match(CALLOUT_DATE_PATTERN)?.[1] ?? null;
  return {
    status: status ? cleanMetadataValue(status) : null,
    date: date ? cleanMetadataValue(date) : null,
  };
}

interface LineDiff {
  line: number;
  root: string;
  site: string;
}

function firstDiff(expected: string, actual: string): LineDiff | null {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if ((a[i] ?? "") !== (b[i] ?? "")) {
      return {
        line: i + 1,
        root: a[i] ?? "<missing>",
        site: b[i] ?? "<missing>",
      };
    }
  }
  return null;
}

function checkPair(file: string): string[] {
  const rootText = readFileSync(join(REPO_ROOT, file), "utf8");
  const siteText = readFileSync(join(SITE_DOCS, file), "utf8");
  const expectedMeta = rootMetadata(rootText);
  const actualMeta = calloutMetadata(siteText);
  const errors: string[] = [];

  if (!(expectedMeta.status && expectedMeta.date)) {
    errors.push(`${file}: root spec must declare Status and Date`);
  }
  if (!(actualMeta.status && actualMeta.date)) {
    errors.push(`${file}: public-site copy must start with a Status/Date Callout`);
  }
  if (expectedMeta.status && actualMeta.status !== expectedMeta.status) {
    errors.push(
      `${file}: site Status mismatch (root=${JSON.stringify(expectedMeta.status)} site=${JSON.stringify(actualMeta.status)})`
    );
  }
  if (expectedMeta.date && actualMeta.date !== expectedMeta.date) {
    errors.push(
      `${file}: site Date mismatch (root=${JSON.stringify(expectedMeta.date)} site=${JSON.stringify(actualMeta.date)})`
    );
  }

  const expected = normalizeBody(stripTitleAndRootStatus(rootText));
  const actual = normalizeBody(stripLeadingSiteCallout(siteText));
  if (expected !== actual) {
    const diff = firstDiff(expected, actual);
    errors.push(
      [
        `${file}: body drift after normalization`,
        diff ? `  first mismatch at normalized line ${diff.line}` : null,
        diff ? `  root: ${diff.root}` : null,
        diff ? `  site: ${diff.site}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return errors;
}

function main(): void {
  syncSpecs();
  const rootSpecs = specFiles(REPO_ROOT);
  const siteSpecs = specFiles(SITE_DOCS);
  const rootSet = new Set(rootSpecs);
  const siteSet = new Set(siteSpecs);
  const errors: string[] = [];

  for (const file of rootSpecs) {
    if (REFERENCE_ONLY_ROOT_SPECS.has(file)) {
      continue;
    }
    if (!siteSet.has(file)) {
      errors.push(`${file}: missing public-site counterpart at apps/site/content/docs/${file}`);
      continue;
    }
    errors.push(...checkPair(file));
  }

  for (const file of siteSpecs) {
    if (rootSet.has(file)) {
      continue;
    }
    if (!SITE_ONLY_EXTENSIONS.has(file)) {
      errors.push(`${file}: site-only spec is not allowlisted`);
    }
  }

  // An allowlist entry with no file behind it is stale: it silently exempts a
  // name that nothing checks, which is how the governance list came to carry
  // `spec-lexical-retrieval-extension` long after the file was named
  // `spec-ext-lexical-search`.
  for (const file of SITE_ONLY_EXTENSIONS) {
    if (!siteSet.has(file)) {
      errors.push(`${file}: allowlisted as a site-only extension but no such file exists at apps/site/content/docs/${file}`);
    }
  }

  errors.push(...governanceAllowlistErrors());

  if (errors.length > 0) {
    console.error(`spec:check failed (${errors.length} issue${errors.length === 1 ? "" : "s"})`);
    console.error(errors.map((error) => `\n- ${error}`).join(""));
    process.exit(1);
  }

  console.log(
    `spec:check passed (${rootSpecs.length - REFERENCE_ONLY_ROOT_SPECS.size} canonical pairs, ` +
      `${SITE_ONLY_EXTENSIONS.size} site-only extensions, ${REFERENCE_ONLY_ROOT_SPECS.size} reference-only root spec)`
  );
}

main();
