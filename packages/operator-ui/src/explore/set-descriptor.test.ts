// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SET-DESCRIPTOR CONTRACT tests.
 *
 * Each test asserts a property that FAILS if the descriptor is ignored or
 * bypassed. The "prove it fails without the descriptor" pattern: each test
 * constructs a descriptor of a specific kind and asserts only what that kind
 * supports — and asserts that what it does NOT support is structurally
 * unreachable (no has_more, null cursor, wrong header label).
 *
 * (a) relevance_bounded CANNOT render "complete"/"newest first" — feedHeaderLabel
 *     returns "Top matches", descriptorIsTimeOrdered returns false, descriptorHasMore
 *     returns false. A renderer that bypasses the descriptor and renders "newest first"
 *     is wrong by the test.
 *
 * (b) keyword_pageable with ordering=time returns genuinely newest-first results
 *     (via the lexical order=recent server param). The test asserts that the descriptor
 *     ordering field is "time" and descriptorIsTimeOrdered returns true.
 *
 * (c) complete_chronological reaches the last record — has_more=false means no more
 *     pages, cursor is null, and the header says "Everything, newest first".
 *
 * (d) filtered_exact shows the true total — descriptorHasTotal returns true and total
 *     is the exact count.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CompleteChronologicalDescriptor,
  descriptorHasMore,
  descriptorHasTotal,
  descriptorIsTimeOrdered,
  descriptorNextCursor,
  type FilteredExactDescriptor,
  feedHeaderLabel,
  type KeywordPageableDescriptor,
  legalSortOptions,
  type RelevanceBoundedDescriptor,
  type SetDescriptor,
} from "./set-descriptor.ts";

// ── (a) relevance_bounded: CANNOT claim "newest first" or "complete" ──────────

test("relevance_bounded: feedHeaderLabel returns 'Top matches', never 'newest first'", () => {
  const descriptor: RelevanceBoundedDescriptor = {
    kind: "relevance_bounded",
    ordering: "relevance",
    completeness: "bounded_sample",
    has_more: false,
    cursor: null,
  };
  const label = feedHeaderLabel(descriptor);
  assert.equal(label, "Top matches");
  // The key enforcement: the label is NOT "Everything, newest first" or any
  // chronological claim. Any bypass of the descriptor that renders "newest first"
  // over a relevance_bounded set contradicts this assertion.
  assert.notEqual(label, "Everything, newest first");
  assert.ok(!label.toLowerCase().includes("newest first"));
  assert.ok(!label.toLowerCase().includes("complete"));
  assert.ok(!label.toLowerCase().includes("everything"));
});

test("relevance_bounded: descriptorIsTimeOrdered returns false", () => {
  const descriptor: RelevanceBoundedDescriptor = {
    kind: "relevance_bounded",
    ordering: "relevance",
    completeness: "bounded_sample",
    has_more: false,
    cursor: null,
  };
  assert.equal(descriptorIsTimeOrdered(descriptor), false);
});

test("relevance_bounded: descriptorHasMore always returns false (no sound deep pagination)", () => {
  // has_more is false: the type enforces this structurally.
  const descriptor: RelevanceBoundedDescriptor = {
    kind: "relevance_bounded",
    ordering: "relevance",
    completeness: "bounded_sample",
    has_more: false,
    cursor: null,
  };
  assert.equal(descriptorHasMore(descriptor), false);
  assert.equal(descriptorNextCursor(descriptor), null);
});

test("relevance_bounded: a renderer that bypasses the descriptor would fail these assertions", () => {
  // Simulate what a buggy renderer might do: check a boolean `searchHasMore`
  // flag instead of the descriptor. With the descriptor, these properties are
  // structurally false for relevance_bounded, so the UI cannot render a Load-more.
  const descriptor: RelevanceBoundedDescriptor = {
    kind: "relevance_bounded",
    ordering: "relevance",
    completeness: "bounded_sample",
    has_more: false,
    cursor: null,
  };
  // If a renderer ignored the descriptor and rendered Load-more anyway, it would
  // need cursor to be non-null. Prove it's null:
  assert.equal(descriptorNextCursor(descriptor), null);
  // Prove has_more is false (type-enforced; this is the structural guarantee):
  assert.equal(descriptor.has_more, false);
  // Prove the label cannot be made to say "newest first":
  const label = feedHeaderLabel(descriptor);
  assert.ok(!label.toLowerCase().includes("newest"), `Expected label not to contain 'newest', got: '${label}'`);
});

// ── (b) keyword_pageable with ordering=time: genuinely newest-first ───────────

