#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SITE_DOCS = join(REPO_ROOT, "apps/site/content/docs");
const SPEC_FILE_RE = /^spec-.*\.md$/;
const TITLE_RE = /^#\s+/;
const STATUS_LINE_RE = /^Status:\s*/;
const DATE_LINE_RE = /^Date:\s*/;
const FRONTMATTER_DELIMITER_RE = /^---\s*$/;
const CALLOUT_START_RE = /^<Callout\b/;
const CALLOUT_END_RE = /^<\/Callout>\s*$/;
const ROOT_STATUS_RE = /^Status:\s*(.+)$/m;
const ROOT_DATE_RE = /^Date:\s*(.+)$/m;
const CALLOUT_STATUS_RE = /^\s*Status:\s*(.+)$/m;
const CALLOUT_DATE_RE = /^\s*Date:\s*(.+)$/m;

// The site's spec-*.md pages are GENERATED from the root spec-*.md (single
// source) and are gitignored, so they may be absent on a fresh checkout. Run
// the sync first so the comparison below runs against freshly-built output —
// which also asserts the generator itself stays a faithful, drift-free
// transform of the root specs.
function syncSpecs() {
  execFileSync("node", [join(REPO_ROOT, "apps/site/scripts/sync-spec-docs.mjs")], {
    stdio: "inherit",
  });
}

const SITE_ONLY_EXTENSIONS = new Set([
  "spec-ext-aggregation.md",
  "spec-ext-lexical-search.md",
  "spec-semantic-retrieval-extension.md",
]);

const REFERENCE_ONLY_ROOT_SPECS = new Set(["spec-reference-implementation-examples.md"]);

function specFiles(dir) {
  return readdirSync(dir)
    .filter((name) => SPEC_FILE_RE.test(name))
    .sort();
}

function stripFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return normalized;
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return normalized;
  }
  return normalized.slice(end + "\n---".length);
}

function stripTitleAndRootStatus(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (TITLE_RE.test(lines[0] ?? "")) {
    lines.shift();
  }
  stripLeadingBlank(lines);
  if (STATUS_LINE_RE.test(lines[0] ?? "")) {
    lines.shift();
  }
  if (DATE_LINE_RE.test(lines[0] ?? "")) {
    lines.shift();
  }
  stripLeadingBlank(lines);
  if (FRONTMATTER_DELIMITER_RE.test(lines[0] ?? "")) {
    lines.shift();
  }
  stripLeadingBlank(lines);
  return lines.join("\n");
}

function stripLeadingSiteCallout(text) {
  const withoutFrontmatter = stripFrontmatter(text);
  const lines = withoutFrontmatter.split("\n");
  stripLeadingBlank(lines);
  if (!CALLOUT_START_RE.test(lines[0] ?? "")) {
    return lines.join("\n");
  }
  while (lines.length > 0) {
    const line = lines.shift();
    if (CALLOUT_END_RE.test(line ?? "")) {
      break;
    }
  }
  stripLeadingBlank(lines);
  if (TITLE_RE.test(lines[0] ?? "")) {
    lines.shift();
  }
  stripLeadingBlank(lines);
  if (FRONTMATTER_DELIMITER_RE.test(lines[0] ?? "")) {
    lines.shift();
  }
  stripLeadingBlank(lines);
  return lines.join("\n");
}

function stripLeadingBlank(lines) {
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") {
    lines.shift();
  }
}

function normalizeBody(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\{#[A-Za-z0-9_-]+\}/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function rootMetadata(text) {
  const status = text.match(ROOT_STATUS_RE)?.[1]?.trim() ?? null;
  const date = text.match(ROOT_DATE_RE)?.[1]?.trim() ?? null;
  return { date, status };
}

function leadingCallout(text) {
  const lines = stripFrontmatter(text).split("\n");
  stripLeadingBlank(lines);
  if (!CALLOUT_START_RE.test(lines[0] ?? "")) {
    return null;
  }
  const out = [];
  while (lines.length > 0) {
    const line = lines.shift() ?? "";
    out.push(line);
    if (CALLOUT_END_RE.test(line)) {
      break;
    }
  }
  return out.join("\n");
}

function cleanMetadataValue(value) {
  return value.replace(/\*\*/g, "").trim();
}

function calloutMetadata(text) {
  const callout = leadingCallout(text);
  if (!callout) {
    return { date: null, status: null };
  }
  const status = callout.match(CALLOUT_STATUS_RE)?.[1] ?? null;
  const date = callout.match(CALLOUT_DATE_RE)?.[1] ?? null;
  return {
    date: date ? cleanMetadataValue(date) : null,
    status: status ? cleanMetadataValue(status) : null,
  };
}

function firstDiff(expected, actual) {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
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

function checkPair(file) {
  const rootText = readFileSync(join(REPO_ROOT, file), "utf8");
  const siteText = readFileSync(join(SITE_DOCS, file), "utf8");
  const expectedMeta = rootMetadata(rootText);
  const actualMeta = calloutMetadata(siteText);
  const errors = [];

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

function main() {
  syncSpecs();
  const rootSpecs = specFiles(REPO_ROOT);
  const siteSpecs = specFiles(SITE_DOCS);
  const rootSet = new Set(rootSpecs);
  const siteSet = new Set(siteSpecs);
  const errors = [];

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
