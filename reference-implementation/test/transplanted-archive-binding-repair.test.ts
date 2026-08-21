// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the transplanted-archive-binding-repair tool.
 *
 * The tool's correctness questions are all about what it REFUSES to do, so
 * that is what these pin hardest:
 *
 *   - it recognizes only the transplant envelope, never an already-correct
 *     top-level manual-upload binding (repairing one of those would be an
 *     unrequested mutation of a working row);
 *   - the lifted binding keeps every wrapped field, replaces exactly `kind`
 *     and `import_dir`, and carries the transplant provenance forward rather
 *     than erasing it;
 *   - discovery refuses on zero AND on multiple candidates instead of
 *     guessing which archive the owner meant.
 *
 * Payload-free by construction: fixtures are synthetic directories holding
 * placeholder files, and no assertion prints record content.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  backupTableName,
  buildRepairedBinding,
  connectorSegmentFromStalePath,
  discoverImportDir,
  isTransplantEnvelope,
  parseArgs,
  REPAIRED_BINDING_KIND,
  sanitizeIdentifierToken,
  TRANSPLANT_ENVELOPE_KIND,
  truncateId,
  validateArgs,
} from "../scripts/repair/transplanted-archive-binding-repair.ts";

const BACKUP_TABLE_PREFIX_PATTERN = /^tabr_backup_[0-9a-f]{8}__/;
const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9_]+$/;
const UNSAFE_TOKEN_ERROR = /unsafe x/;
const AMBIGUOUS_CANDIDATES_ERROR = /2 populated candidates/;
const DISAMBIGUATE_FLAG_ERROR = /--import-dir/;
const NO_CANDIDATE_ERROR = /no populated manual_upload_draft_\* directory/;
const UNREADABLE_ROOT_ERROR = /not readable on this host/;
const OVERRIDE_MISSING_ERROR = /does not exist or contains no files/;
const CIN_REQUIRED_ERROR = /--connector-instance-id is required/;
const IMPORT_DIR_ABSOLUTE_ERROR = /--import-dir must be an absolute path/;
const IMPORT_ROOT_ABSOLUTE_ERROR = /--import-root must be an absolute path/;

const STALE_MAPS_DIR =
  "/var/lib/pdpp/imports/google-maps/manual_upload_draft_18ca8a81687c37bac3731c7536202a4333ec3879ff86089f";

function transplantEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: TRANSPLANT_ENVELOPE_KIND,
    migrated_from_uat_instance_id: "cin_uat_example",
    original_source_binding: {
      acquisition_method: "owner_artifact",
      import_dir: STALE_MAPS_DIR,
      import_dir_env_var: "GOOGLE_MAPS_TIMELINE_DIR",
      kind: "manual_upload_draft",
      staged_upload: true,
    },
    recovery_reason: "uat_record_transfer",
    ...overrides,
  };
}

/** Create `<root>/<connector>/manual_upload_draft_<hash>/` holding one file. */
async function seedImportDir(root: string, connector: string, hash: string, populated = true): Promise<string> {
  const dir = path.join(root, connector, `manual_upload_draft_${hash}`);
  await mkdir(dir, { recursive: true });
  if (populated) {
    await mkdir(path.join(dir, "mua_example"), { recursive: true });
    await writeFile(path.join(dir, "mua_example", "artifact.json"), "{}");
  }
  return dir;
}

test("isTransplantEnvelope: recognizes the uat_record_transfer envelope", () => {
  assert.equal(isTransplantEnvelope(transplantEnvelope()), true);
});

test("isTransplantEnvelope: refuses an already-correct top-level manual upload", () => {
  // The critical negative: this row is FINE. Treating it as repairable would
  // rewrite a working binding for no reason.
  assert.equal(
    isTransplantEnvelope({
      import_dir: "/root/.pdpp/imports/whatsapp/manual_upload_draft_abc",
      import_dir_env_var: "WHATSAPP_EXPORT_DIR",
      kind: "manual_upload_draft",
    }),
    false
  );
});

test("isTransplantEnvelope: refuses an envelope whose wrapped binding lacks the run-resolver fields", () => {
  assert.equal(
    isTransplantEnvelope(transplantEnvelope({ original_source_binding: { kind: "manual_upload_draft" } })),
    false
  );
  assert.equal(isTransplantEnvelope(transplantEnvelope({ original_source_binding: null })), false);
});

