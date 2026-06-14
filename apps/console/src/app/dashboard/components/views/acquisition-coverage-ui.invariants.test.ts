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
const MANUAL_UPLOAD_FORM_FILE = `${HERE}../../connect/manual-upload/[connectorId]/manual-upload-form.tsx`;
const STATUS_FILE = `${HERE}../../connect/status/[connectionId]/page.tsx`;

const ONE_STATUS_AND_ACTION_COPY = /one status and one next action/;
const SOURCE_JOURNEY_COPY = /source journey/i;
const SUPPORT_FACT_TEST_ID = /data-testid="source-support-fact"/;
const RECOMMENDED_NEXT_COPY = /Recommended next/;
const SUPPORT_DETAIL_DISCLOSURE = /<details[\s\S]*?Why this, and what to expect/;
const EXISTING_SOURCE_REUSE = /data-testid="existing-source-reuse"/;
const SAME_IDENTITY_COPY = /same account, profile, device, or\s+source identity/;
const MANIFEST_GENERATED_COPY = /generated from the connector manifest/;
const VALIDATES_BEFORE_COMMIT_COPY = /validates before committing/i;
const COVERAGE_RECEIPT_COPY = /coverage receipt|coverage provenance/i;
const PRIMARY_METHODS_IDENTIFIER = /primaryMethods/;
const ADVANCED_METHODS_IDENTIFIER = /advancedMethods/;
const OTHER_EXPORT_PATHS_DISCLOSURE = /<details[\s\S]*?Other ways to export this data/;
const IMPORT_OWNER_ARTIFACT_CTA = /Review file[\s\S]*Import this file/;
const OLD_FIRST_SYNC_CTA = /Upload and start first sync/;
const PROVIDER_CREDENTIAL_COPY = /provider account sign-in is required|provider credential/;
const DEPLOYMENT_SEMANTICS_COPY = /pnpm --dir|packages\/[a-z]|connector_instance_id|source_instance_id/;
const IMPORT_COMPLETE_COPY = /Import complete/;
const VALIDATED_AND_COMMITTED_COPY = /validated and committed/;
const COVERAGE_PREVIEW_COPY = /Coverage preview/;
const WHAT_PDPP_FOUND_COPY = /What PDPP found/;
const PARSED_RECORDS_COPY = /Parsed records/;
const ACCEPTED_COUNT_COPY = /Accepted/;
const DUPLICATE_COUNT_COPY = /Duplicates/;
const SKIPPED_COUNT_COPY = /Skipped/;
const FAILED_COUNT_COPY = /Failed/;
const ESTIMATED_POINTS_COPY = /Estimated points/;
const ESTIMATED_SEGMENTS_COPY = /Estimated segments/;
const COVERAGE_WINDOW_COPY = /Coverage window/;
const DURABLE_RECEIPT_COPY = /durable coverage receipt|committed acquisition-batch counts/i;
const IDEMPOTENT_REPEAT_COPY = /Repeating the same file[\s\S]*returns[\s\S]*this receipt/i;
const IMPORT_RECEIPT_REFERENCE = /status\.import_receipt/;
const MANUAL_UPLOAD_BRANCH = /status\.setup_kind === "manual_upload"/;
const IMPORT_STATE_FUNCTION = /function describeImportState/;
const IMPORT_COMPLETE_HEADLINE = /headline: "Import complete"/;
const IMPORT_FILE_COPY = /import file is captured/;
const IMPORT_PROGRESS_TEST_ID = /data-testid="import-progress"/;
const IMPORT_PHASES = [/Received/, /Parsed/, /Deduplicated/, /Committed/, /Indexed/, /Health projected/];
const NO_PARALLEL_PROGRESS_ENUM = /type ImportPhaseState = "current" \| "done" \| "failed" \| "waiting"/;
const SETUP_STATE_REFERENCE = /status\.setup_state/;
const IMPORT_RECEIPT_STATE_REFERENCE = /status\.import_receipt/;

// ── 1. Source catalog presents a source journey ─────────────────────────────

test("source catalog no longer frames itself as one status and one next action", async () => {
  const src = await readFile(CATALOG_FILE, "utf8");
  assert.doesNotMatch(src, ONE_STATUS_AND_ACTION_COPY);
  // Journey framing: the description names a source journey.
  assert.match(src, SOURCE_JOURNEY_COPY);
});

test("source card keeps the support fact distinct from the recommended next action", async () => {
  const src = await readFile(CATALOG_FILE, "utf8");
  // Current support/blocked fact is its own labelled element…
  assert.match(src, SUPPORT_FACT_TEST_ID);
  // …and the action is explicitly the recommended next step.
  assert.match(src, RECOMMENDED_NEXT_COPY);
  // Detail stays one low-noise disclosure away, not inline noise.
  assert.match(src, SUPPORT_DETAIL_DISCLOSURE);
  // Existing manual/import sources are offered before creating another source.
  assert.match(src, EXISTING_SOURCE_REUSE);
  assert.match(src, SAME_IDENTITY_COPY);
});