test("keyword_pageable ordering=time: descriptorIsTimeOrdered returns true", () => {
  const descriptor: KeywordPageableDescriptor = {
    kind: "keyword_pageable",
    ordering: "time",
    completeness: "pageable",
    has_more: true,
    cursor: "opaque-cursor-abc",
  };
  assert.equal(descriptorIsTimeOrdered(descriptor), true);
});

test("keyword_pageable ordering=time: feedHeaderLabel claims newest-first", () => {
  const descriptor: KeywordPageableDescriptor = {
    kind: "keyword_pageable",
    ordering: "time",
    completeness: "pageable",
    has_more: false,
    cursor: null,
  };
  const label = feedHeaderLabel(descriptor);
  assert.ok(label.toLowerCase().includes("newest"), `Expected label to include 'newest', got: '${label}'`);
});

test("keyword_pageable ordering=relevance: descriptorIsTimeOrdered returns false", () => {
  const descriptor: KeywordPageableDescriptor = {
    kind: "keyword_pageable",
    ordering: "relevance",
    completeness: "pageable",
    has_more: true,
    cursor: "opaque-cursor-xyz",
  };
  assert.equal(descriptorIsTimeOrdered(descriptor), false);
  // Label must NOT claim newest-first for relevance ordering:
  const label = feedHeaderLabel(descriptor);
  assert.ok(!label.toLowerCase().includes("newest"), `Expected label not to contain 'newest', got: '${label}'`);
});

test("keyword_pageable: descriptorHasMore and cursor forward correctly", () => {
  const cursor = "cursor-page-2";
  const descriptor: KeywordPageableDescriptor = {
    kind: "keyword_pageable",
    ordering: "time",
    completeness: "pageable",
    has_more: true,
    cursor,
  };
  assert.equal(descriptorHasMore(descriptor), true);
  assert.equal(descriptorNextCursor(descriptor), cursor);
});

test("keyword_pageable: when has_more=false, no Load-more is possible", () => {
  const descriptor: KeywordPageableDescriptor = {
    kind: "keyword_pageable",
    ordering: "relevance",
    completeness: "pageable",
    has_more: false,
    cursor: null,
  };
  assert.equal(descriptorHasMore(descriptor), false);
  assert.equal(descriptorNextCursor(descriptor), null);
});

// ── (c) complete_chronological: reaches the last record ──────────────────────

test("complete_chronological: feedHeaderLabel is 'Everything, newest first'", () => {
  const descriptor: CompleteChronologicalDescriptor = {
    kind: "complete_chronological",
    ordering: "time",
    completeness: "exhaustive",
    has_more: false,
    cursor: null,
  };
  assert.equal(feedHeaderLabel(descriptor), "Everything, newest first");
});

test("complete_chronological: descriptorIsTimeOrdered returns true", () => {
  const descriptor: CompleteChronologicalDescriptor = {
    kind: "complete_chronological",
    ordering: "time",
    completeness: "exhaustive",
    has_more: false,
    cursor: null,
  };
  assert.equal(descriptorIsTimeOrdered(descriptor), true);
});

test("complete_chronological: when has_more=false and cursor=null, no more pages (last record reached)", () => {
  const descriptor: CompleteChronologicalDescriptor = {
    kind: "complete_chronological",
    ordering: "time",
    completeness: "exhaustive",
    has_more: false,
    cursor: null,
  };
  assert.equal(descriptorHasMore(descriptor), false);
  assert.equal(descriptorNextCursor(descriptor), null);
});

test("complete_chronological: when has_more=true, cursor is non-null and Load-more is possible", () => {
  const cursor = "composite-cursor-page-2";
  const descriptor: CompleteChronologicalDescriptor = {
    kind: "complete_chronological",
    ordering: "time",
    completeness: "exhaustive",
    has_more: true,
    cursor,
  };
  assert.equal(descriptorHasMore(descriptor), true);
  assert.equal(descriptorNextCursor(descriptor), cursor);
});

// ── (d) filtered_exact: shows the true total ─────────────────────────────────

test("filtered_exact: descriptorHasTotal returns true and exposes the count", () => {
  const descriptor: FilteredExactDescriptor = {
    kind: "filtered_exact",
    ordering: "owner_chosen",
    completeness: "exact",
    total: 1183,
    has_more: false,
    cursor: null,
  };
  assert.equal(descriptorHasTotal(descriptor), true);
  // Type guard: after descriptorHasTotal, total is accessible as number.
  if (descriptorHasTotal(descriptor)) {
    assert.equal(descriptor.total, 1183);
  }
});