test("isTransplantEnvelope: refuses non-objects and a foreign envelope kind", () => {
  assert.equal(isTransplantEnvelope(null), false);
  assert.equal(isTransplantEnvelope([]), false);
  assert.equal(isTransplantEnvelope("historical_archive"), false);
  assert.equal(isTransplantEnvelope(transplantEnvelope({ kind: "browser_session" })), false);
});

test("buildRepairedBinding: lifts the wrapped binding and replaces exactly kind + import_dir", () => {
  const envelope = transplantEnvelope();
  const repaired = buildRepairedBinding({
    envelope: envelope as never,
    importDir: "/root/.pdpp/imports/google-maps/manual_upload_draft_0bea586a",
  });

  assert.equal(repaired.kind, REPAIRED_BINDING_KIND);
  assert.equal(repaired.import_dir, "/root/.pdpp/imports/google-maps/manual_upload_draft_0bea586a");
  // Every other wrapped field survives verbatim.
  assert.equal(repaired.import_dir_env_var, "GOOGLE_MAPS_TIMELINE_DIR");
  assert.equal(repaired.acquisition_method, "owner_artifact");
  assert.equal(repaired.staged_upload, true);
  // The envelope is gone from the top level.
  assert.equal(repaired.original_source_binding, undefined);
});

test("buildRepairedBinding: carries transplant provenance forward instead of erasing it", () => {
  const repaired = buildRepairedBinding({
    envelope: transplantEnvelope() as never,
    importDir: "/root/.pdpp/imports/google-maps/manual_upload_draft_0bea586a",
  });
  assert.equal(repaired.recovery_reason, "uat_record_transfer");
  assert.equal(repaired.migrated_from_uat_instance_id, "cin_uat_example");
  assert.equal(repaired.repaired_from_kind, TRANSPLANT_ENVELOPE_KIND);
});

test("buildRepairedBinding: omits provenance keys the envelope did not carry", () => {
  const { migrated_from_uat_instance_id: _migrated, recovery_reason: _reason, ...envelope } = transplantEnvelope();
  const repaired = buildRepairedBinding({ envelope: envelope as never, importDir: "/root/.pdpp/imports/x/y" });
  assert.equal("migrated_from_uat_instance_id" in repaired, false);
  assert.equal("recovery_reason" in repaired, false);
});

test("connectorSegmentFromStalePath: reads the connector segment from the stale UAT path", () => {
  assert.equal(connectorSegmentFromStalePath(STALE_MAPS_DIR), "google-maps");
  assert.equal(
    connectorSegmentFromStalePath("/var/lib/pdpp/imports/whatsapp/manual_upload_draft_ea14c7e5"),
    "whatsapp"
  );
});

test("connectorSegmentFromStalePath: returns null when the leaf is not a draft directory", () => {
  assert.equal(connectorSegmentFromStalePath("/var/lib/pdpp/imports/google-maps"), null);
  assert.equal(connectorSegmentFromStalePath("/manual_upload_draft_abc"), null);
});

test("discoverImportDir: finds the one populated candidate on this host", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tabr-one-"));
  const expected = await seedImportDir(root, "google-maps", "0bea586a");

  const result = await discoverImportDir({ connectorSegment: "google-maps", importRoot: root, override: null });
  assert.equal(result.error, null);
  assert.equal(result.importDir, expected);
});

test("discoverImportDir: refuses when more than one populated candidate exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tabr-many-"));
  await seedImportDir(root, "google-maps", "aaaaaaaa");
  await seedImportDir(root, "google-maps", "bbbbbbbb");

  const result = await discoverImportDir({ connectorSegment: "google-maps", importRoot: root, override: null });
  assert.equal(result.importDir, null);
  assert.match(result.error ?? "", AMBIGUOUS_CANDIDATES_ERROR);
  assert.match(result.error ?? "", DISAMBIGUATE_FLAG_ERROR);
  assert.equal(result.candidates.length, 2);
});

test("discoverImportDir: ignores an empty draft directory rather than adopting it", async () => {
  // An empty directory is not the archive. Adopting it would repair the
  // binding into a still-broken state that then reports source_incomplete.
  const root = await mkdtemp(path.join(tmpdir(), "tabr-empty-"));
  await seedImportDir(root, "whatsapp", "emptyhash", false);
  const populated = await seedImportDir(root, "whatsapp", "realhash");

  const result = await discoverImportDir({ connectorSegment: "whatsapp", importRoot: root, override: null });
  assert.equal(result.importDir, populated);
});