// ── 2. Manual/upload page is a coverage-assistant start ─────────────────────

test("manual upload page is manifest-generated and uses validate-before-commit language", async () => {
  const pageSrc = await readFile(MANUAL_UPLOAD_FILE, "utf8");
  const formSrc = await readFile(MANUAL_UPLOAD_FORM_FILE, "utf8");
  assert.match(pageSrc, MANIFEST_GENERATED_COPY);
  // Validates before durable commit when a validator exists.
  assert.match(formSrc, VALIDATES_BEFORE_COMMIT_COPY);
  // It speaks of a durable receipt the owner can revisit.
  assert.match(pageSrc, COVERAGE_RECEIPT_COPY);
});

test("manual upload page leads with primary methods and hides advanced behind one disclosure", async () => {
  const src = await readFile(MANUAL_UPLOAD_FILE, "utf8");
  assert.match(src, PRIMARY_METHODS_IDENTIFIER);
  assert.match(src, ADVANCED_METHODS_IDENTIFIER);
  // Exactly one disclosure for the secondary/advanced paths.
  assert.match(src, OTHER_EXPORT_PATHS_DISCLOSURE);
});

test("manual upload CTA imports an owner artifact rather than starting a sync", async () => {
  const src = await readFile(MANUAL_UPLOAD_FORM_FILE, "utf8");
  // The owner artifact is imported/validated, never "first sync".
  assert.match(src, IMPORT_OWNER_ARTIFACT_CTA);
  assert.doesNotMatch(src, OLD_FIRST_SYNC_CTA);
});

test("manual upload page does not imply provider credential or deployment semantics", async () => {
  const pageSrc = await readFile(MANUAL_UPLOAD_FILE, "utf8");
  const formSrc = await readFile(MANUAL_UPLOAD_FORM_FILE, "utf8");
  assert.doesNotMatch(`${pageSrc}\n${formSrc}`, PROVIDER_CREDENTIAL_COPY);
  assert.doesNotMatch(`${pageSrc}\n${formSrc}`, DEPLOYMENT_SEMANTICS_COPY);
});

// ── 3. Setup status page uses import/receipt language for manual_upload ──────

test("status page uses import/receipt language for manual_upload", async () => {
  const src = await readFile(STATUS_FILE, "utf8");
  assert.match(src, IMPORT_COMPLETE_COPY);
  assert.match(src, VALIDATED_AND_COMMITTED_COPY);
  assert.match(src, COVERAGE_PREVIEW_COPY);
  assert.match(src, WHAT_PDPP_FOUND_COPY);
  assert.match(src, PARSED_RECORDS_COPY);
  assert.match(src, ACCEPTED_COUNT_COPY);
  assert.match(src, DUPLICATE_COUNT_COPY);
  assert.match(src, SKIPPED_COUNT_COPY);
  assert.match(src, FAILED_COUNT_COPY);
  assert.match(src, ESTIMATED_POINTS_COPY);
  assert.match(src, ESTIMATED_SEGMENTS_COPY);
  assert.match(src, COVERAGE_WINDOW_COPY);
  assert.match(src, DURABLE_RECEIPT_COPY);
  assert.match(src, IDEMPOTENT_REPEAT_COPY);
  assert.match(src, IMPORT_RECEIPT_REFERENCE);
  // Branch is keyed on the import setup_kind, not source-specific React.
  assert.match(src, MANUAL_UPLOAD_BRANCH);
});

test("status page projects generic import progress phases from setup status", async () => {
  const src = await readFile(STATUS_FILE, "utf8");
  assert.match(src, IMPORT_PROGRESS_TEST_ID);
  for (const phase of IMPORT_PHASES) {
    assert.match(src, phase);
  }
  // This is a display projection from setup_state + receipt facts, not a second
  // onboarding lifecycle enum with source-specific states.
  assert.match(src, NO_PARALLEL_PROGRESS_ENUM);
  assert.match(src, SETUP_STATE_REFERENCE);
  assert.match(src, IMPORT_RECEIPT_STATE_REFERENCE);
});

test("status page never implies provider credential semantics for an import", async () => {
  const src = await readFile(STATUS_FILE, "utf8");
  // The active-import headline is a receipt, not "Connection active".
  assert.match(src, IMPORT_STATE_FUNCTION);
  assert.match(src, IMPORT_COMPLETE_HEADLINE);
  // The manual material noun stays an import file, never a credential.
  assert.match(src, IMPORT_FILE_COPY);
});
