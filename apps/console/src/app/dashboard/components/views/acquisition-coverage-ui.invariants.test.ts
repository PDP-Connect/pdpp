/**
 * Acquisition/coverage UI tranche invariants.
 *
 * Pins the owner-facing copy for the first slice toward the
 * `define-collection-acquisition-coverage` SLVP choreography so it cannot
 * silently regress back to single-status / provider-credential framing:
 *
 *   1. The source catalog presents a source JOURNEY (name, recommended next
 *      action, current support fact, low-noise path to detail) — never "one
 *      status and one next action".
 *   2. The manual/upload page reads as a coverage-assistant start: generated
 *      from the manifest, primary acquisition methods first with advanced paths
 *      behind one disclosure, validate-before-commit language, and an import
 *      (not "first sync") call to action for an owner artifact.
 *   3. The setup status page uses import/receipt language for `manual_upload`
 *      and never implies provider credential semantics for an import.
 *
 * These are JSX/React server components that cannot be imported under node:test
 * without a full resolver, so — mirroring sources-ia.invariants.test.ts — we
 * assert their critical structural copy from source.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CATALOG_FILE = `${HERE}../source-setup-catalog.tsx`;
const MANUAL_UPLOAD_FILE = `${HERE}../../connect/manual-upload/[connectorId]/page.tsx`;
const STATUS_FILE = `${HERE}../../connect/status/[connectionId]/page.tsx`;

// ── 1. Source catalog presents a source journey ─────────────────────────────

test("source catalog no longer frames itself as one status and one next action", async () => {
  const src = await readFile(CATALOG_FILE, "utf8");
  assert.doesNotMatch(src, /one status and one next action/);
  // Journey framing: the description names a source journey.
  assert.match(src, /source journey/i);
});

test("source card keeps the support fact distinct from the recommended next action", async () => {
  const src = await readFile(CATALOG_FILE, "utf8");
  // Current support/blocked fact is its own labelled element…
  assert.match(src, /data-testid="source-support-fact"/);
  // …and the action is explicitly the recommended next step.
  assert.match(src, /Recommended next/);
  // Detail stays one low-noise disclosure away, not inline noise.
  assert.match(src, /<details[\s\S]*?Why this, and what to expect/);
});

// ── 2. Manual/upload page is a coverage-assistant start ─────────────────────

test("manual upload page is manifest-generated and uses validate-before-commit language", async () => {
  const src = await readFile(MANUAL_UPLOAD_FILE, "utf8");
  assert.match(src, /generated from the connector manifest/);
  // Validates before durable commit when a validator exists.
  assert.match(src, /validates before committing/i);
  // It speaks of a durable receipt the owner can revisit.
  assert.match(src, /coverage receipt|coverage provenance/i);
});

test("manual upload page leads with primary methods and hides advanced behind one disclosure", async () => {
  const src = await readFile(MANUAL_UPLOAD_FILE, "utf8");
  assert.match(src, /primaryMethods/);
  assert.match(src, /advancedMethods/);
  // Exactly one disclosure for the secondary/advanced paths.
  assert.match(src, /<details[\s\S]*?Other ways to export this data/);
});

test("manual upload CTA imports an owner artifact rather than starting a sync", async () => {
  const src = await readFile(MANUAL_UPLOAD_FILE, "utf8");
  // The owner artifact is imported/validated, never "first sync".
  assert.match(src, /Validate and import|Import file/);
  assert.doesNotMatch(src, /Upload and start first sync/);
});

test("manual upload page does not imply provider credential or deployment semantics", async () => {
  const src = await readFile(MANUAL_UPLOAD_FILE, "utf8");
  assert.doesNotMatch(src, /provider account sign-in is required|provider credential/);
  assert.doesNotMatch(src, /pnpm --dir|packages\/[a-z]|connector_instance_id|source_instance_id/);
});

// ── 3. Setup status page uses import/receipt language for manual_upload ──────

test("status page uses import/receipt language for manual_upload", async () => {
  const src = await readFile(STATUS_FILE, "utf8");
  assert.match(src, /Import complete/);
  assert.match(src, /validated and committed/);
  // Branch is keyed on the import setup_kind, not source-specific React.
  assert.match(src, /status\.setup_kind === "manual_upload"/);
});

test("status page never implies provider credential semantics for an import", async () => {
  const src = await readFile(STATUS_FILE, "utf8");
  // The active-import headline is a receipt, not "Connection active".
  assert.match(src, /isImport \? "Import complete" : "Connection active"/);
  // The manual material noun stays an import file, never a credential.
  assert.match(src, /=== "manual_upload" \? "import file" : "provider credential"/);
});
