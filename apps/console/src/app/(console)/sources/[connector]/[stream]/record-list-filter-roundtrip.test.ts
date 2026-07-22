// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Relationship-navigation filter round-trip pin — proves the stream LIST page is
 * the working RECEIVING end of a relationship link. When a user follows an
 * account -> transactions link, the href is `…/transactions?filter[account_id]=<key>`;
 * the destination list page must parse that `filter[field]=value` param back out
 * and pass it to `queryRecords` as an exact filter, or the "filtered children"
 * land on an UNfiltered list and relationship navigation silently no-ops.
 *
 * Why this exists on top of `lib/relationships.test.ts` (52 cases) and
 * `relationship-navigation-smoke.test.ts` (8 cases): those prove the link
 * GENERATORS build `filter[<fk>]=<parentKey>` hrefs with the right encoding. They
 * do NOT prove the link CONSUMER — the list page's `readExactFilters` /
 * `FILTER_PARAM_RE` — parses that exact shape back into a query filter. The two
 * halves of the round-trip were tested independently except for the consumer: a
 * refactor tightening `FILTER_PARAM_RE`, mishandling an array-valued param, or
 * dropping the `Object.keys(exactFilters).length > 0 ? { filter } : {}` wiring
 * into `queryRecords` would break navigation at the destination with zero
 * failures — the link would still be generated correctly but lead to an
 * unfiltered list. This file closes that gap two ways, mirroring the sibling
 * `record-list-money-wiring.test.ts` source-pin + behavior-replica style:
 *
 *   1. Wiring: the RSC `page.tsx` cannot be imported in a plain node test (it
 *      pulls in `next/navigation`). So the receiving wiring is guarded by
 *      source-pin: the `filter[field]` regex, the `readExactFilters` call, and the
 *      conditional `{ filter: exactFilters }` spread into the `queryRecords` call.
 *   2. Behavior: replicate `readExactFilters`'s exact contract against the SAME
 *      `filter[<fk>]=<parentKey>` shape the relationship link generators emit
 *      (decoded by Next before it reaches the page, exactly as
 *      `searchParams` delivers it) and assert the parsed filter map for the
 *      single-filter, array-valued, empty-value, and non-filter-param cases.
 *
 * No network, no credentials, no next runtime.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LIST_PAGE = `${HERE}page.tsx`;

// Source-pin regexes for the wiring tests, hoisted to module scope per the
// project's `useTopLevelRegex` lint rule and the sibling
// `record-list-money-wiring.test.ts` / `relationship-navigation-smoke.test.ts`
// convention.
//
// The list page must (a) recognize a `filter[field]` search param, (b) parse the
// raw search params into an exact-filter map, and (c) pass that map to
// `queryRecords` only when non-empty. All three are required for the relationship
// link's destination to actually filter; dropping any one silently regresses
// account -> transactions to an unfiltered list.
const LIST_DEFINES_FILTER_RE = /FILTER_PARAM_RE = \/\^filter\\\[\(\.\+\)\\\]\$\//;
const LIST_PARSES_FILTERS = /const exactFilters = readExactFilters\(/;
const LIST_PASSES_FILTERS_TO_QUERY = /Object\.keys\(exactFilters\)\.length > 0 \? \{ filter: exactFilters \} : \{\}/;

// Byte-faithful replica of the page's `readExactFilters` + `FILTER_PARAM_RE`
// (page.tsx). The real function is a non-exported local in an RSC module that
// imports `next/navigation`, so it cannot be imported; this mirror is pinned to
// the source by the WIRING tests below. `searchParams` arrives already
// URL-decoded from Next, so the keys here are the decoded `filter[<field>]`
// forms.
const FILTER_PARAM_RE = /^filter\[(.+)\]$/;
function readExactFiltersReplica(searchParams: Record<string, string | string[] | undefined>): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(searchParams)) {
    const match = FILTER_PARAM_RE.exec(key);
    if (!match) {
      continue;
    }
    const field = match[1];
    const raw = Array.isArray(value) ? value[0] : value;
    if (field && typeof raw === "string" && raw.length > 0) {
      filters[field] = raw;
    }
  }
  return filters;
}

test("BEHAVIOR the account -> transactions link's filter param parses back into an exact filter", () => {
  // This is exactly the param shape `reverseChildListLinksFromManifest` emits for
  // the Chase account -> transactions edge (`filter[account_id]=<accountKey>`),
  // delivered to the destination page decoded by Next.
  const filters = readExactFiltersReplica({ "filter[account_id]": "1212486749" });
  assert.deepEqual(
    filters,
    { account_id: "1212486749" },
    "the destination list page must recover the child_parent_key_field filter so the children are actually filtered"
  );
});

test("BEHAVIOR a non-filter search param (cursors/columns) is ignored", () => {
  // The page also receives pagination/column params; only `filter[...]` keys feed
  // the exact-filter map. Mixing them must not fabricate a filter.
  const filters = readExactFiltersReplica({
    cursors: "abc,def",
    columns: "amount,description",
    "filter[account_id]": "acc1",
  });
  assert.deepEqual(filters, { account_id: "acc1" }, "only filter[...] keys contribute; cursors/columns are ignored");
});

test("BEHAVIOR an array-valued filter param takes the first value", () => {
  // A duplicated query param arrives as an array; the page takes the first entry.
  const filters = readExactFiltersReplica({ "filter[account_id]": ["a1", "a2"] });
  assert.deepEqual(filters, { account_id: "a1" }, "a repeated filter param resolves to its first value");
});

test("BEHAVIOR an empty or absent filter value yields no filter (not a blank-string filter)", () => {
  // An empty filter value must NOT become `{account_id: ""}` — that would query
  // for the empty key instead of falling back to the unfiltered list.
  assert.deepEqual(readExactFiltersReplica({ "filter[account_id]": "" }), {}, "empty value contributes no filter");
  assert.deepEqual(
    readExactFiltersReplica({ "filter[account_id]": undefined }),
    {},
    "absent value contributes no filter"
  );
  assert.deepEqual(readExactFiltersReplica({ "filter[account_id]": [] }), {}, "empty array contributes no filter");
});

test("BEHAVIOR a field name containing brackets/separators is captured whole", () => {
  // The greedy `(.+)` capture keeps a field name intact even if it contains a
  // bracket, matching the generator's `encodeURIComponent(foreignKey)` (decoded
  // back by Next): a field like `a[b]` round-trips as the key, not a truncation.
  const filters = readExactFiltersReplica({ "filter[order[id]]": "ref/42" });
  assert.deepEqual(filters, { "order[id]": "ref/42" }, "the greedy capture keeps a bracketed field name whole");
});

test("WIRING list page defines the filter[field] param regex", async () => {
  const src = await readFile(LIST_PAGE, "utf8");
  assert.match(src, LIST_DEFINES_FILTER_RE, "list page must define FILTER_PARAM_RE = /^filter\\[(.+)\\]$/");
});

test("WIRING list page parses the incoming exact filters", async () => {
  const src = await readFile(LIST_PAGE, "utf8");
  assert.match(
    src,
    LIST_PARSES_FILTERS,
    "list page must parse the search params into exactFilters via readExactFilters"
  );
});

test("WIRING list page passes the parsed filters to queryRecords only when present", async () => {
  const src = await readFile(LIST_PAGE, "utf8");
  assert.match(
    src,
    LIST_PASSES_FILTERS_TO_QUERY,
    "list page must spread { filter: exactFilters } into queryRecords only when at least one filter is present"
  );
});
