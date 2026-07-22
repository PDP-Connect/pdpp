// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Accessibility + structure contract for the shared route-loading skeletons.
 *
 * Every records (and runs) `loading.tsx` renders one of the three skeletons in
 * this module inside the stable `DashboardShell`. The skeletons are the only
 * thing the owner sees while a `force-dynamic` page resolves, so their
 * loading-state contract is load-bearing UX:
 *
 *  - a polite `role="status"` live region that *names* what is loading, so
 *    assistive tech announces "Loading records…" instead of silence;
 *  - `aria-busy="true"` on the container so the busy state is programmatic;
 *  - decorative placeholder bars marked `aria-hidden` so a screen reader is
 *    not flooded with empty boxes;
 *  - deterministic, stable keys for the fixed skeleton rows (no array-index
 *    keys), so React does not churn the list mid-animation.
 *
 * This codebase has no JSX render harness today (see `connector-row.test.ts`),
 * so — like the sibling component tests — we assert the module's source wires
 * the contract the brief requires. The skeletons are pure, dependency-free
 * functions, so the source shape is an honest proxy for the rendered output.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// The module is `route-loading.tsx`; the `.ts` URL resolves to the same dir.
const SOURCE_FILE = `${HERE}route-loading.tsx`;

const SKELETONS = ["ListLoadingSkeleton", "TableLoadingSkeleton", "DetailLoadingSkeleton"] as const;

const STATUS_ROLE_RE = /role="status"/g;
const ARIA_BUSY_RE = /aria-busy="true"/g;
// The live region must interpolate `{label}` so it announces *what* is loading.
const NAMES_LABEL_RE = /Loading \{label\}/;
const SR_ONLY_RE = /className="sr-only"/;
// The shared decorative `Bar` primitive must be aria-hidden.
const BAR_ARIA_HIDDEN_RE = /function Bar\([^)]*\)\s*\{\s*return <span aria-hidden/;
// A deterministic key generator, not array-index keys.
const ROW_KEY_FN_RE = /function skeletonRowKeys\(rows: number\): string\[\]/;
const ROW_KEY_TEMPLATE_RE = /skeleton-row-\$\{i\}/;
const ARRAY_INDEX_KEY_RE = /key=\{\s*(?:i|index)\s*\}/;
// Table skeleton must be table-shaped, not the generic detail skeleton.
const TABLE_COLUMN_KEYS_RE = /columnKeys/;
const TABLE_DEFAULT_COLUMNS_RE = /columns = 4/;
// The resolved table leads with two fixed-shape columns (emitted_at, id) before
// its variable data columns; the skeleton must reproduce those widths so the
// column boundaries don't shift horizontally when the table paints.
const TABLE_HEADER_TIMESTAMP_WIDTH_RE = /className="h-3 w-24 shrink-0"/;
const TABLE_HEADER_ID_WIDTH_RE = /className="h-3 w-28 shrink-0"/;
const TABLE_BODY_TIMESTAMP_WIDTH_RE = /className="h-3\.5 w-24 shrink-0"/;
const TABLE_BODY_ID_WIDTH_RE = /className="h-3\.5 w-28 shrink-0"/;
const TABLE_DATA_COLUMNS_DERIVED_RE = /const dataColumns = Math\.max\(0, columns - 2\)/;

function exportedSkeletonRe(name: string): RegExp {
  return new RegExp(`export function ${name}\\b`);
}

function source(): Promise<string> {
  return readFile(SOURCE_FILE, "utf8");
}

test("each skeleton is exported and announces a polite, named loading status", async () => {
  const src = await source();
  for (const name of SKELETONS) {
    assert.match(src, exportedSkeletonRe(name), `${name} must be exported`);
  }
  // A single polite live region per skeleton that names the loading subject.
  // `role="status"` is an implicit `aria-live="polite"`; the `{label}`
  // interpolation is what turns it from "Loading…" into "Loading records…".
  const statusRegions = src.match(STATUS_ROLE_RE) ?? [];
  assert.equal(statusRegions.length, SKELETONS.length, "each skeleton must render exactly one role=status live region");
  assert.match(src, NAMES_LABEL_RE, "the live region must name what is loading via {label}");
  // The announcement must be visually hidden, not painted on screen.
  assert.match(src, SR_ONLY_RE);
});

test("each skeleton marks its container busy for assistive tech", async () => {
  const src = await source();
  const busy = src.match(ARIA_BUSY_RE) ?? [];
  assert.equal(busy.length, SKELETONS.length, "each skeleton container must set aria-busy=true");
});

test("decorative placeholder bars are hidden from assistive tech", async () => {
  const src = await source();
  // The shared `Bar` primitive is the only decorative element; it must be
  // aria-hidden so a screen reader is not read a wall of empty boxes. The
  // column-header bars in the table skeleton reuse the same primitive.
  assert.match(src, BAR_ARIA_HIDDEN_RE);
});

test("skeleton rows use stable deterministic keys, never array indexes", async () => {
  const src = await source();
  // A fixed, deterministic key generator instead of `key={i}` on a mapped
  // array — array-index keys make React re-key the whole list when the row
  // count changes, churning the pulse animation.
  assert.match(src, ROW_KEY_FN_RE);
  assert.match(src, ROW_KEY_TEMPLATE_RE);
  assert.doesNotMatch(src, ARRAY_INDEX_KEY_RE);
});

test("the table skeleton mirrors the resolved table geometry (header + column strip + rows)", async () => {
  const src = await source();
  // The records-table loading state must be table-shaped, not the generic
  // two-prose-block detail skeleton, or the layout jumps when the table paints.
  // Pin that it derives a column-key set and defaults to a sensible column
  // count, so the column-header strip and body cells share one column set.
  const tableBody = src.slice(src.indexOf("export function TableLoadingSkeleton"));
  assert.match(tableBody, TABLE_COLUMN_KEYS_RE, "table skeleton must derive a column-key set");
  assert.match(tableBody, TABLE_DEFAULT_COLUMNS_RE, "table skeleton must default to a sensible column count");
});

test("the table skeleton reproduces the resolved table's two fixed leading columns", async () => {
  const src = await source();
  // The resolved records table always renders `emitted_at` and `id` as its two
  // leading columns at fixed widths before any data columns. A skeleton that
  // draws all columns equal-width shifts the column boundaries horizontally when
  // the real table paints. Pin that the skeleton draws those two leading columns
  // distinctly and treats `columns` as the total (leading + data) count.
  const tableBody = src.slice(src.indexOf("export function TableLoadingSkeleton"));
  assert.match(tableBody, TABLE_HEADER_TIMESTAMP_WIDTH_RE, "table skeleton header must draw emitted_at width");
  assert.match(tableBody, TABLE_HEADER_ID_WIDTH_RE, "table skeleton header must draw id width");
  assert.match(tableBody, TABLE_BODY_TIMESTAMP_WIDTH_RE, "table skeleton body must draw emitted_at width");
  assert.match(tableBody, TABLE_BODY_ID_WIDTH_RE, "table skeleton body must draw id width");
  assert.match(
    tableBody,
    TABLE_DATA_COLUMNS_DERIVED_RE,
    "table skeleton must derive data columns as total columns minus the two leading columns"
  );
});
