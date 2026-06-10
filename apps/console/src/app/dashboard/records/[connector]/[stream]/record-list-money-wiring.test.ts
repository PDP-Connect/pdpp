/**
 * Record-list money-wiring pin — proves the stream LIST page renders a declared
 * currency field with minor-unit formatting (chase `amount` 3000 -> `$30.00`) on
 * BOTH list surfaces: the desktop `<table>` cell (`cellText`) and the mobile
 * `RecordCard`.
 *
 * Why this exists on top of `record-field-format.test.ts` (10 cases): those tests
 * prove `formatDeclaredAmount` in isolation. They do NOT prove the list `page.tsx`
 * actually *applies* it. The page's money formatting was wired but pinned by no
 * test — a refactor dropping `formatDeclaredAmount` from `cellText` or the
 * `RecordCard` map would silently regress a Chase `amount` table cell back to the
 * raw `3000` with zero test failures. The relationship wiring on the same page is
 * already source-pinned by `relationship-navigation-smoke.test.ts`; the money
 * wiring was the symmetric, untested gap. This file closes it two ways, mirroring
 * that sibling smoke test's source-pin + behavior-replica style:
 *
 *   1. Wiring: the RSC `page.tsx` cannot be imported in a plain node test (it
 *      pulls in `next/navigation`), and `stringifyCell` lives in `rs-client.ts`
 *      which transitively imports `next/headers`. So the call sites are guarded by
 *      source-pin: both `cellText` (desktop) and the `RecordCard` map (mobile)
 *      must call `formatDeclaredAmount(value, declaredFieldTypes[column])` and
 *      fall back to `stringifyCell` for the non-monetary case.
 *   2. Behavior: replicate each surface's exact one-line cell expression —
 *      `const amount = formatDeclaredAmount(value, declaredType); return amount ?
 *      amount.text : stringifyCell(value)` — against the REAL
 *      `formatDeclaredAmount` and a local mirror of `stringifyCell`'s empty/plain
 *      contract (the function itself can't be imported without dragging in next),
 *      and assert the displayed cell text for the money, undeclared, and null
 *      cases the page must get right.
 *
 * No network, no credentials, no next runtime.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Import the operator-ui helpers RELATIVELY (mirroring the sibling
// `relationship-navigation-smoke.test.ts`, which reaches the bundled manifest the
// same `../../../../../../../../packages/...` depth): the `@pdpp/operator-ui/...`
// alias only resolves under the console's next/tsconfig toolchain, not in a plain
// `node --import tsx` run, while the page itself imports via the alias (pinned by
// the WIRING source-pin below).
import { formatDeclaredAmount } from "../../../../../../../../packages/operator-ui/src/lib/record-field-format.ts";
import type { DeclaredFieldTypes } from "../../../../../../../../packages/operator-ui/src/lib/record-kind.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LIST_PAGE = `${HERE}page.tsx`;

// Source-pin regexes for the wiring tests, hoisted to module scope per the
// project's `useTopLevelRegex` lint rule and the sibling
// `relationship-navigation-smoke.test.ts` convention.
const LIST_IMPORTS_FORMAT = /formatDeclaredAmount[\s\S]*from "@pdpp\/operator-ui\/lib\/record-field-format"/;
// Both cell surfaces must derive the amount from the value + the declared type
// for that column, then fall back to plain stringification.
const LIST_FORMATS_CELL_AMOUNT = /formatDeclaredAmount\(value, declaredFieldTypes\[column\]\)/;
const LIST_CELL_FALLS_BACK = /amount \? amount\.text : stringifyCell\(value\)/;
const LIST_CARD_FORMATS_AMOUNT = /formatDeclaredAmount\(record\.data\?\.\[c\], declaredFieldTypes\[c\]\)/;
const LIST_CARD_FALLS_BACK = /amount \? amount\.text : stringifyCell\(record\.data\?\.\[c\]\)/;

// Local mirror of `rs-client.ts`'s `stringifyCell` empty/plain contract. The real
// function can't be imported here without dragging in `next/headers` via the
// rs-client module chain; this replica is exercised only for the NON-monetary
// fallback, exactly the branch the page takes when `formatDeclaredAmount` returns
// null. Kept byte-faithful to the source for null/undefined -> "" and number ->
// String(n), which are the cases this test asserts.
function stringifyCellReplica(v: unknown): string {
  if (v === null || v === undefined) {
    return "";
  }
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return JSON.stringify(v);
}

// The exact one-line composition both `cellText` and the `RecordCard` map perform.
function displayCell(value: unknown, declaredType: string | undefined): string {
  const amount = formatDeclaredAmount(value, declaredType);
  return amount ? amount.text : stringifyCellReplica(value);
}

const CHASE_AMOUNT_CAPS: DeclaredFieldTypes = { amount: "currency" };

test("BEHAVIOR declared-currency minor-units cell renders as scaled dollars, not the raw integer", () => {
  assert.equal(
    displayCell(3000, CHASE_AMOUNT_CAPS.amount),
    "$30.00",
    "a chase `amount` of 3000 with a declared `currency` type must render as $30.00, not 3000"
  );
  assert.equal(displayCell(-1245, CHASE_AMOUNT_CAPS.amount), "-$12.45", "negative minor-units keeps its sign");
});

test("BEHAVIOR an UNDECLARED numeric cell is left as the plain integer (no magnitude guess)", () => {
  // No field cap for this column -> declaredFieldTypes[column] is undefined.
  assert.equal(
    displayCell(3000, undefined),
    "3000",
    "an undeclared 3000 must NOT be reinterpreted as cents — it stays 3000"
  );
});

test("BEHAVIOR null/absent cell values render empty, matching stringifyCell", () => {
  assert.equal(displayCell(null, CHASE_AMOUNT_CAPS.amount), "", "null renders empty even under a currency cap");
  assert.equal(displayCell(undefined, undefined), "", "absent renders empty");
});

test("WIRING list page imports the declared-currency formatter", async () => {
  const src = await readFile(LIST_PAGE, "utf8");
  assert.match(src, LIST_IMPORTS_FORMAT, "list page must import formatDeclaredAmount from operator-ui");
});

test("WIRING desktop cell (cellText) applies declared-currency formatting with a stringify fallback", async () => {
  const src = await readFile(LIST_PAGE, "utf8");
  assert.match(src, LIST_FORMATS_CELL_AMOUNT, "cellText must format the cell value against the column's declared type");
  assert.match(src, LIST_CELL_FALLS_BACK, "cellText must use the formatted amount, falling back to stringifyCell");
});

test("WIRING mobile RecordCard applies declared-currency formatting with a stringify fallback", async () => {
  const src = await readFile(LIST_PAGE, "utf8");
  assert.match(src, LIST_CARD_FORMATS_AMOUNT, "RecordCard must format each column value against its declared type");
  assert.match(src, LIST_CARD_FALLS_BACK, "RecordCard must use the formatted amount, falling back to stringifyCell");
});