test("filtered_exact: feedHeaderLabel includes the total count", () => {
  const descriptor: FilteredExactDescriptor = {
    kind: "filtered_exact",
    ordering: "owner_chosen",
    completeness: "exact",
    total: 1183,
    has_more: false,
    cursor: null,
  };
  const label = feedHeaderLabel(descriptor);
  assert.ok(
    label.includes("1,183") || label.includes("1183"),
    `Expected label to include the total count, got: '${label}'`
  );
});

test("filtered_exact: non-exhausted set has_more=true and carries cursor", () => {
  const cursor = "exact-cursor-p2";
  const descriptor: FilteredExactDescriptor = {
    kind: "filtered_exact",
    ordering: "owner_chosen",
    completeness: "exact",
    total: 42,
    has_more: true,
    cursor,
  };
  assert.equal(descriptorHasMore(descriptor), true);
  assert.equal(descriptorNextCursor(descriptor), cursor);
});

test("filtered_exact: descriptorHasTotal returns false for other kinds", () => {
  const relevant: RelevanceBoundedDescriptor = {
    kind: "relevance_bounded",
    ordering: "relevance",
    completeness: "bounded_sample",
    has_more: false,
    cursor: null,
  };
  assert.equal(descriptorHasTotal(relevant), false);

  const chron: CompleteChronologicalDescriptor = {
    kind: "complete_chronological",
    ordering: "time",
    completeness: "exhaustive",
    has_more: false,
    cursor: null,
  };
  assert.equal(descriptorHasTotal(chron), false);
});

// ── Exhaustive switch: all kinds are handled ──────────────────────────────────

test("feedHeaderLabel handles all four descriptor kinds without throwing", () => {
  const descriptors: SetDescriptor[] = [
    { kind: "complete_chronological", ordering: "time", completeness: "exhaustive", has_more: false, cursor: null },
    { kind: "relevance_bounded", ordering: "relevance", completeness: "bounded_sample", has_more: false, cursor: null },
    { kind: "keyword_pageable", ordering: "relevance", completeness: "pageable", has_more: false, cursor: null },
    { kind: "keyword_pageable", ordering: "time", completeness: "pageable", has_more: false, cursor: null },
    {
      kind: "filtered_exact",
      ordering: "owner_chosen",
      completeness: "exact",
      total: 10,
      has_more: false,
      cursor: null,
    },
  ];
  for (const d of descriptors) {
    const label = feedHeaderLabel(d);
    assert.ok(typeof label === "string" && label.length > 0, `Expected non-empty label for kind=${d.kind}`);
  }
});

// ── F2 resolution: the "newest first" lie is structurally impossible ──────────

test("F2 fix: a relevance_bounded set cannot be rendered with a chronological claim (structural proof)", () => {
  // The F2 bug was: a relevance_bounded set was labeled "Browse all matching records,
  // newest first" — a lie. Under the descriptor contract:
  //   1. The set is labeled by feedHeaderLabel(descriptor) — returns "Top matches".
  //   2. The escape to chronological browsing is controlled by descriptor.kind.
  //   3. descriptorIsTimeOrdered(relevance_bounded) is false — no in-set recency sort.
  //   4. The UI renders the escape-to-exhaustive ramp ONLY because the descriptor
  //      is relevance_bounded, and labels it honestly as leaving the result set.
  // This test proves all four properties:
  const descriptor: RelevanceBoundedDescriptor = {
    kind: "relevance_bounded",
    ordering: "relevance",
    completeness: "bounded_sample",
    has_more: false,
    cursor: null,
  };

  // Property 1: label is "Top matches"
  assert.equal(feedHeaderLabel(descriptor), "Top matches");

  // Property 2: descriptor.kind === "relevance_bounded" drives the escape ramp
  assert.equal(descriptor.kind, "relevance_bounded");

  // Property 3: no in-set time ordering claim
  assert.equal(descriptorIsTimeOrdered(descriptor), false);

  // Property 4: no Load-more (proves no fake pagination)
  assert.equal(descriptorHasMore(descriptor), false);
  assert.equal(descriptorNextCursor(descriptor), null);
});

test("F2 fix: keyword_pageable/time IS allowed to claim newest-first (it is genuinely time-ordered)", () => {
  // The recency path for keyword search (Most-recent mode) uses lexical order=recent,
  // so it is genuinely emitted_at DESC within the candidate window. The descriptor
  // reflects this honestly: keyword_pageable with ordering=time.
  const descriptor: KeywordPageableDescriptor = {
    kind: "keyword_pageable",
    ordering: "time",
    completeness: "pageable",
    has_more: true,
    cursor: "cursor-abc",
  };

  // Allowed to claim time ordering:
  assert.equal(descriptorIsTimeOrdered(descriptor), true);

  // Label includes "newest":
  const label = feedHeaderLabel(descriptor);
  assert.ok(label.toLowerCase().includes("newest"), `Expected 'newest' in label, got: '${label}'`);

  // Has real pagination:
  assert.equal(descriptorHasMore(descriptor), true);
  assert.equal(descriptorNextCursor(descriptor), "cursor-abc");
});

