#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * transplanted-archive-binding-repair
 *
 * Owner/operator-only repair for a manual-upload connection whose
 * `source_binding_json` was wrapped by an archive transplant and left
 * pointing at an import directory that does not exist on this host.
 *
 * The defect
 * ----------
 * When records were transferred off a UAT box, the transfer wrapped each
 * connection's real binding inside an envelope:
 *
 *     { kind: "historical_archive",
 *       recovery_reason: "uat_record_transfer",
 *       original_source_binding: { kind: "manual_upload_draft",
 *                                  import_dir: "<UAT path>", ... } }
 *
 * That envelope breaks the run-environment resolver three ways at once:
 *
 *   1. `isManualUploadBinding` (server/connection-scoped-run-env.ts) matches
 *      only a TOP-LEVEL `kind` of `manual_upload` / `manual_upload_draft`.
 *      A `historical_archive` envelope does not match, so the resolver
 *      returns null and the connector's import-dir env var is never set.
 *   2. The wrapped `import_dir` is the UAT host's absolute path
 *      (e.g. `/var/lib/pdpp/imports/...`), which does not exist here.
 *   3. The draft hash embedded in that path differs from the hash of the
 *      directory the artifacts actually landed in on this host, so even
 *      after re-rooting the prefix the leaf name is still wrong.
 *
 * The failure was SILENT: with no env var set, the connector saw no input and
 * the run reported `source_incomplete` rather than naming a missing path.
 * (The accompanying server fix makes a missing `import_dir` a legible error;
 * this tool repairs the bindings that defect already stranded.)
 *
 * What it does
 * ------------
 * For one connection, it lifts `original_source_binding` to the top level,
 * restores its `kind` (`manual_upload_draft`), and rewrites `import_dir` to
 * the directory that actually holds the artifacts on this host. The
 * replacement path is DISCOVERED by scanning the import root for the
 * connector's `manual_upload_draft_*` directories — never hardcoded, and
 * never trusted from the stale binding.
 *
 * The envelope's provenance is preserved, not discarded: `recovery_reason`
 * and `migrated_from_uat_instance_id` are carried onto the repaired binding
 * so the row still records where it came from, and `repaired_from_kind`
 * records what it was before this tool ran.
 *
 * Discovery + ambiguity
 * ---------------------
 * A candidate directory must (a) sit directly under
 * `<import-root>/<connector>/`, (b) be named `manual_upload_draft_<hash>`,
 * and (c) contain at least one file somewhere beneath it. If zero candidates
 * match, the repair refuses. If MORE than one matches, the repair refuses
 * rather than guessing which archive the owner meant — the operator must
 * disambiguate with `--import-dir`. Silently picking the newest would be the
 * same class of guess that produced this mess.
 *
 * Safety model
 * ------------
 *   - Default is dry-run. `--apply` is required to write.
 *   - Before any write, the pre-image `source_binding_json` is snapshotted
 *     into a backup table (prefix `tabr_backup`) inside the SAME transaction
 *     as the update, so the backup cannot survive a rolled-back write or
 *     vice versa.
 *   - The write is guarded on the binding still being the exact
 *     `historical_archive` envelope that was read, so a concurrent repair or
 *     an owner re-upload wins instead of being clobbered.
 *   - Only `source_binding_json` is touched. Status, records, credentials,
 *     grants, schedule, and spine are never read or written. This tool does
 *     NOT resume the connection — that is a separate, explicit owner action.
 *
 * Output discipline
 * -----------------
 * Paths under the import root are operator infrastructure, not record
 * payload, so they are printed to let the operator verify the target. No
 * record contents, credentials, or account identifiers are ever read.
 *
 * Usage:
 *   node reference-implementation/scripts/repair/transplanted-archive-binding-repair.ts \
 *     --connector-instance-id=cin_... [--import-root=/root/.pdpp/imports] \
 *     [--import-dir=/abs/path] [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL   required (postgres connection string).
 *                       PDPP_TEST_POSTGRES_URL is accepted as a fallback.
 *   PDPP_IMPORT_ROOT    default import root when --import-root is omitted.
 *
 * Exit codes:
 *   0  dry-run completed, or apply completed successfully.
 *   1  repair refused (nothing to do / ambiguous / missing artifacts), or
 *      apply failed (transaction rolled back).
 *   2  usage / configuration error.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pg from "pg";

const { Pool } = pg;

const PG_IDENTIFIER_MAX = 63;

export const BACKUP_TABLE_PREFIX = "tabr_backup";

/** The envelope kind this tool repairs. */
export const TRANSPLANT_ENVELOPE_KIND = "historical_archive";

/** The kind a repaired binding is restored to. */
export const REPAIRED_BINDING_KIND = "manual_upload_draft";

/** Default import root inside the reference container. */
export const DEFAULT_IMPORT_ROOT = "/root/.pdpp/imports";

const DRAFT_DIR_PREFIX = "manual_upload_draft_";

/** Truncate any identifier for compact output (head...tail elision). */
export function truncateId(value: unknown): string {
  const s = String(value ?? "");
  if (s.length <= 16) {
    return s;
  }
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

/**
 * Validate a token against a conservative identifier grammar so it is safe to
 * interpolate into a `CREATE TABLE` name. Parameters cannot be used for
 * identifiers, so the backup-table name is built from validated tokens only.
 */
export function sanitizeIdentifierToken(value: unknown, label: string): string {
  const s = String(value ?? "");
  const cleaned = s.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
  if (!cleaned || cleaned.length > 96) {
    throw new Error(`unsafe ${label} for backup-table name: ${JSON.stringify(value)}`);
  }
  return cleaned;
}

export interface BackupTableNameInput {
  connectorInstanceId: string;
  stamp: string;
}

/**
 * Compose a collision-safe backup-table name that stays within Postgres'
 * 63-byte identifier limit: `<prefix>_<hash8>__<cinFragment>__<stamp>`.
 */
export function backupTableName({ connectorInstanceId, stamp }: BackupTableNameInput): string {
  const cin = sanitizeIdentifierToken(connectorInstanceId, "connector-instance-id");
  const stmp = sanitizeIdentifierToken(stamp, "stamp");
  const hash8 = createHash("sha256")
    .update(JSON.stringify([cin, stmp]))
    .digest("hex")
    .slice(0, 8);
  const base = `${BACKUP_TABLE_PREFIX}_${hash8}`;
  const stampPart = stmp.slice(0, 16);
  const remaining = PG_IDENTIFIER_MAX - base.length - 4 - stampPart.length;
  const cinPart = remaining > 0 ? cin.slice(0, remaining) : "";
  const name = `${base}__${cinPart}__${stampPart}`;
  if (name.length > PG_IDENTIFIER_MAX) {
    throw new Error(`backup-table name exceeds ${PG_IDENTIFIER_MAX} bytes: ${name}`);
  }
  return name;
}

export interface ParsedArgs {
  apply: boolean;
  connectorInstanceId: string | null;
  importDir: string | null;
  importRoot: string | null;
}

/** Parse argv into the tool's option record. */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { apply: false, connectorInstanceId: null, importDir: null, importRoot: null };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const val = eq > 0 ? arg.slice(eq + 1) : "";
    if (key === "connector-instance-id") {
      out.connectorInstanceId = String(val);
    } else if (key === "import-root") {
      out.importRoot = String(val);
    } else if (key === "import-dir") {
      out.importDir = String(val);
    } else if (key === "apply") {
      out.apply = true;
    }
  }
  return out;
}

