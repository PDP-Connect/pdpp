import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveDeclaredFieldTypes, formatDeclaredAmount, isMonetaryDeclaredType } from "./record-field-format.ts";

test("formats a declared `currency` integer as cents (the live chase bug)", () => {
  // chase current_activity `amount: 3000` is signed integer cents; declared
  // `x_pdpp_type: currency`. It must render `$30.00`, not `$3000.00`.
  assert.deepEqual(formatDeclaredAmount(3000, "currency"), { text: "$30.00", positive: true });
});

test("formats a negative declared currency amount with a leading minus", () => {
  assert.deepEqual(formatDeclaredAmount(-1245, "currency"), { text: "-$12.45", positive: false });
});

test("a declared currency amount formats as cents regardless of magnitude", () => {
  // No magnitude heuristic here: 438120 cents = $4381.20, not $438.12.
  assert.deepEqual(formatDeclaredAmount(438_120, "currency"), { text: "$4381.20", positive: true });
});

test("a declared milliunits type divides by 1000", () => {
  assert.deepEqual(formatDeclaredAmount(-12_450, "currency_milliunits"), { text: "-$12.45", positive: false });
});

test("accepts the minor-units aliases case-insensitively", () => {
  assert.equal(formatDeclaredAmount(3000, "Currency")?.text, "$30.00");
  assert.equal(formatDeclaredAmount(3000, "minor_units")?.text, "$30.00");
  assert.equal(formatDeclaredAmount(3000, "cents")?.text, "$30.00");
});

test("returns null when no monetary unit is declared — no magnitude guess", () => {
  // An undeclared integer must NOT be reinterpreted as cents by this helper;
  // the caller keeps its plain rendering.
  assert.equal(formatDeclaredAmount(3000, undefined), null);
  assert.equal(formatDeclaredAmount(3000, "text"), null);
  assert.equal(formatDeclaredAmount(3000, "integer"), null);
});

test("returns null for non-finite or non-numeric values", () => {
  assert.equal(formatDeclaredAmount("3000", "currency"), null);
  assert.equal(formatDeclaredAmount(null, "currency"), null);
  assert.equal(formatDeclaredAmount(Number.NaN, "currency"), null);
});

test("isMonetaryDeclaredType recognizes only monetary units", () => {
  assert.equal(isMonetaryDeclaredType("currency"), true);
  assert.equal(isMonetaryDeclaredType("currency_milliunits"), true);
  assert.equal(isMonetaryDeclaredType("timestamp"), false);
  assert.equal(isMonetaryDeclaredType(undefined), false);
});

test("deriveDeclaredFieldTypes keeps only fields with a non-empty string type", () => {
  const types = deriveDeclaredFieldTypes({
    field_capabilities: {
      amount: { type: "currency" },
      date: { type: "timestamp" },
      account_id: { type: "" },
      memo: {},
      missing: null,
    },
  });
  assert.deepEqual(types, { amount: "currency", date: "timestamp" });
});

test("deriveDeclaredFieldTypes returns an empty object when metadata is absent or malformed", () => {
  assert.deepEqual(deriveDeclaredFieldTypes(null), {});
  assert.deepEqual(deriveDeclaredFieldTypes(undefined), {});
  assert.deepEqual(deriveDeclaredFieldTypes({ field_capabilities: null }), {});
});
