#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-filter / client-grant coupling gate for the root spec-*.md files.
//
// An owner token carries no grant, so there is no grant filter to intersect
// and no authorized field projection to test a filter against. That rule was
// stated once and then contradicted twice in the same section: a normative
// owner-filter paragraph and a "Filter on unauthorized field" rule both kept
// requiring owner-token reads to obey a projection an owner token cannot
// have. Two implementations could read the same text and make opposite
// choices — one scoping owner reads by subject/source/connection, the other
// inventing a field grant and returning 403.
//
// This check is the ratchet against that recurring: it fails when a passage
// that is about OWNER-TOKEN FILTERING also invokes client-grant projection
// vocabulary.
//
// It is deliberately NARROW. A passage is only a candidate when it carries
// BOTH an owner-token marker AND a filtering marker. That pairing is what
// makes the grant vocabulary wrong; either signal alone is fine:
//
//   - `changes_since` eligibility IS computed on the grant-authorized
//     projection. Those passages are client-grant rules and are correct.
//     They carry no owner-token marker, so they are never candidates.
//   - The `field_not_granted` registry row describes a CLIENT sparse-fieldset
//     (`fields=`) request exceeding the grant projection — a live, enforced
//     behaviour. It carries no owner-token marker either.
//   - A sentence that is ABOUT THE CLIENT may use the grant vocabulary freely.
//     The exemption is per sentence, not per passage: the removed "Filter on
//     unauthorized field" rule named the client rule in its last sentence
//     while still binding owner reads to the grant projection in its first, so
//     a passage-level exemption would have let the exact defect through.
//
// Scope: paragraph-level. Markdown paragraphs are separated by blank lines;
// a table row or a numbered list item is its own unit. This keeps a hit
// pointing at the sentence a maintainer has to rewrite.
//
// Usage:
//   node scripts/check-owner-filter-grant-coupling.ts
//   node scripts/check-owner-filter-grant-coupling.ts --json

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SPEC_FILENAME_PATTERN = /^spec-.*\.md$/;

// Vocabulary that only makes sense against a client grant.
const GRANT_PROJECTION_TERMS: { id: string; pattern: RegExp }[] = [
  { id: "grant_filter", pattern: /\bgrant_filter\b/ },
  { id: "grant's authorized projection", pattern: /\bgrant's authorized (?:field )?projection\b/ },
  { id: "grant-authorized projection", pattern: /\bgrant-authorized projection\b/ },
  { id: "field_not_granted", pattern: /\bfield_not_granted\b/ },
];

// A passage is about owner-token behaviour.
const OWNER_TOKEN_PATTERN = /\bowner[- ]token\b|\bowner token\b/i;

// A passage is about filtering (as opposed to projection, sync, or expansion).
// `filter` must also match inside `grant_filter`/`effective_filter`, where the
// underscore is a word character and so suppresses a leading \b.
const FILTER_PATTERN = /filter(?:s|ing|ed)?\b|\bfilter\[/i;

// Marks a sentence as speaking about the client side rather than the owner.
const CLIENT_SENTENCE_PATTERN = /\bclient[- ]token\b|\bclient token\b|\bclient grant\b|\bclient predicate\b/i;

export interface Passage {
  readonly startLine: number;
  readonly text: string;
}

// Split markdown into paragraph-ish passages: blank-line separated, but table
// rows and ordered/unordered list items stand alone so a hit names one rule.
export function splitPassages(text: string): Passage[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const passages: Passage[] = [];
  let buffer: string[] = [];
  let startLine = 1;

  const flush = (): void => {
    if (buffer.length > 0) {
      passages.push({ startLine, text: buffer.join("\n") });
      buffer = [];
    }
  };

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const isBlank = line.trim() === "";
    const isStandalone = /^\s*\|/.test(line) || /^\s*(?:[-*+]|\d+\.)\s/.test(line);

    if (isBlank) {
      flush();
      continue;
    }
    if (isStandalone) {
      flush();
      passages.push({ startLine: lineNumber, text: line });
      continue;
    }
    if (buffer.length === 0) {
      startLine = lineNumber;
    }
    buffer.push(line);
  }
  flush();
  return passages;
}

export interface Hit {
  readonly startLine: number;
  readonly term: string;
  readonly text: string;
}

// Split a passage into sentences. Line breaks inside a markdown paragraph are
// soft wrapping, not sentence boundaries, so they are folded to spaces first —
// otherwise "the grant's\nauthorized projection" reads as two fragments and
// the grant vocabulary escapes attribution.
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s*\n\s*/g, " ")
    .split(/(?<=\.)\s+(?=[A-Z*`_[])/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// A hit requires owner-token AND filtering AND grant-projection vocabulary.
//
// The owner/client contrast exemption is applied PER SENTENCE, not per
// passage. Merely naming the client rule somewhere nearby does not cure an
// owner sentence that still imposes a grant projection — the removed "Filter
// on unauthorized field" rule did exactly that, pinning the owner read to the
// grant projection and only then noting that client requests are rejected
// earlier. So grant vocabulary is a defect unless the sentence carrying it is
// itself a client sentence, or is not an owner-filter sentence at all.
export function scanText(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const passage of splitPassages(text)) {
    if (!(OWNER_TOKEN_PATTERN.test(passage.text) && FILTER_PATTERN.test(passage.text))) {
      continue;
    }

    const sentences = splitSentences(passage.text);
    // Owner scope carries across a passage: "Owner-token reads MAY ... . Fields
    // outside the grant's projection are 403." The second sentence names no
    // token but inherits the owner subject, so a sentence is treated as an
    // owner sentence unless it explicitly speaks about the client.
    const offending = sentences.filter((sentence) => !CLIENT_SENTENCE_PATTERN.test(sentence));

    for (const term of GRANT_PROJECTION_TERMS) {
      if (offending.some((sentence) => term.pattern.test(sentence))) {
        hits.push({ startLine: passage.startLine, term: term.id, text: passage.text });
      }
    }
  }
  return hits;
}

interface Finding extends Hit {
  readonly file: string;
}

function specFiles(): string[] {
  return readdirSync(REPO_ROOT)
    .filter((name) => SPEC_FILENAME_PATTERN.test(name))
    .sort();
}

export function runScan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of specFiles()) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const hit of scanText(text)) {
      findings.push({ ...hit, file });
    }
  }
  return findings;
}

export function runCli(argv: string[], { log = console.log }: { log?: (message: string) => void } = {}): number {
  const findings = runScan();

  if (argv.includes("--json")) {
    log(JSON.stringify({ findings }, null, 2));
    return findings.length;
  }

  log("# Owner-filter / client-grant coupling check");
  log("");

  if (findings.length === 0) {
    log("OK: no owner-token filter passage invokes client-grant projection vocabulary.");
    return 0;
  }

  log(`FAIL: ${findings.length} coupled passage(s):`);
  log("");
  for (const f of findings) {
    log(`- ${f.file}:${f.startLine} — owner-token filter passage invokes \`${f.term}\``);
    log(`    ${f.text.split("\n")[0]?.slice(0, 120)}`);
  }
  log("");
  log("An owner token carries no grant. State the owner rule in terms of declared");
  log("serving metadata and HTTP 400, or contrast it explicitly with the client rule.");

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