/** Return a usage error string, or null when the args are well-formed. */
export function validateArgs(args: ParsedArgs): string | null {
  if (!args.connectorInstanceId) {
    return "--connector-instance-id is required";
  }
  if (args.importDir !== null && !path.isAbsolute(args.importDir)) {
    return "--import-dir must be an absolute path";
  }
  if (args.importRoot !== null && !path.isAbsolute(args.importRoot)) {
    return "--import-root must be an absolute path";
  }
  return null;
}

export interface ManualUploadBindingShape {
  readonly import_dir: string;
  readonly import_dir_env_var: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface TransplantEnvelope {
  readonly kind: string;
  readonly original_source_binding?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Recognize the transplant envelope this tool repairs: a `historical_archive`
 * wrapper carrying a manual-upload binding under `original_source_binding`.
 *
 * Deliberately strict. A binding that is ALREADY a top-level manual upload is
 * not an envelope and must not be "repaired" — it is already correct, and
 * rewriting it would be an unrequested mutation.
 */
export function isTransplantEnvelope(value: unknown): value is TransplantEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.kind !== TRANSPLANT_ENVELOPE_KIND) {
    return false;
  }
  return isWrappedManualUploadBinding(envelope.original_source_binding);
}

/** The wrapped binding must carry the two fields the run resolver needs. */
export function isWrappedManualUploadBinding(value: unknown): value is ManualUploadBindingShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.import_dir === "string" &&
    binding.import_dir.length > 0 &&
    typeof binding.import_dir_env_var === "string" &&
    binding.import_dir_env_var.length > 0
  );
}

