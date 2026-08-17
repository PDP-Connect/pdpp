#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * compact-record-history
 *
 * Owner/operator-only operational tool that compacts provably-redundant
 * adjacent historical `record_changes` rows under a per-stream
 * fingerprint policy that either mirrors the connector's own
 * no-op-emit definition or treats the canonical stable-JSON of
 * `record_json` itself as the fingerprint.
 *
 * Scope is deny-by-default. Two policy families are eligible:
 *
 *   1. "Connector fingerprint mirror" — streams whose connectors
 *      ship a semantic fingerprint cursor (a08d7a0a, 47ec8edd, 228305a6).
 *      The script's `excludeKeys` mirrors the connector's:
 *        - gmail / threads
 *        - gmail / labels      (fingerprint over the stored body; the
 *                               connector's synthetic keying `id` is not
 *                               stored, so excludeKeys is empty)
 *        - slack / workspace   (fingerprint excludes `fetched_at`)
 *        - slack / users
 *        - slack / files
 *        - slack / channel_memberships (excludes `fetched_at`; real
 *                               membership identity channel_id/user_id
 *                               preserved as a fingerprint boundary)
 *        - ynab  / payee_locations
 *        - ynab  / budgets     (excludes `last_month`,`last_modified_on`)
 *        - usaa  / statements  (excludes `fetched_at`)
 *        - chase / accounts    (excludes `fetched_at`)
 *        - usaa  / accounts    (excludes `fetched_at`; real balance_cents
 *                               is preserved as a fingerprint boundary)
 *        - usaa  / credit_card_billing (excludes `fetched_at`; real
 *                               balances/rewards/APRs preserved as boundaries)
 *
 *   2. "Exact stable-JSON identity" — local-device connectors
 *      (codex, claude-code) whose record bodies are derived from
 *      on-disk JSONL / sqlite without volatile fields in the record
 *      payload itself (no `fetched_at` in `record_json`, timestamps
 *      come from the underlying source event, mtimes are gated at the
 *      file walker layer rather than included in the record).
 *      Adjacent versions with byte-identical canonical JSON are
 *      provably redundant under the connector's own emit semantics —
 *      a re-emitted row that matches a prior row is, by construction,
 *      either an idempotent re-write of the same source event or an
 *      mtime-gate miss. Compacting it removes nothing the connector
 *      would consider a meaningful version transition.
 *        - codex      / messages, function_calls, sessions, skills, prompts, rules
 *        - claude-code / messages, attachments, sessions, skills,
 *                        memory_notes, slash_commands
 *
 *   3. "Inventory churn gate" — local-device `inventory_only`/`defer`
 *      stores (codex, claude-code) whose metadata records carry the
 *      volatile `mtime_epoch`/`size_bytes` file-stat fields. The
 *      connector gates these streams with an inventory fingerprint
 *      cursor that excludes exactly those two keys, so an unchanged
 *      store does not re-version on a pure mtime/size tick. This policy
 *      excludes the same two keys; the inventory meaning (path, type,
 *      classification, reason) stays a fingerprint boundary.
 *        - claude-code / backup_inventory, cache_inventory,
 *                        config_inventory, file_history
 *        - codex       / history, session_index, shell_snapshots,
 *                        config_inventory, cache_inventory, logs
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL` (or `PDPP_TEST_POSTGRES_URL`). There is no HTTP
 * route, no scheduler, no automatic background job.
 *
 * Default is dry-run. Use --apply to actually delete redundant rows.
 *
 * Modes (--mode, default `audit`):
 *   - audit     — conservative retention (first observation + current +
 *                 most-recent-differing-prior per key); the only behavior for
 *                 every stream unless canonical is explicitly requested.
 *   - canonical — opt-in stronger convergence for streams whose policy declares
 *                 `changeModel: "immutable_semantic"` and
 *                 `representativePolicy: "current"`. Lowers the same-fingerprint
 *                 retention floor to ONE survivor per semantic run (the current
 *                 `records.version` row wins its run); preserves every distinct
 *                 canonical fingerprint boundary, tombstone, and resurrection
 *                 boundary; never renumbers. Refuses (fails closed) for any
 *                 ineligible policy. First and only eligible stream this slice:
 *                 chase/transactions.
 *
 * Apply safety:
 *   - Per-run backup table `compact_record_history_backup_<runId>` is
 *     created and populated with every row to be deleted, INSIDE the
 *     same transaction as the DELETE. The table persists after commit
 *     as the operator's rollback handle.
 *   - Insert/delete row counts are asserted equal before commit; any
 *     mismatch rolls the transaction back.
 *
 * Usage:
 *   node reference-implementation/scripts/compact-record-history.mjs \
 *     --connector-instance-id=cin_... \
 *     --stream=threads \
 *     [--connector-id=gmail] \
 *     [--limit-keys=<positive-int>] \
 *     [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL or PDPP_TEST_POSTGRES_URL    required
 *
 * Spec: openspec/changes/compact-retained-record-history/specs/
 *       reference-implementation-architecture/spec.md
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pg from "pg";

const { Pool } = pg;

/**
 * Per-connector fingerprint-exclusion policy is CONNECTOR-OWNED DATA,
 * declared on each stream's own manifest entry (`compaction_fingerprint`),
 * never compiled into this script as a connector-keyed literal or read from
 * an RI-owned sibling JSON registry (ri-zero-knowledge-terminal-revise-0810
 * closed the latter: an RI-committed JSON file naming connector/stream
 * identity is exactly as much self-attested connector knowledge as the same
 * fact written into `.ts` source, just reached via a different seam — see
 * `reference-implementation/test/ri-zero-connector-knowledge-conformance.test.ts`).
 *
 * This script reads every manifest under both shipped manifest roots
 * (`packages/polyfill-connectors/manifests/`, `reference-implementation/
 * manifests/` — mirroring `scripts/generate-connector-registry.ts`'s own
 * static, load-time enumeration of the same two roots, the sanctioned
 * pattern for RI tooling that needs the full manifest set rather than one
 * connector at a time via the runtime installed-connector catalog) and
 * builds `COMPACTION_POLICIES` GENERICALLY from whichever streams declare a
 * `compaction_fingerprint` field — this script contains no connector-name
 * branch anywhere. `compaction_fingerprint.exclude_keys` (and the optional
 * `change_model`/`representative_policy`/`content_gate` fields) is a FACT a
 * connector safely self-attests about its OWN emitted record shape (which
 * fields on ITS OWN records are run-clock/acquisition noise versus real
 * content) — this is categorically different from `version-disposition.ts`'s
 * reviewed-residue map, which is an OWNER JUDGMENT CALL about a specific
 * connector INSTANCE's observed history and must never be self-attested;
 * see that module's own doc comment for why that one stays outside any
 * manifest.
 */
interface CompactionFingerprintContentGate {
  readonly gated_exclude_keys: readonly string[];
  readonly presence_fields: readonly string[];
}
interface CompactionFingerprintDeclaration {
  readonly change_model?: "immutable_semantic";
  readonly content_gate?: CompactionFingerprintContentGate;
  readonly exclude_keys: readonly string[];
  readonly representative_policy?: "current";
}
interface ManifestStreamLike {
  readonly compaction_fingerprint?: CompactionFingerprintDeclaration;
  readonly name?: unknown;
}
interface ManifestLike {
  readonly connector_id?: unknown;
  readonly connector_key?: unknown;
  readonly streams?: readonly ManifestStreamLike[];
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const riRoot = resolve(scriptDir, "..");
const repoRoot = resolve(riRoot, "..");

const REGISTRY_ID_PREFIX = "https://registry.pdpp.dev/connectors/";

function connectorKeyFromManifest(manifest: ManifestLike): string | null {
  if (typeof manifest.connector_key === "string" && manifest.connector_key.length > 0) {
    return manifest.connector_key;
  }
  if (typeof manifest.connector_id === "string" && manifest.connector_id.startsWith(REGISTRY_ID_PREFIX)) {
    return manifest.connector_id.slice(REGISTRY_ID_PREFIX.length);
  }
  return null;
}

/** Every `*.json` manifest directly under `packages/polyfill-connectors/
 * manifests/`, parsed. Malformed/non-JSON entries are skipped (this mirrors
 * the scanner's own manifest-derivation posture — a broken manifest simply
 * contributes no policy, it does not crash the tool). One function per
 * manifest root (not a shared parameterized/looped helper), each with its
 * OWN uniquely-named local directory constant (`polyfillConnectorsManifestsDir`,
 * not a shared `dir` — the zero-connector-knowledge scanner's bounded
 * resolver treats a name bound to more than one syntactically distinct
 * initializer ANYWHERE in the file as ambiguous and drops it, so two
 * same-named `const dir = ...` in sibling functions would make BOTH
 * unresolvable even though each is independently a compile-time-fixed
 * sanctioned root) so the resolver can statically prove this function's own
 * `readFileSync` call resolves inside the sanctioned manifest root —
 * matching `scripts/generate-connector-registry.ts`'s own
 * `readReferenceManifests` shape. */
function readPolyfillConnectorsManifests(): ManifestLike[] {
  const polyfillConnectorsManifestsDir = resolve(repoRoot, "packages/polyfill-connectors/manifests");
  const out: ManifestLike[] = [];
  let files: string[];
  try {
    files = readdirSync(polyfillConnectorsManifestsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const file of files) {
    try {
      out.push(JSON.parse(readFileSync(resolve(polyfillConnectorsManifestsDir, file), "utf8")));
    } catch {
      // Skip: not this tool's job to validate manifest well-formedness.
    }
  }
  return out;
}

/** Every `*.json` manifest directly under `reference-implementation/
 * fixtures/seed-manifests/`, parsed. Same posture as {@link readPolyfillConnectorsManifests}. */
function readReferenceImplementationManifests(): ManifestLike[] {
  const referenceImplementationManifestsDir = resolve(riRoot, "fixtures", "seed-manifests");
  const out: ManifestLike[] = [];
  let files: string[];
  try {
    files = readdirSync(referenceImplementationManifestsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const file of files) {
    try {
      out.push(JSON.parse(readFileSync(resolve(referenceImplementationManifestsDir, file), "utf8")));
    } catch {
      // Skip: not this tool's job to validate manifest well-formedness.
    }
  }
  return out;
}

/** Every shipped manifest across both roots, parsed. */
function readAllManifests(): ManifestLike[] {
  return [...readPolyfillConnectorsManifests(), ...readReferenceImplementationManifests()];
}

/** Build a `CompactionPolicy` from one manifest's connector key and one of
 * its streams' `compaction_fingerprint` declaration — generic across every
 * connector, no connector-name branch. `local-device:<key>` is included
 * alongside the bare key so multi-device local-collector deployments
 * (mechanical id-prefix handling, not connector knowledge) resolve to the
 * same policy as the single-device form. */
function buildPolicyFromManifestStream(
  connectorKey: string,
  streamName: string,
  declaration: CompactionFingerprintDeclaration
): CompactionPolicy {
  const policy: CompactionPolicy = {
    connectorIds: [connectorKey, `${REGISTRY_ID_PREFIX}${connectorKey}`, `local-device:${connectorKey}`],
    connectorSource: `manifest-declared compaction_fingerprint (${connectorKey}/${streamName})`,
    excludeKeys: [...declaration.exclude_keys],
    stream: streamName,
  };
  if (declaration.change_model) {
    policy.changeModel = declaration.change_model;
  }
  if (declaration.representative_policy) {
    policy.representativePolicy = declaration.representative_policy;
  }
  const contentGate = declaration.content_gate;
  if (contentGate) {
    policy.resolveExcludeKeys = (record: Record<string, unknown>) => {
      const hasAllPresenceFields = contentGate.presence_fields.every((field) => isPresentFieldValue(record[field]));
      return hasAllPresenceFields ? [...contentGate.gated_exclude_keys] : [...declaration.exclude_keys];
    };
  }
  return policy;
}

/** A `content_gate.presence_fields` entry is "present" when it is a
 * non-empty string, a positive number, or otherwise truthy. */
function isPresentFieldValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (typeof value === "number") {
    return value > 0;
  }
  return Boolean(value);
}

/** Every `CompactionPolicy`, derived generically from every shipped
 * manifest's streams — the complete, generic replacement for what used to
 * be a hand-maintained, connector-keyed literal array. */
function buildCompactionPoliciesFromManifests(): CompactionPolicy[] {
  const policies: CompactionPolicy[] = [];
  for (const manifest of readAllManifests()) {
    const connectorKey = connectorKeyFromManifest(manifest);
    if (!connectorKey) {
      continue;
    }
    for (const stream of manifest.streams ?? []) {
      const declaration = stream.compaction_fingerprint;
      if (!declaration || typeof stream.name !== "string") {
        continue;
      }
      policies.push(buildPolicyFromManifestStream(connectorKey, stream.name, declaration));
    }
  }
  return policies;
}

// ─── Shared types ───────────────────────────────────────────────────────

/** The per-stream fingerprint policy. See COMPACTION_POLICIES doc comment. */
export interface CompactionPolicy {
  changeModel?: "immutable_semantic";
  connectorIds: string[];
  connectorSource: string;
  excludeKeys: string[];
  representativePolicy?: "current";
  resolveExcludeKeys?: (record: Record<string, unknown>) => string[];
  stream: string;
}

/** A single `record_changes` history row as read by `planCompaction`. */
export interface HistoryRow {
  deleted: boolean;
  payload_bytes: string | number | null;
  record_json: unknown;
  version: number | string;
}

/** A single `records` current-row as read by `planCompaction`. */
export interface CurrentRow {
  connector_id: string;
  record_key: string;
  version: number | string;
}

export type CompactionMode = "audit" | "canonical";

/** A history row after fingerprint pre-computation, used by the retention selectors. */
interface EnrichedRow {
  deleted: boolean;
  fingerprint: string;
  version: number;
}

// ─── Policy registry ────────────────────────────────────────────────────

/**
 * A compaction policy declares the per-stream fingerprint definition the
 * connector uses to decide whether a freshly-emitted record is "the same
 * record" as its prior version. This script mirrors that definition
 * one-for-one so a "removable historical version" classification here
 * matches the connector's "no-op emit" classification.
 *
 * Every entry here is DERIVED from a manifest-declared `compaction_fingerprint`
 * field (see `buildCompactionPoliciesFromManifests` above) — this script
 * itself contains no connector-name branch and no hand-maintained,
 * connector-keyed literal. The connector's own manifest is the code-review
 * gate: adding or changing a `compaction_fingerprint` declaration goes
 * through the same manifest-review process as any other connector-authored
 * capability, and the manifest author is responsible for mirroring an
 * existing connector-side fingerprint helper (a manifest-declared
 * `exclude_keys` that does NOT match the connector's own fingerprint-cursor
 * exclusion would just mean this tool's "removable" disagrees with the
 * connector's "no-op emit", the same review burden that existed when this
 * was a hand-maintained RI-side list — the burden moved to the manifest
 * author, it did not disappear).
 *
 *   - `connectorIds`: every id form the policy applies to (bare key,
 *     registry-URL form, `local-device:` prefix) — mechanical string forms
 *     of the SAME connector, not additional connector knowledge.
 *   - `stream`: the stream name the policy applies to.
 *   - `excludeKeys`: payload keys excluded from the fingerprint, taken
 *     directly from the manifest's `compaction_fingerprint.exclude_keys`.
 *   - `resolveExcludeKeys` (optional): built generically from the manifest's
 *     `compaction_fingerprint.content_gate` when present — a per-record
 *     function that switches between `content_gate.gated_exclude_keys` (all
 *     `presence_fields` are truthy/non-empty) and the base `excludeKeys`
 *     (fallback). The GATING MECHANISM is RI-owned generic code (this
 *     function); WHICH fields gate and WHICH fields get excluded is the
 *     manifest-declared fact.
 *   - `connectorSource`: now a generic "manifest-declared" label (the
 *     connector's own manifest IS the source of truth; no RI-authored
 *     per-entry documentation string to keep in sync).
 *   - `changeModel`/`representativePolicy` (optional): taken directly from
 *     the manifest's `compaction_fingerprint.change_model`/
 *     `representative_policy`. Only `'immutable_semantic'`/`'current'`
 *     (respectively) opt a stream into canonical mode; absent means
 *     audit-only, same semantics as before this redesign.
 *
 * Canonical mode (mode === 'canonical') is legal ONLY for a policy with both
 * `changeModel: 'immutable_semantic'` and `representativePolicy: 'current'`.
 * Any other policy fails closed (see `assertCanonicalEligible`). Default mode
 * is `'audit'`, which ignores both fields and keeps its existing conservative
 * retention for every policy.
 */
export const COMPACTION_POLICIES: CompactionPolicy[] = buildCompactionPoliciesFromManifests();

export function findPolicy(connectorId: string, stream: string): CompactionPolicy | null {
  return COMPACTION_POLICIES.find((p) => p.connectorIds.includes(connectorId) && p.stream === stream) || null;
}

export function describePolicies(): string {
  return COMPACTION_POLICIES.map(
    (p) =>
      `  - ${p.connectorIds[0]}/${p.stream}${p.excludeKeys.length ? ` (excludes ${p.excludeKeys.join(",")})` : ""}${isCanonicalEligible(p) ? " [canonical-eligible]" : ""}`
  ).join("\n");
}

// ─── Canonical-mode eligibility ─────────────────────────────────────────

/** The only supported values for the canonical-mode policy fields. A policy
 *  is canonical-eligible iff it declares BOTH, exactly. */
export const CANONICAL_CHANGE_MODEL = "immutable_semantic";
export const CANONICAL_REPRESENTATIVE_POLICY = "current";

/** The two compaction modes. `audit` is the default and keeps the existing
 *  conservative retention; `canonical` lowers the same-fingerprint floor to one
 *  survivor per semantic run and is gated by `isCanonicalEligible`. */
export const COMPACTION_MODES: CompactionMode[] = ["audit", "canonical"];

/**
 * Parse `--mode`. Returns `'audit'` when unset (the default), the validated
 * mode string when it is one of COMPACTION_MODES, or the sentinel string
 * `'invalid'` when present but not a recognized mode. The CLI rejects
 * `'invalid'` early.
 */
export function parseMode(raw: string | boolean | undefined): CompactionMode | "invalid" {
  // biome-ignore lint/suspicious/noEqualsToNull: deliberate loose match -- `raw` is `string | boolean | undefined`, and `== null` intentionally catches both `undefined` (unset) and `null`; `=== null` alone would let an unset `raw` fall through to the boolean/string checks below.
  if (raw == null || raw === "") {
    return "audit";
  }
  if (typeof raw === "boolean") {
    return "invalid";
  }
  const matched = COMPACTION_MODES.find((m) => m === raw);
  return matched ?? "invalid";
}

/**
 * Whether a policy opts into canonical mode. True ONLY when the policy declares
 * BOTH `changeModel: 'immutable_semantic'` and `representativePolicy: 'current'`.
 * A missing or any-other value fails closed (returns false). Pure.
 */
export function isCanonicalEligible(policy: CompactionPolicy | null | undefined): boolean {
  return (
    !!policy &&
    policy.changeModel === CANONICAL_CHANGE_MODEL &&
    policy.representativePolicy === CANONICAL_REPRESENTATIVE_POLICY
  );
}

/** List the canonical-eligible policies for operator error messages. */
export function describeCanonicalEligible(): string {
  const eligible = COMPACTION_POLICIES.filter(isCanonicalEligible);
  if (!eligible.length) {
    return "  (none)";
  }
  return eligible.map((p) => `  - ${p.connectorIds[0]}/${p.stream}`).join("\n");
}

/**
 * Fail-closed gate for a canonical apply/plan. Throws a descriptive Error when
 * the policy is not canonical-eligible so the caller refuses the canonical run
 * instead of deleting retained versions. No-op when eligible.
 */
export function assertCanonicalEligible(
  policy: CompactionPolicy | null | undefined,
  connectorId: string | null,
  stream: string
): void {
  if (isCanonicalEligible(policy)) {
    return;
  }
  const have = policy
    ? `changeModel=${JSON.stringify(policy.changeModel ?? null)}, representativePolicy=${JSON.stringify(policy.representativePolicy ?? null)}`
    : "no registered policy";
  throw new Error(
    `canonical mode refused for connector_id="${connectorId}" stream="${stream}": ` +
      `canonical compaction requires changeModel="${CANONICAL_CHANGE_MODEL}" and ` +
      `representativePolicy="${CANONICAL_REPRESENTATIVE_POLICY}" (have: ${have}). ` +
      "Run without --mode=canonical to use conservative audit-mode retention."
  );
}

// ─── Fingerprint helper ─────────────────────────────────────────────────

/**
 * Stable per-record fingerprint. Byte-for-byte parity with
 * `packages/polyfill-connectors/src/fingerprint-cursor.ts:recordFingerprint`
 * — the canonical authoring-layer helper Slack/Gmail/Codex/YNAB cursors
 * call when deciding whether a freshly-derived record is a no-op emit.
 *
 * Parity matters: this script's "removable historical version"
 * classification must equal the connector's "no-op emit" classification
 * for the same payload. The parity is asserted by
 * `reference-implementation/test/compact-record-history-fingerprint-parity.test.js`,
 * which compares this implementation against the shared helper across
 * representative fixtures for every registered policy. Drift between
 * the two implementations fails that test loudly.
 *
 * Reimplemented here (instead of imported) because this is a Node `.mjs`
 * operational tool and the canonical helper is TypeScript inside a
 * different workspace package — importing it would couple this tool to
 * either a build artifact or a runtime TS shim. The parity test is the
 * substitute for the import.
 *
 * `excludeKeys` are removed at every level the stringifier visits, so
 * adding a future policy that excludes a key appearing at nested levels
 * (e.g. a `fetched_at` shoved into a nested envelope) is consistent
 * with the canonical helper's semantics.
 */
export function recordFingerprint(record: unknown, excludeKeys: string[] = []): string {
  const exclude = new Set(excludeKeys);
  const canonical = stableStringify(record, exclude);
  return createHash("sha1").update(canonical).digest("hex");
}

/** Ordinal (non-locale) ascending string comparator, matching `Array.prototype.sort`'s
 *  default `<`/`>` behavior. Extracted so the caller's sort avoids a nested ternary. */
function compareKeysOrdinal(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function stableStringify(value: unknown, exclude: Set<string>): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v, exclude)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([k]) => !exclude.has(k))
    .sort(([a], [b]) => compareKeysOrdinal(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v, exclude)}`).join(",")}}`;
}

// ─── Retention selector ─────────────────────────────────────────────────

/**
 * Decide which `record_changes` versions are safe to remove.
 *
 * `rows` is an array of `{ version, record_json, deleted }` sorted by
 * `version` ascending. `currentVersion` is the version of the same key
 * in `records`. `policy` provides `excludeKeys`. `mode` is `'audit'`
 * (the default) or `'canonical'`.
 *
 * AUDIT mode (default — design.md §Retention rule, unchanged):
 *
 *   - never remove `currentVersion`;
 *   - never remove a tombstone (`deleted = true`);
 *   - never remove the first version for the key;
 *   - never remove the most recent prior version whose fingerprint
 *     differs from the current row's fingerprint;
 *   - a tombstone bounds compaction — a non-tombstone whose
 *     immediately-prior surviving row is a tombstone is retained even
 *     if a same-fingerprint non-tombstone exists further back;
 *   - otherwise remove a non-tombstone whose immediately-prior
 *     surviving row is a non-tombstone with the same fingerprint.
 *
 * CANONICAL mode (canonicalize-retained-record-history — opt-in, eligible
 * policies only; the caller MUST have already passed `assertCanonicalEligible`):
 *
 *   - keep exactly ONE survivor per maximal same-fingerprint run, where a run
 *     is bounded by a tombstone or by a fingerprint change;
 *   - the survivor for the run that contains `currentVersion` is the current
 *     row itself (authoritative-current-wins); for every other run the survivor
 *     is that run's first (lowest-version) row, which preserves the distinct
 *     canonical fingerprint boundary;
 *   - never remove `currentVersion`;
 *   - never remove a tombstone;
 *   - the resurrection boundary — the first non-tombstone immediately after a
 *     tombstone — is a HARD survivor (pinned even when it shares the current
 *     run's fingerprint and the current row is later in that run), so a
 *     tombstone→resurrection transition is never collapsed away;
 *   - surviving versions are never renumbered.
 *
 * The canonical floor is strictly lower than audit's: audit additionally pins
 * the key's first row and the most-recent-differing-prior even when they share
 * the current fingerprint, so an immutable same-fingerprint key keeps {first,
 * current} under audit but {current} under canonical.
 *
 * Returns an array of versions (numbers) that may be removed.
 */
/**
 * Pre-compute the per-row fingerprint (or the tombstone sentinel for a
 * deleted row) for every history row, using the policy's static
 * `excludeKeys` or its per-record `resolveExcludeKeys`, whichever the
 * policy declares. Pure — extracted from `selectRemovableVersions` to
 * keep that function's cognitive complexity under the Biome ceiling;
 * behavior is unchanged.
 */
function enrichRowsWithFingerprints(rows: HistoryRow[], policy: CompactionPolicy): EnrichedRow[] {
  const { excludeKeys: staticExcludeKeys, resolveExcludeKeys } = policy;
  return rows.map((r) => ({
    deleted: !!r.deleted,
    fingerprint: r.deleted
      ? TOMBSTONE_FP
      : recordFingerprint(
          r.record_json || {},
          resolveExcludeKeys ? resolveExcludeKeys((r.record_json as Record<string, unknown>) || {}) : staticExcludeKeys
        ),
    version: Number(r.version),
  }));
}

/**
 * Find "the most recent prior row whose fingerprint differs from the
 * current row's fingerprint" in an ascending-sorted `enriched` array —
 * audit mode's hard pin in addition to the current row itself. Returns
 * `null` when the current row is absent (nothing to anchor against).
 * Pure — extracted from `selectRemovableVersions` for the same reason as
 * `enrichRowsWithFingerprints`.
 */
function findMostRecentDifferingPrior(enriched: EnrichedRow[], currentRow: EnrichedRow | undefined): number | null {
  if (!currentRow) {
    return null;
  }
  const currentFingerprint = currentRow.fingerprint;
  for (let i = enriched.length - 1; i >= 0; i -= 1) {
    const r = enriched[i];
    if (r === undefined) {
      continue;
    }
    if (r.version >= currentRow.version) {
      continue;
    }
    if (r.fingerprint !== currentFingerprint) {
      return r.version;
    }
  }
  return null;
}

/**
 * Audit-mode selector (the default, unchanged retention rule — see the
 * `selectRemovableVersions` doc comment above). `enriched` is sorted
 * ascending. Pure — extracted from `selectRemovableVersions` for the same
 * reason as `enrichRowsWithFingerprints`.
 */
function selectRemovableVersionsAudit(
  enriched: EnrichedRow[],
  currentVersion: number,
  mostRecentDifferingPrior: number | null
): number[] {
  const removable: number[] = [];

  // Walk ascending. `prevSurviving` is the prior row that survives — the
  // last one we did not mark removable. A tombstone is always a
  // surviving row.
  let prevSurviving: EnrichedRow | null = null;
  for (let i = 0; i < enriched.length; i += 1) {
    const row = enriched[i];
    if (row === undefined) {
      continue;
    }

    // Hard pins: first row, current row, tombstone, most-recent-differing-prior.
    if (i === 0) {
      prevSurviving = row;
      continue;
    }
    if (row.version === currentVersion) {
      prevSurviving = row;
      continue;
    }
    if (row.deleted) {
      prevSurviving = row;
      continue;
    }
    if (row.version === mostRecentDifferingPrior) {
      prevSurviving = row;
      continue;
    }

    // Tombstones bound compaction — if the immediate predecessor is a
    // tombstone, this row marks a real resurrection and must be retained.
    if (prevSurviving?.deleted) {
      prevSurviving = row;
      continue;
    }

    // Same-fingerprint adjacent non-tombstone: removable.
    if (prevSurviving && prevSurviving.fingerprint === row.fingerprint) {
      removable.push(row.version);
      // prevSurviving does not change — the surviving anchor stays.
      continue;
    }

    // Otherwise, retain.
    prevSurviving = row;
  }

  return removable;
}

export function selectRemovableVersions(
  rows: HistoryRow[],
  currentVersion: number | string,
  policy: CompactionPolicy,
  mode: CompactionMode = "audit"
): number[] {
  if (!rows.length) {
    return [];
  }

  // Pre-compute fingerprints once per row.
  const enriched = enrichRowsWithFingerprints(rows, policy);
  const currentVersionNumber = Number(currentVersion);

  if (mode === "canonical") {
    return selectRemovableVersionsCanonical(enriched, currentVersionNumber);
  }

  // Locate the current row's fingerprint (if present); used to retain the
  // most recent prior version with a different fingerprint.
  const currentRow = enriched.find((r) => r.version === currentVersionNumber);
  const mostRecentDifferingPrior = findMostRecentDifferingPrior(enriched, currentRow);

  return selectRemovableVersionsAudit(enriched, currentVersionNumber, mostRecentDifferingPrior);
}

/**
 * Canonical-mode selector. `enriched` is the per-row `{version, deleted,
 * fingerprint}` array sorted ascending (tombstones carry TOMBSTONE_FP).
 * `currentVersion` is the `records.version` for the key.
 *
 * Keeps one survivor per maximal same-fingerprint run (a run is broken by a
 * fingerprint change OR a tombstone). The survivor is the current row when the
 * current row is in the run; otherwise the run's first row — so every distinct
 * fingerprint boundary, every tombstone, and every resurrection boundary
 * survives, while redundant same-fingerprint duplicates (including the key's
 * first row when it shares the current run's fingerprint) are removed.
 *
 * The first non-tombstone immediately after a tombstone is additionally pinned
 * as a HARD survivor (it can never be displaced by a later current row in the
 * same run), so a tombstone→resurrection transition is preserved exactly.
 */
function selectRemovableVersionsCanonical(enriched: EnrichedRow[], currentVersion: number): number[] {
  const removable: number[] = [];

  let runFingerprint: string | null = null; // fingerprint of the run currently open
  let runSurvivor: number | null = null; // the version chosen to survive the open run
  let runHasCurrent = false; // whether the open run contains the current row
  let runSurvivorPinned = false; // survivor is a hard pin (resurrection boundary)
  let afterTombstone = false; // the next non-tombstone is a resurrection boundary

  for (const row of enriched) {
    // A tombstone is its own boundary: it always survives and closes any open
    // run. The next non-tombstone is the resurrection boundary and starts a
    // fresh, hard-pinned run, so it can never be collapsed into a survivor.
    if (row.deleted) {
      runFingerprint = null;
      runSurvivor = null;
      runHasCurrent = false;
      runSurvivorPinned = false;
      afterTombstone = true;
      continue;
    }

    const isCurrent = row.version === currentVersion;

    // New run: different fingerprint from the open run (or no open run, e.g.
    // the first row or the row right after a tombstone). This row is the run's
    // boundary survivor by default. A run that opens right after a tombstone is
    // a resurrection boundary and is pinned (never displaced by a later
    // current row in the same run).
    if (runSurvivor === null || row.fingerprint !== runFingerprint) {
      runFingerprint = row.fingerprint;
      runSurvivor = row.version;
      runHasCurrent = isCurrent;
      runSurvivorPinned = afterTombstone;
      afterTombstone = false;
      continue;
    }

    // Continuation of the same-fingerprint run. One of {prior survivor, this
    // row} must be removed so the run keeps exactly one survivor, UNLESS the
    // run's survivor is a pinned resurrection boundary — then both the boundary
    // and the current row survive and only the in-between duplicates drop.
    if (isCurrent) {
      if (runSurvivorPinned) {
        // The resurrection boundary stays pinned; the current row also survives
        // (it is never removable). Nothing to push.
        runHasCurrent = true;
      } else {
        // Current wins the run: drop the previously-chosen survivor, keep current.
        if (!runHasCurrent) {
          removable.push(runSurvivor);
        }
        runSurvivor = row.version;
        runHasCurrent = true;
      }
    } else {
      // Redundant duplicate within the run: remove it, keep the existing
      // survivor (the run's first row / pinned boundary, or the current row if
      // already seen — current is never displaced).
      removable.push(row.version);
    }
  }

  return removable;
}

const TOMBSTONE_FP = "__tombstone__";

// ─── Argv parsing ───────────────────────────────────────────────────────

/**
 * Parse `--limit-keys`. Returns `null` if unset, a positive integer if
 * valid, or the sentinel string `'invalid'` if the value is present but
 * not a positive integer. The CLI rejects `'invalid'` early.
 */
/** The return type of `parseLimitKeys`: a validated positive integer, `null` when
 *  unset, or the sentinel string `'invalid'` when present but not a positive integer. */
export type ParseLimitKeysResult = number | null | "invalid";

export function parseLimitKeys(raw: string | boolean | undefined): ParseLimitKeysResult {
  // biome-ignore lint/suspicious/noEqualsToNull: deliberate loose match -- `raw` is `string | boolean | undefined`, and `== null` intentionally catches both `undefined` (unset) and `null`; `=== null` alone would let an unset `raw` fall through to the boolean/number checks below.
  if (raw == null || raw === "") {
    return null;
  }
  if (typeof raw === "boolean") {
    return "invalid";
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return "invalid";
  }
  return n;
}

type ParsedArgValue = string | boolean;

function parseArgs(argv: string[]): Record<string, ParsedArgValue> {
  const out: Record<string, ParsedArgValue> = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

// ─── Compaction loop ────────────────────────────────────────────────────

export interface PlanCompactionInput {
  connectorInstanceId: string;
  limitKeys: number | null;
  mode?: CompactionMode;
  policy: CompactionPolicy;
  pool: pg.Pool;
  stream: string;
}

export interface CompactionPlan {
  connectorIdsSeen: string[];
  connectorInstanceId: string;
  estimatedRemovedBytes: number;
  mode: CompactionMode;
  removableByKey: Map<string, number[]>;
  removableVersions: number;
  retainedVersionsAfter: number;
  scannedKeys: number;
  scannedVersions: number;
  stream: string;
}

export async function planCompaction({
  pool,
  connectorInstanceId,
  stream,
  policy,
  limitKeys,
  mode = "audit",
}: PlanCompactionInput): Promise<CompactionPlan> {
  // Canonical mode is deny-by-default: refuse before any planning when the
  // policy is not explicitly eligible, so an ineligible stream can never have
  // its retained versions selected for canonical deletion.
  if (mode === "canonical") {
    assertCanonicalEligible(policy, policy.connectorIds[0] ?? null, stream);
  }

  // Fetch the current row versions (and connector_id, for consistency).
  const limitClause = limitKeys ? `LIMIT ${Number(limitKeys)}` : "";
  const current = await pool.query<CurrentRow>(
    `SELECT connector_id, record_key, version
       FROM records
      WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE
      ORDER BY record_key
      ${limitClause}`,
    [connectorInstanceId, stream]
  );

  let scannedKeys = 0;
  let scannedVersions = 0;
  const removableByKey = new Map<string, number[]>();
  let removedBytesEstimate = 0;
  const connectorIdsSeen = new Set<string>();

  for (const row of current.rows) {
    scannedKeys += 1;
    connectorIdsSeen.add(row.connector_id);
    // biome-ignore lint/performance/noAwaitInLoops: this is a type-authoring pass, not a refactor -- parallelizing per-key history reads with Promise.all would change the pool's concurrent-connection load and is an out-of-scope behavior change for this slice; preserved sequential exactly as the original .mjs read it.
    const history = await pool.query<HistoryRow>(
      `SELECT version, record_json, deleted, octet_length(record_json::text) AS payload_bytes
         FROM record_changes
        WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
        ORDER BY version ASC`,
      [connectorInstanceId, stream, row.record_key]
    );
    scannedVersions += history.rows.length;
    const removable = selectRemovableVersions(history.rows, row.version, policy, mode);
    if (removable.length) {
      removableByKey.set(row.record_key, removable);
      const removableSet = new Set(removable.map(Number));
      for (const h of history.rows) {
        if (removableSet.has(Number(h.version))) {
          removedBytesEstimate += Number(h.payload_bytes || 0);
        }
      }
    }
  }

  const removableVersions = Array.from(removableByKey.values()).reduce((n, arr) => n + arr.length, 0);

  return {
    connectorIdsSeen: Array.from(connectorIdsSeen),
    connectorInstanceId,
    estimatedRemovedBytes: removedBytesEstimate,
    mode,
    removableByKey,
    removableVersions,
    retainedVersionsAfter: scannedVersions - removableVersions,
    scannedKeys,
    scannedVersions,
    stream,
  };
}

export interface ApplyCompactionInput {
  plan: CompactionPlan;
  pool: pg.Pool;
  runId: string;
}

export interface ApplyCompactionResult {
  backupTable: string | null;
  deleted: number;
  inserted: number;
  runId: string;
}

export async function applyCompaction({ pool, plan, runId }: ApplyCompactionInput): Promise<ApplyCompactionResult> {
  if (!plan.removableVersions) {
    return { backupTable: null, deleted: 0, inserted: 0, runId };
  }

  const backupTable = `compact_record_history_backup_${runId}`;
  // Create backup table once per run, shared across (connector_instance_id, stream).
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(backupTable)} (
       connector_id TEXT NOT NULL,
       connector_instance_id TEXT NOT NULL,
       stream TEXT NOT NULL,
       record_key TEXT NOT NULL,
       version BIGINT NOT NULL,
       record_json JSONB,
       emitted_at TEXT NOT NULL,
       deleted BOOLEAN NOT NULL,
       deleted_at TEXT,
       compacted_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );

  const client = await pool.connect();
  let inserted = 0;
  let deleted = 0;
  try {
    await client.query("BEGIN");

    for (const [recordKey, versions] of plan.removableByKey) {
      const versionsAsNumbers = versions.map(Number);
      // biome-ignore lint/performance/noAwaitInLoops: every insert/delete pair in this loop shares ONE pg.PoolClient inside a single BEGIN/COMMIT transaction -- a pg client serializes queries on one connection regardless, and parallelizing here would not overlap I/O, only reorder statements inside the transaction non-deterministically.
      const insertRes = await client.query(
        `INSERT INTO ${quoteIdent(backupTable)}
           (connector_id, connector_instance_id, stream, record_key, version,
            record_json, emitted_at, deleted, deleted_at)
         SELECT connector_id, connector_instance_id, stream, record_key, version,
                record_json, emitted_at, deleted, deleted_at
           FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
            AND version = ANY($4::bigint[])`,
        [plan.connectorInstanceId, plan.stream, recordKey, versionsAsNumbers]
      );
      const deleteRes = await client.query(
        `DELETE FROM record_changes
           WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
             AND version = ANY($4::bigint[])`,
        [plan.connectorInstanceId, plan.stream, recordKey, versionsAsNumbers]
      );
      if (insertRes.rowCount !== versionsAsNumbers.length) {
        throw new Error(
          `backup insert count mismatch for ${plan.connectorInstanceId}/${plan.stream}/${recordKey}: expected ${versionsAsNumbers.length}, got ${insertRes.rowCount}`
        );
      }
      if (deleteRes.rowCount !== insertRes.rowCount) {
        throw new Error(
          `delete/backup mismatch for ${plan.connectorInstanceId}/${plan.stream}/${recordKey}: backed up ${insertRes.rowCount}, deleted ${deleteRes.rowCount}`
        );
      }
      inserted += insertRes.rowCount || 0;
      deleted += deleteRes.rowCount || 0;
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Best-effort rollback; the original error is what the caller needs.
    }
    throw err;
  } finally {
    client.release();
  }

  return { backupTable, deleted, inserted, runId };
}

/**
 * Mark the retained-size projection dirty for the scope. We deliberately
 * keep this in a separate post-commit step rather than inside the
 * compaction transaction so a dirty-marker failure can never roll back
 * a successful compaction.
 */
export interface MarkScopeDirtyInput {
  connectorInstanceId: string;
  pool: pg.Pool;
  stream: string;
}

export async function markScopeDirty({ pool, connectorInstanceId, stream }: MarkScopeDirtyInput): Promise<void> {
  try {
    await pool.query(
      `UPDATE retained_size_stream
          SET dirty = 1
        WHERE connector_instance_id = $1 AND stream = $2`,
      [connectorInstanceId, stream]
    );
    await pool.query(
      `UPDATE retained_size_connection
          SET dirty = 1
        WHERE connector_instance_id = $1`,
      [connectorInstanceId]
    );
    await pool.query("UPDATE retained_size_global SET dirty = 1");
  } catch {
    // Dirty marker failure is non-fatal — the projection will be marked
    // dirty by the next bulk write or the next rebuild will detect drift.
  }
}

// Quote an identifier (table/column) for safe interpolation. The backup
// table name is composed from a generated runId, but we still defend
// against any future caller passing user input.
function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// ─── CLI entry point ────────────────────────────────────────────────────

const invokedAsScript = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (invokedAsScript) {
  await runCli();
}

interface ValidatedCliArgs {
  apply: boolean;
  connectorInstanceId: string;
  databaseUrl: string;
  explicitConnectorId: string | null;
  limitKeys: number | null;
  mode: CompactionMode;
  stream: string;
}

/**
 * Parse argv + env into a validated args bundle, or `null` when validation
 * fails (having already printed the usage/error message to stderr). Pure
 * apart from reading `process.argv`/`process.env`, which the CLI boundary
 * always does — no DB I/O and no `process.exit` here, so `runCli` stays the
 * only place that decides the process exit code. Extracted from `runCli` to
 * keep that function's cognitive complexity under the Biome ceiling;
 * behavior (including exact messages) is unchanged.
 */
function parseAndValidateCliArgs(): ValidatedCliArgs | null {
  const args = parseArgs(process.argv.slice(2));
  const apply = !!args.apply;
  const connectorInstanceIdArg = args["connector-instance-id"];
  const streamArg = args.stream;
  const explicitConnectorIdArg = args["connector-id"];
  const limitKeys = parseLimitKeys(args["limit-keys"]);
  const mode = parseMode(args.mode);
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;

  const connectorInstanceId = typeof connectorInstanceIdArg === "string" ? connectorInstanceIdArg : null;
  const stream = typeof streamArg === "string" ? streamArg : null;
  const explicitConnectorId = typeof explicitConnectorIdArg === "string" ? explicitConnectorIdArg : null;

  if (!(connectorInstanceId && stream)) {
    console.error(
      "usage: compact-record-history --connector-instance-id=<id> --stream=<name> [--connector-id=<id>] [--mode=audit|canonical] [--limit-keys=N] [--apply]"
    );
    return null;
  }
  if (limitKeys === "invalid") {
    console.error("--limit-keys must be a positive integer");
    return null;
  }
  if (mode === "invalid") {
    console.error(`--mode must be one of: ${COMPACTION_MODES.join("|")} (default audit)`);
    return null;
  }
  if (!databaseUrl) {
    console.error(
      "PDPP_DATABASE_URL (or PDPP_TEST_POSTGRES_URL) is required — authorization is by direct database access"
    );
    return null;
  }

  return { apply, connectorInstanceId, databaseUrl, explicitConnectorId, limitKeys, mode, stream };
}

interface ResolveConnectorIdInput {
  connectorInstanceId: string;
  explicitConnectorId: string | null;
  pool: pg.Pool;
}

/**
 * Resolve the connector_id for the scope: the explicit `--connector-id` when
 * supplied, otherwise a lookup against `connector_instances`. Returns `null`
 * (having already printed the error) when neither is available. Extracted
 * from `runCli` for the same reason as `parseAndValidateCliArgs`.
 */
async function resolveConnectorId({
  pool,
  connectorInstanceId,
  explicitConnectorId,
}: ResolveConnectorIdInput): Promise<string | null> {
  if (explicitConnectorId) {
    return explicitConnectorId;
  }
  const r = await pool.query<{ connector_id: string }>(
    "SELECT connector_id FROM connector_instances WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  const [found] = r.rows;
  if (!found) {
    console.error(`connector_instance_id "${connectorInstanceId}" not found and --connector-id was not supplied`);
    return null;
  }
  return found.connector_id;
}

async function runCli(): Promise<void> {
  const validated = parseAndValidateCliArgs();
  if (!validated) {
    process.exit(2);
  }
  const { apply, connectorInstanceId, databaseUrl, explicitConnectorId, limitKeys, mode, stream } = validated;

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    const connectorId = await resolveConnectorId({ connectorInstanceId, explicitConnectorId, pool });
    if (!connectorId) {
      process.exit(2);
    }

    const policy = findPolicy(connectorId, stream);
    if (!policy) {
      console.error(
        `no compaction policy registered for connector_id="${connectorId}" stream="${stream}".\nRegistered policies:\n${describePolicies()}`
      );
      process.exit(2);
    }

    // Canonical mode is deny-by-default: refuse here (before opening any plan)
    // when the policy is not explicitly canonical-eligible. This is the
    // fail-closed gate the spec's "Ineligible stream fails closed" scenario
    // requires — an ineligible stream never reaches the destructive path.
    if (mode === "canonical" && !isCanonicalEligible(policy)) {
      console.error(
        `canonical mode refused for connector_id="${connectorId}" stream="${stream}": ` +
          `canonical compaction requires changeModel="${CANONICAL_CHANGE_MODEL}" and ` +
          `representativePolicy="${CANONICAL_REPRESENTATIVE_POLICY}".\n` +
          `Canonical-eligible streams:\n${describeCanonicalEligible()}\n` +
          "Run without --mode=canonical to use conservative audit-mode retention."
      );
      process.exit(2);
    }

    const plan = await planCompaction({
      connectorInstanceId,
      limitKeys,
      mode,
      policy,
      pool,
      stream,
    });

    printPlan({ apply, plan });

    if (apply && plan.removableVersions > 0) {
      const runId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const result = await applyCompaction({ plan, pool, runId });
      await markScopeDirty({
        connectorInstanceId,
        pool,
        stream,
      });
      console.log(
        `APPLIED [${mode} mode]: deleted ${result.deleted} row(s), backed up into "${result.backupTable}". retained_size_stream marked dirty for ${connectorInstanceId}/${stream}.`
      );
    } else if (apply) {
      console.log("APPLIED: nothing to delete.");
    }
  } catch (err) {
    console.error("compact-record-history failed:", err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}

interface PrintPlanInput {
  apply: boolean;
  plan: CompactionPlan;
}

function printPlan({ plan, apply }: PrintPlanInput): void {
  const action = apply ? "APPLY" : "DRY-RUN";
  console.log(`compact-record-history: ${action} [${plan.mode} mode] — ${plan.connectorInstanceId}/${plan.stream}`);
  console.log(`  connector_id(s) seen: ${plan.connectorIdsSeen.join(", ") || "(none)"}`);
  console.log(`  scannedKeys:           ${plan.scannedKeys}`);
  console.log(`  scannedVersions:       ${plan.scannedVersions}`);
  console.log(`  removableVersions:     ${plan.removableVersions}`);
  console.log(`  retainedVersionsAfter: ${plan.retainedVersionsAfter}`);
  console.log(`  estimatedRemovedBytes: ${plan.estimatedRemovedBytes}`);
}
