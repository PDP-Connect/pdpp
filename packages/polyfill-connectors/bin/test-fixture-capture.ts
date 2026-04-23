#!/usr/bin/env node

/**
 * Smoke test for fixture-capture + scrub infrastructure.
 *
 * Simulates a small "connector run" inline:
 *   - Creates a capture session with PDPP_CAPTURE_FIXTURES=1
 *   - Records a few RECORD messages (with PII strings embedded)
 *   - Captures a mock DOM snapshot
 *   - Captures a mock HTTP response
 *   - Runs the scrubber
 *   - Asserts that PII strings survive in raw/ but are scrubbed in scrubbed/
 *
 * Exit 0 on success, 1 on failure. No network, no browser, no live auth.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

process.env.PDPP_CAPTURE_FIXTURES = "1";

const { createCaptureSession } = await import(`file://${join(PACKAGE_ROOT, "src/fixture-capture.js")}`);

const CONNECTOR = "_capture_smoke";
const fixturesRoot = join(PACKAGE_ROOT, "fixtures", CONNECTOR);

// Clean prior runs of the smoke connector.
if (existsSync(fixturesRoot)) {
  await rm(fixturesRoot, { recursive: true });
}

const capture = createCaptureSession(CONNECTOR);
if (!capture) {
  throw new Error("capture session not created (PDPP_CAPTURE_FIXTURES not respected?)");
}

// Simulate RECORDs with PII
capture.recordRecord({
  type: "RECORD",
  stream: "orders",
  data: {
    id: "abc",
    buyer_email: "alice@example.com",
    phone: "(555) 123-4567",
  },
});
capture.recordRecord({
  type: "RECORD",
  stream: "orders",
  data: { id: "def", buyer_email: "bob@test.org", ssn: "123-45-6789" },
});

// Simulate DOM capture via a stub page with a content() method
const stubPage = {
  content(): Promise<string> {
    return Promise.resolve("<html><body>Email: alice@example.com, phone (555) 123-4567</body></html>");
  },
};
await capture.captureDom(stubPage, "orders-list");

// Simulate HTTP capture
capture.captureHttp("orders-endpoint", JSON.stringify({ email: "charlie@foo.co" }), { status: 200 });

// Assert raw files exist and contain the PII verbatim
const rawRecordsFile = join(capture.baseDir, "records", "orders.jsonl");
const rawRecords = await readFile(rawRecordsFile, "utf8");
if (!rawRecords.includes("alice@example.com")) {
  throw new Error("raw records should contain PII");
}

const rawDom = await readFile(join(capture.baseDir, "dom", "orders-list.html"), "utf8");
if (!rawDom.includes("alice@example.com")) {
  throw new Error("raw dom should contain PII");
}

// Run the scrubber
const res = spawnSync("node", [join(PACKAGE_ROOT, "bin/scrub-fixtures.mjs"), CONNECTOR], {
  encoding: "utf8",
});
if (res.status !== 0) {
  console.error(res.stdout);
  console.error(res.stderr);
  throw new Error(`scrubber exited ${res.status}`);
}

// Assert scrubbed files are sanitized
const scrubbedDir = join(PACKAGE_ROOT, "fixtures", CONNECTOR, "scrubbed", capture.runId);
const scrubbedRecords = await readFile(join(scrubbedDir, "records/orders.jsonl"), "utf8");
const scrubbedDom = await readFile(join(scrubbedDir, "dom/orders-list.html"), "utf8");

const emailsRemainingInRecords = scrubbedRecords.match(/alice@example\.com|bob@test\.org/);
if (emailsRemainingInRecords) {
  throw new Error(`scrubbed records still contain original email: ${emailsRemainingInRecords[0]}`);
}
if (!scrubbedRecords.includes("redacted@example.com")) {
  throw new Error("scrubbed records missing redaction marker");
}

if (scrubbedDom.includes("alice@example.com")) {
  throw new Error("scrubbed dom still contains original email");
}

const ssnMatch = scrubbedRecords.match(/123-45-6789/);
if (ssnMatch) {
  throw new Error("scrubbed records still contain SSN");
}
if (!scrubbedRecords.includes("000-00-0000")) {
  throw new Error("scrubbed records missing SSN redaction marker");
}

// Cleanup
await rm(fixturesRoot, { recursive: true });

console.log("✓ fixture capture + scrub smoke test passed");