/**
 * Build the repaired top-level binding.
 *
 * Pure, and the heart of the tool. The wrapped binding is lifted verbatim
 * except for the two fields that must change (`kind`, `import_dir`), plus
 * provenance carried down from the envelope so the transplant history is not
 * erased by the repair.
 */
export function buildRepairedBinding(args: {
  envelope: TransplantEnvelope;
  importDir: string;
}): Record<string, unknown> {
  const wrapped = args.envelope.original_source_binding as ManualUploadBindingShape;
  const repaired: Record<string, unknown> = {
    ...wrapped,
    import_dir: args.importDir,
    kind: REPAIRED_BINDING_KIND,
    repaired_from_kind: args.envelope.kind,
  };
  if (typeof args.envelope.recovery_reason === "string") {
    repaired.recovery_reason = args.envelope.recovery_reason;
  }
  if (typeof args.envelope.migrated_from_uat_instance_id === "string") {
    repaired.migrated_from_uat_instance_id = args.envelope.migrated_from_uat_instance_id;
  }
  return repaired;
}

/**
 * Derive the connector's import subdirectory name from the stale binding.
 *
 * The transplanted `import_dir` is wrong about the ROOT and about the draft
 * HASH, but its connector segment (the parent of the `manual_upload_draft_*`
 * leaf) is the connector key, which the transplant did not change. Using it
 * keeps discovery scoped to the right connector instead of scanning every
 * connector's imports.
 */
export function connectorSegmentFromStalePath(stalePath: string): string | null {
  const normalized = path.posix.normalize(stalePath);
  const leaf = path.posix.basename(normalized);
  if (!leaf.startsWith(DRAFT_DIR_PREFIX)) {
    return null;
  }
  const segment = path.posix.basename(path.posix.dirname(normalized));
  return segment && segment !== "." && segment !== "/" ? segment : null;
}

export interface DiscoveryResult {
  candidates: string[];
  error: string | null;
  importDir: string | null;
}