test("discoverImportDir: refuses when no populated candidate exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tabr-none-"));
  await mkdir(path.join(root, "google-maps"), { recursive: true });

  const result = await discoverImportDir({ connectorSegment: "google-maps", importRoot: root, override: null });
  assert.equal(result.importDir, null);
  assert.match(result.error ?? "", NO_CANDIDATE_ERROR);
});

test("discoverImportDir: refuses an unreadable connector root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tabr-absent-"));
  const result = await discoverImportDir({ connectorSegment: "nope", importRoot: root, override: null });
  assert.equal(result.importDir, null);
  assert.match(result.error ?? "", UNREADABLE_ROOT_ERROR);
});

test("discoverImportDir: an explicit override still must exist and hold files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tabr-override-"));
  const populated = await seedImportDir(root, "whatsapp", "realhash");

  const ok = await discoverImportDir({ connectorSegment: "whatsapp", importRoot: root, override: populated });
  assert.equal(ok.importDir, populated);

  const missing = await discoverImportDir({
    connectorSegment: "whatsapp",
    importRoot: root,
    override: path.join(root, "whatsapp", "manual_upload_draft_ghost"),
  });
  assert.equal(missing.importDir, null);
  assert.match(missing.error ?? "", OVERRIDE_MISSING_ERROR);
});

test("parseArgs/validateArgs: --apply is opt-in and paths must be absolute", () => {
  const dry = parseArgs(["--connector-instance-id=cin_abc"]);
  assert.equal(dry.apply, false);
  assert.equal(dry.connectorInstanceId, "cin_abc");
  assert.equal(validateArgs(dry), null);

  const applied = parseArgs(["--connector-instance-id=cin_abc", "--apply"]);
  assert.equal(applied.apply, true);

  assert.match(validateArgs(parseArgs(["--apply"])) ?? "", CIN_REQUIRED_ERROR);
  assert.match(
    validateArgs(parseArgs(["--connector-instance-id=cin_abc", "--import-dir=relative/path"])) ?? "",
    IMPORT_DIR_ABSOLUTE_ERROR
  );
  assert.match(
    validateArgs(parseArgs(["--connector-instance-id=cin_abc", "--import-root=relative/path"])) ?? "",
    IMPORT_ROOT_ABSOLUTE_ERROR
  );
});

test("backupTableName: stays within the Postgres identifier limit and is deterministic", () => {
  const name = backupTableName({ connectorInstanceId: "cin_50f5bf4b7ecbc7acd6f4c254", stamp: "20260821090000" });
  assert.ok(name.length <= 63);
  assert.match(name, BACKUP_TABLE_PREFIX_PATTERN);
  assert.equal(name, backupTableName({ connectorInstanceId: "cin_50f5bf4b7ecbc7acd6f4c254", stamp: "20260821090000" }));
  assert.notEqual(
    name,
    backupTableName({ connectorInstanceId: "cin_a6aa0550ed70c8ce6bd73170", stamp: "20260821090000" })
  );
});

test("sanitizeIdentifierToken: rejects an empty or oversized token", () => {
  assert.throws(() => sanitizeIdentifierToken("", "x"), UNSAFE_TOKEN_ERROR);
  assert.throws(() => sanitizeIdentifierToken(null, "x"), UNSAFE_TOKEN_ERROR);
  assert.throws(() => sanitizeIdentifierToken("a".repeat(97), "x"), UNSAFE_TOKEN_ERROR);
});

test("sanitizeIdentifierToken: folds unsafe characters to underscores", () => {
  // Punctuation is neutralized rather than rejected -- the result is still a
  // safe bare identifier, which is what the backup-table name needs.
  assert.equal(sanitizeIdentifierToken("cin-ABC.123", "x"), "cin_abc_123");
  assert.match(sanitizeIdentifierToken("!!!", "x"), SAFE_IDENTIFIER_PATTERN);
});

test("truncateId: elides long identifiers", () => {
  assert.equal(truncateId("cin_50f5bf4b7ecbc7acd6f4c254"), "cin_50f5...c254");
  assert.equal(truncateId("short"), "short");
});
