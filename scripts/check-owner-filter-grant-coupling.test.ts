#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Hermetic guard for scripts/check-owner-filter-grant-coupling.ts.
//
// The check exists to stop owner-token filter rules from re-acquiring client
// grant-projection vocabulary. Its whole value depends on NOT crying wolf: the
// spec legitimately computes `changes_since` eligibility on the
// grant-authorized projection, and `field_not_granted` legitimately names a
// client sparse-fieldset failure. If the check flagged those, a maintainer
// would silence it and the real contradiction would walk back in.
//
// So this file pins both directions: the two passages that shipped the
// contradiction (verbatim, as they stood before the correction) must be
// caught, and every legitimate passage must stay clean.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runScan, scanText, splitPassages } from "./check-owner-filter-grant-coupling.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function terms(hits: { term: string }[]): string[] {
  return hits.map((h) => h.term);
}

// --- Hazard cases: the exact prose the correction removed -------------------

test("flags the pre-fix owner filter paragraph", () => {
  // spec-core.md as of 5da5f15f6, tail of the client-filter paragraph. The
  // sentence is quoted alone because the check works per passage; in the file
  // it sat in a paragraph whose earlier sentences named client tokens, which
  // is exactly why the rule keys on the sentence-bearing passage.
  const text = [
    "Owner-token current-capability reads MAY accept exact filters on authorized top-level",
    "scalar fields and declared range filters; unknown fields and non-scalar fields",
    "are HTTP 400, and fields outside the grant's authorized projection are HTTP 403",
    "`field_not_granted`.",
  ].join("\n");
  assert.deepEqual(terms(scanText(text)), ["grant's authorized projection", "field_not_granted"]);
});

test("flags the pre-fix 'Filter on unauthorized field' rule", () => {
  const text = [
    "**Filter on unauthorized field:** For owner-token current-capability reads, RS",
    "MUST reject a `filter[{field}]` parameter targeting a field outside the grant's",
    "authorized projection with 403 `field_not_granted`.",
  ].join("\n");
  assert.deepEqual(terms(scanText(text)), ["grant's authorized projection", "field_not_granted"]);
});

test("flags an owner filter passage that reintroduces grant_filter intersection", () => {
  const text = "For owner-token reads the RS computes effective_filter = grant_filter AND request_filter.";
  assert.deepEqual(terms(scanText(text)), ["grant_filter"]);
});

// --- Legitimate cases: must never be flagged --------------------------------

test("does not flag the `changes_since` snapshot model", () => {
  const text =
    "**Snapshot model:** `changes_since` returns the full current state of each record whose " +
    "grant-authorized projection changed since the cursor position, plus tombstones for deletions.";
  assert.deepEqual(scanText(text), []);
});

test("does not flag the `changes_since` parameter table row", () => {
  const text =
    "| `changes_since` | string | Opaque incremental-sync token from a previous session. Returns only " +
    "records whose grant-authorized projection changed since that cursor, plus tombstones for deletions. |";
  assert.deepEqual(scanText(text), []);
});

test("does not flag the `changes_since` eligibility rule", () => {
  const text =
    "Eligibility for `changes_since` MUST be computed on the grant-authorized projection, not on the " +
    "unprojected record. Returning a record whose authorized projection is unchanged is a protocol violation.";
  assert.deepEqual(scanText(text), []);
});

test("does not flag the corrected `field_not_granted` registry row", () => {
  const text =
    "| `field_not_granted` | 403 | `permission_error` | Requested client field exceeds the grant's " +
    "authorized field projection. |";
  assert.deepEqual(scanText(text), []);
});

test("does not flag the corrected owner filter paragraph", () => {
  const text = [
    "Owner-token current-capability reads MAY accept exact filters on declared top-level scalar",
    "fields and range filters explicitly declared by current serving metadata.",
    "Unknown fields, non-scalar fields, and unsupported range shapes return HTTP",
    "400. Owner subject, source, and connection scope are enforced independently. An",
    "owner token has no client grant field projection.",
  ].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("does not flag a passage that explicitly contrasts owner and client filtering", () => {
  // The contrast exemption is load-bearing: stating the client rule next to
  // the owner rule is how the spec disambiguates them. Without this, the
  // corrected "Invalid owner filter" rule would itself be a false positive.
  const text = [
    "**Invalid owner filter:** An owner-token current-capability filter on an unknown, non-scalar,",
    "or unsupported field/operator returns HTTP 400 `invalid_request` or `unknown_field`, as",
    "applicable. Client-token predicate filters are rejected earlier under the v0.1 client-filter rule.",
  ].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("does not flag owner-token passages that are not about filtering", () => {
  const text = "Owner-token current-capability reads MAY use declared expansion against current serving metadata.";
  assert.deepEqual(scanText(text), []);
});

// --- Segmentation -----------------------------------------------------------

test("splits table rows and list items into their own passages", () => {
  const text = ["intro paragraph", "", "| a | b |", "| c | d |", "", "1. first item", "2. second item"].join("\n");
  const passages = splitPassages(text);
  assert.deepEqual(
    passages.map((p) => p.text),
    ["intro paragraph", "| a | b |", "| c | d |", "1. first item", "2. second item"]
  );
  assert.deepEqual(
    passages.map((p) => p.startLine),
    [1, 3, 4, 6, 7]
  );
});

// --- Live tree --------------------------------------------------------------

test("the current root specs are clean", () => {
  const findings = runScan();
  assert.deepEqual(
    findings,
    [],
    `owner-token filter passages must not invoke client-grant projection vocabulary:\n${findings
      .map((f) => `  ${f.file}:${f.startLine} -> ${f.term}`)
      .join("\n")}`
  );
});

test("the check would have caught the contradiction on the spec as it stood", () => {
  // Regression anchor: run the real scanner over the corrected spec-core.md
  // with the two pre-fix passages spliced back in, proving the check catches
  // them in situ and not just as isolated strings.
  const corrected = readFileSync(join(REPO_ROOT, "spec-core.md"), "utf8");
  const regressed = corrected.replace(
    "**Invalid owner filter:** An owner-token current-capability filter on an",
    [
      "**Filter on unauthorized field:** For owner-token current-capability reads, RS",
      "MUST reject a `filter[{field}]` parameter targeting a field outside the grant's",
      "authorized projection with 403 `field_not_granted`.",
      "",
      "**Invalid owner filter:** An owner-token current-capability filter on an",
    ].join("\n")
  );
  assert.notEqual(regressed, corrected, "splice target must exist in the corrected spec");
  assert.deepEqual(terms(scanText(regressed)), ["grant's authorized projection", "field_not_granted"]);
});