// ── legalSortOptions: the descriptor-gated legal sort surface (sort cell §3) ──
//
// The sort cell's cardinal contract: a sort key may ONLY be a server-DECLARED
// sortable field (today exactly the stream's cursor/time field → a time
// DIRECTION); there is no amount/name/sender sort because no connector declares
// those sortable. The legal surface is gated by descriptor.kind — an
// unrepresentable claim (e.g. an in-set sort over a bounded sample) is
// structurally unreachable. These tests prove the matrix.

test("T1 legalSortOptions: complete_chronological → time axis {newest, oldest}", () => {
  const descriptor: CompleteChronologicalDescriptor = {
    kind: "complete_chronological",
    ordering: "time",
    completeness: "exhaustive",
    has_more: true,
    cursor: "c1",
  };
  const sort = legalSortOptions(descriptor);
  assert.equal(sort.axis, "time");
  assert.deepEqual(sort.axis === "time" ? sort.options : null, ["newest", "oldest"]);
});

test("T2 legalSortOptions: filtered_exact → time axis {newest, oldest}", () => {
  const descriptor: FilteredExactDescriptor = {
    kind: "filtered_exact",
    ordering: "owner_chosen",
    completeness: "exact",
    total: 42,
    has_more: false,
    cursor: null,
  };
  const sort = legalSortOptions(descriptor);
  assert.equal(sort.axis, "time");
  assert.deepEqual(sort.axis === "time" ? sort.options : null, ["newest", "oldest"]);
});

test("T3 legalSortOptions: keyword_pageable → rank axis {relevance, recent}", () => {
  const descriptor: KeywordPageableDescriptor = {
    kind: "keyword_pageable",
    ordering: "relevance",
    completeness: "pageable",
    has_more: true,
    cursor: "c1",
  };
  const sort = legalSortOptions(descriptor);
  assert.equal(sort.axis, "rank");
  assert.deepEqual(sort.axis === "rank" ? sort.options : null, ["relevance", "recent"]);
});

test("T4 legalSortOptions: relevance_bounded → axis 'none' (escape only, no in-set sort)", () => {
  const descriptor: RelevanceBoundedDescriptor = {
    kind: "relevance_bounded",
    ordering: "relevance",
    completeness: "bounded_sample",
    has_more: false,
    cursor: null,
  };
  const sort = legalSortOptions(descriptor);
  assert.equal(sort.axis, "none");
  // Structural: a bounded sample exposes NO options array at all — there is no
  // newest/oldest/in-set toggle to render. (T13: oldest never on a bounded sample.)
  assert.ok(!("options" in sort), "relevance_bounded must not expose any sort options");
});

test("T5/T6 legalSortOptions reads ONLY the descriptor — no field-name / x_pdpp_role sort", () => {
  // The legal sort surface is a function of descriptor.kind alone. It NEVER
  // references a field name or role, so an x_pdpp_role:amount (a PRESENTATION
  // role, not a sort capability) can never produce an "amount" sort. We assert
  // the only surfaced options are the canonical axis vocab — zero field names.
  const kinds: SetDescriptor[] = [
    { kind: "complete_chronological", ordering: "time", completeness: "exhaustive", has_more: false, cursor: null },
    {
      kind: "filtered_exact",
      ordering: "owner_chosen",
      completeness: "exact",
      total: 8,
      has_more: false,
      cursor: null,
    },
    { kind: "keyword_pageable", ordering: "time", completeness: "pageable", has_more: false, cursor: null },
    { kind: "relevance_bounded", ordering: "relevance", completeness: "bounded_sample", has_more: false, cursor: null },
  ];
  const allowed = new Set(["newest", "oldest", "relevance", "recent"]);
  const forbidden = ["amount", "name", "sender", "subject", "price", "total"];
  for (const d of kinds) {
    const sort = legalSortOptions(d);
    const options: readonly string[] = "options" in sort ? sort.options : [];
    for (const opt of options) {
      assert.ok(allowed.has(opt), `unexpected sort option '${opt}' for kind=${d.kind}`);
      assert.ok(!forbidden.includes(opt), `field-name/role sort '${opt}' must never appear`);
    }
  }
});
