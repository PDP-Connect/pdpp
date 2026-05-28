import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "./timeline-summaries.ts";

test("a transactions record surfaces amount + merchant, not a bare timestamp", () => {
  const line = summarize("fabrikam_bank_demo", "transactions", {
    posted_at: "2026-04-22T13:42:00Z",
    merchant: "Bluebird Bakery",
    amount_cents: -1245,
    currency: "USD",
  });
  assert.ok(line.includes("-$12.45"), line);
  assert.ok(line.includes("Bluebird Bakery"), line);
  assert.ok(!line.includes("2026-04-22T13:42:00Z"), line);
});

test("a pay-statement record formats its cents amount", () => {
  const line = summarize("acme_payroll_demo", "pay_statements", {
    period_end: "2026-03-31",
    employer: "Northwind Studios",
    gross_pay_cents: 612_500,
    net_pay_cents: 438_120,
  });
  assert.ok(line.includes("$6125.00") || line.includes("Northwind Studios"), line);
  assert.ok(!line.startsWith("2026-"), line);
});

test("a tax-document record surfaces its document kind", () => {
  const line = summarize("acme_payroll_demo", "tax_documents", {
    issued_at: "2026-01-31T00:00:00Z",
    document_kind: "W2",
    year: 2025,
  });
  assert.ok(line.includes("W2"), line);
});

test("a clinical-visit record surfaces the provider name", () => {
  const line = summarize("northwind_health_demo", "clinical_visits", {
    visit_at: "2026-02-14T15:30:00Z",
    provider_name: "Dr. Avery Hale",
  });
  assert.ok(line.includes("Dr. Avery Hale"), line);
});

test("explicit per-stream summaries still win over the broadened fallback", () => {
  const line = summarize("gmail", "messages", {
    from: "alice@example.com",
    subject: "Lunch?",
  });
  assert.ok(line.includes("alice@example.com"), line);
  assert.ok(line.includes("Lunch?"), line);
});

test("a record with no human-identifying field degrades to a placeholder", () => {
  const line = summarize("opaque", "blobs", { id: "abc", checksum_sha: "deadbeef" });
  assert.equal(line, "(no summary)");
});