/** True when the directory holds at least one file at any depth. */
async function containsAnyFile(dir: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      return true;
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // biome-ignore lint/performance/noAwaitInLoops: a depth-first probe that must STOP at the first file found; racing every subtree in parallel would stat directories this returns before reading.
      const found = await containsAnyFile(path.join(dir, entry.name));
      if (found) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Find the directory on THIS host that holds the connection's artifacts.
 *
 * Refuses on zero and on more than one candidate. See the file header for why
 * "pick the newest" is not an acceptable tiebreak here.
 */
export async function discoverImportDir(args: {
  connectorSegment: string;
  importRoot: string;
  override: string | null;
}): Promise<DiscoveryResult> {
  if (args.override) {
    const ok = await containsAnyFile(args.override);
    if (!ok) {
      return {
        candidates: [],
        error: `--import-dir ${args.override} does not exist or contains no files`,
        importDir: null,
      };
    }
    return { candidates: [args.override], error: null, importDir: args.override };
  }

  const connectorRoot = path.join(args.importRoot, args.connectorSegment);
  let entries: Dirent[];
  try {
    entries = await readdir(connectorRoot, { withFileTypes: true });
  } catch {
    return { candidates: [], error: `import root ${connectorRoot} is not readable on this host`, importDir: null };
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (!(entry.isDirectory() && entry.name.startsWith(DRAFT_DIR_PREFIX))) {
      continue;
    }
    const full = path.join(connectorRoot, entry.name);
    // biome-ignore lint/performance/noAwaitInLoops: candidate counts here are single-digit; a sequential probe keeps the refuse-on-ambiguity accounting trivially ordered and the I/O is negligible.
    const populated = await containsAnyFile(full);
    if (populated) {
      candidates.push(full);
    }
  }

  if (candidates.length === 0) {
    return {
      candidates,
      error: `no populated ${DRAFT_DIR_PREFIX}* directory under ${connectorRoot}`,
      importDir: null,
    };
  }
  if (candidates.length > 1) {
    return {
      candidates,
      error: `${candidates.length} populated candidates under ${connectorRoot}; re-run with --import-dir to disambiguate`,
      importDir: null,
    };
  }
  return { candidates, error: null, importDir: candidates[0] as string };
}

export interface RepairResult {
  applied: boolean;
  backupTable: string | null;
  candidates: string[];
  error: string | null;
  failed: boolean;
  importDirAfter: string | null;
  importDirBefore: string | null;
  repaired: boolean;
  repairedBinding: Record<string, unknown> | null;
}

function refusal(base: RepairResult, error: string): RepairResult {
  return { ...base, error, failed: true };
}

/**
 * Repair one connection's transplanted binding. With `apply` false nothing is
 * written and the caller sees exactly what would change.
 */
export async function runRepair(args: {
  apply: boolean;
  connectorInstanceId: string;
  importDirOverride: string | null;
  importRoot: string;
  pool: pg.Pool;
  stamp: string;
}): Promise<RepairResult> {
  const base: RepairResult = {
    applied: args.apply,
    backupTable: null,
    candidates: [],
    error: null,
    failed: false,
    importDirAfter: null,
    importDirBefore: null,
    repaired: false,
    repairedBinding: null,
  };

  const current = await args.pool.query(
    "SELECT source_binding_json FROM connector_instances WHERE connector_instance_id = $1",
    [args.connectorInstanceId]
  );
  if ((current.rowCount ?? 0) === 0) {
    return refusal(base, `connector instance ${args.connectorInstanceId} not found`);
  }

  const raw = current.rows[0]?.source_binding_json;
  const envelope: unknown = typeof raw === "string" ? safeParseJson(raw) : raw;
  if (!isTransplantEnvelope(envelope)) {
    return refusal(
      base,
      `binding is not a '${TRANSPLANT_ENVELOPE_KIND}' envelope wrapping a manual upload; nothing to repair`
    );
  }

  const wrapped = envelope.original_source_binding as ManualUploadBindingShape;
  const importDirBefore = wrapped.import_dir;
  const connectorSegment = connectorSegmentFromStalePath(importDirBefore);
  if (!connectorSegment) {
    return refusal(base, `cannot derive a connector segment from the stale import_dir ${importDirBefore}`);
  }

  const discovery = await discoverImportDir({
    connectorSegment,
    importRoot: args.importRoot,
    override: args.importDirOverride,
  });
  const withDiscovery: RepairResult = { ...base, candidates: discovery.candidates, importDirBefore };
  if (!discovery.importDir) {
    return refusal(withDiscovery, discovery.error ?? "import directory discovery failed");
  }

  const repairedBinding = buildRepairedBinding({ envelope, importDir: discovery.importDir });
  const planned: RepairResult = {
    ...withDiscovery,
    importDirAfter: discovery.importDir,
    repairedBinding,
  };

  if (!args.apply) {
    return planned;
  }

  const table = backupTableName({ connectorInstanceId: args.connectorInstanceId, stamp: args.stamp });
  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${table}" (
         connector_instance_id text NOT NULL,
         source_binding_json jsonb NOT NULL,
         backed_up_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    await client.query(
      `INSERT INTO "${table}" (connector_instance_id, source_binding_json)
       SELECT connector_instance_id, source_binding_json::jsonb
         FROM connector_instances
        WHERE connector_instance_id = $1`,
      [args.connectorInstanceId]
    );
    // Guarded on the binding still being the exact envelope that was read, so
    // a concurrent repair or a fresh owner upload wins rather than losing.
    const updated = await client.query(
      `UPDATE connector_instances
          SET source_binding_json = $2
        WHERE connector_instance_id = $1
          AND source_binding_json::jsonb = $3::jsonb`,
      [args.connectorInstanceId, JSON.stringify(repairedBinding), JSON.stringify(envelope)]
    );
    if ((updated.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return refusal(planned, "binding changed concurrently; no rows updated (transaction rolled back)");
    }
    await client.query("COMMIT");
    return { ...planned, backupTable: table, repaired: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    return refusal(planned, err instanceof Error ? err.message : String(err));
  } finally {
    client.release();
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Render the operator-facing summary. */
export function formatSummary(result: RepairResult, connectorInstanceId: string): string {
  const lines: string[] = [];
  const mode = result.applied ? "APPLY" : "DRY-RUN";
  lines.push(`transplanted-archive-binding-repair [${mode}]: cin=${truncateId(connectorInstanceId)}`);
  lines.push(`  import_dir before   ${result.importDirBefore ?? "(none)"}`);
  lines.push(`  import_dir after    ${result.importDirAfter ?? "(unresolved)"}`);
  if (result.candidates.length > 1) {
    for (const candidate of result.candidates) {
      lines.push(`    candidate         ${candidate}`);
    }
  }
  if (result.failed) {
    lines.push(`  REFUSED: ${result.error}`);
    return lines.join("\n");
  }
  if (result.applied) {
    lines.push(`  kind                ${TRANSPLANT_ENVELOPE_KIND} -> ${REPAIRED_BINDING_KIND}`);
    lines.push(`  repaired            ${result.repaired ? "yes" : "no"}`);
    lines.push(`  backup_table=${result.backupTable}`);
  } else {
    lines.push(`  kind                ${TRANSPLANT_ENVELOPE_KIND} -> ${REPAIRED_BINDING_KIND} (planned)`);
    lines.push("  (dry-run) re-run with --apply to repair.");
  }
  return lines.join("\n");
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1])
  : false;

if (invokedAsScript) {
  await runCli();
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const validationError = validateArgs(args);
  if (validationError) {
    console.error(validationError);
    process.exit(2);
  }
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error("PDPP_DATABASE_URL is required");
    process.exit(2);
  }
  const connectorInstanceId = args.connectorInstanceId as string;
  const importRoot = args.importRoot || process.env.PDPP_IMPORT_ROOT || DEFAULT_IMPORT_ROOT;
  const stamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    const result = await runRepair({
      apply: args.apply,
      connectorInstanceId,
      importDirOverride: args.importDir,
      importRoot,
      pool,
      stamp,
    });
    console.log(formatSummary(result, connectorInstanceId));
    exitCode = result.failed ? 1 : 0;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}
