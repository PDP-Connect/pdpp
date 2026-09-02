// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the connection configuration view-model.
 *
 * The headline test is `no server call is made while editing and reviewing a
 * draft`: it installs a counting `globalThis.fetch` and drives the ENTIRE
 * pre-commit journey through the real exported functions, then asserts the
 * counter is still zero. That is not decoration. A pure-transport revision
 * SELF-ACTIVATES on propose (`connector-instance-config-store.ts`
 * `initialStatusFor`), so a preview that reached the API would apply a change
 * the owner never confirmed. The rest of the file pins the classification,
 * copy, and edge-state rules the owner-facing surface depends on.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCurrentSettings,
  buildDraft,
  buildHistory,
  buildProposalConfig,
  type ConfigOptionsSchemaWire,
  type ConfigOptionWire,
  type ConfigRevisionWire,
  type ConnectionConfigWire,
  classifyDraft,
  confirmationReason,
  describeCommit,
  diffDraft,
  findPendingProposal,
  optionLabel,
  originLabel,
  parseStaleConflict,
  reasonError,
  resolveAvailability,
  setDraftValue,
  statusLabel,
  unchangedCount,
  validateDraft,
} from "./connection-config-view-model.ts";

// ─── Top-level regex constants (biome useTopLevelRegex) ─────────────────────

const VM_NO_FETCH_RE = /\bfetch\s*\(/;
const VM_NO_ACTIONS_IMPORT_RE = /from "\.\/config-actions\.ts"/;
const VM_NO_CLIENT_IMPORT_RE = /connection-config-client/;
const VM_NO_IMPORT_RE = /^import /m;
const IMMEDIATE_EFFECT_RE = /take effect immediately/;
const CONFIRM_WORD_RE = /confirm/i;
const ENTIRE_CHANGE_RE = /entire change needs your confirmation/;
const NOT_CLASSIFIED_YET_RE = /has not been classified yet/;
const NOT_CLASSIFIED_SETTING_RE = /has not classified this setting yet/;
const WHAT_SOURCE_COLLECTS_RE = /what this source collects/;
const MIN_BOUND_RE = /1 or more/;
const MAX_BOUND_RE = /365 or less/;
const NOT_ALLOWED_CHOICE_RE = /not one of the allowed choices/;
const SAY_WHY_RE = /Say why/;
const NOT_AVAILABLE_YET_RE = /not available for this connector yet/;
const HAS_NO_OPTIONS_RE = /has no options/i;
const INVALID_SCHEMA_RE = /invalid/;
const PROPOSED_BY_DAISY_RE = /Proposed by daisy/;
const YOU_WORD_RE = /you/i;
const CHANGED_WHILE_EDITING_RE = /changed while you were editing/;
const STALE_JARGON_RE = /stale|epoch|rebase/i;

/** The validation message for one key, or "" when the draft was accepted. */
function errorFor(errors: Record<string, string>, key: string): string {
  const message = errors[key];
  return typeof message === "string" ? message : "";
}

// ─── Fixtures, shaped like the real Slack manifest ──────────────────────────

function option(partial: Partial<ConfigOptionWire> & { option_key: string }): ConfigOptionWire {
  return {
    default: false,
    description: "A knob.",
    enum: null,
    maximum: null,
    minimum: null,
    option_kind: "collection_scope",
    platform_classified: true,
    type: "boolean",
    ...partial,
  };
}

const LOOKBACK = option({
  default: 7,
  description: "How many days of message history to fetch per channel.",
  maximum: 365,
  minimum: 1,
  option_key: "LOOKBACK_DAYS",
  option_kind: "collection_scope",
  type: "integer",
});

const CHANNEL_TYPES = option({
  default: ["public", "private"],
  description: "Channel types to export.",
  enum: ["public", "private", "im", "mpim"],
  option_key: "CHANNEL_TYPES",
  option_kind: "collection_scope",
  type: "string_array",
});

const SKIP_FILES = option({
  default: true,
  description: "Skip file attachment metadata.",
  option_key: "SKIP_FILES",
  option_kind: "transport",
  type: "boolean",
});

const RECLAIM_UPLOADS = option({
  default: false,
  description: "Reclaim previously-failed uploads on retry.",
  option_key: "RECLAIM_UPLOADS",
  option_kind: "transport",
  type: "boolean",
});

/** An option the platform registry has never heard of: fails closed. */
const UNCLASSIFIED = option({
  default: "",
  description: "Something nobody has classified.",
  option_key: "MYSTERY_KNOB",
  option_kind: "collection_scope",
  platform_classified: false,
  type: "string",
});

function schema(
  options: readonly ConfigOptionWire[] = [LOOKBACK, CHANNEL_TYPES, SKIP_FILES, RECLAIM_UPLOADS]
): ConfigOptionsSchemaWire {
  return { connector_key: "slack", description: "Slack tuning.", options };
}

function revision(partial: Partial<ConfigRevisionWire> = {}): ConfigRevisionWire {
  return {
    collection_boundary_fingerprint: null,
    config: {},
    config_contract_id: "pdpp.connector_config.v1",
    config_contract_version: 1,
    confirmed_at: null,
    confirmed_by: null,
    connection_id: "conn_1",
    is_explicit: true,
    option_kind: "collection_scope",
    origin: "owner",
    revision: 1,
    set_at: "2026-08-23T14:00:00.000Z",
    set_by: "owner",
    source_of_change: "Initial workspace setup",
    status: "active",
    ...partial,
  };
}

function config(partial: Partial<ConnectionConfigWire> = {}): ConnectionConfigWire {
  return {
    active_revision: null,
    base_epoch: 1,
    base_revision: 0,
    connection_id: "conn_1",
    connector_key: "slack",
    options_schema: schema(),
    options_schema_status: "declared",
    ...partial,
  };
}

// ─── The invariant this whole feature exists to have ────────────────────────

test("no server call is made while editing and reviewing a draft", () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  try {
    const active = revision({ config: { LOOKBACK_DAYS: 7 }, revision: 7 });
    const live = config({ active_revision: active, base_revision: 7 });
    const model = live.options_schema as ConfigOptionsSchemaWire;

    // Step 0: read the current settings.
    const rows = buildCurrentSettings(model, active);
    assert.equal(rows.length, 4);

    // Step 1: edit a local draft, across every control type.
    let draft = buildDraft(model, active);
    draft = setDraftValue(draft, "LOOKBACK_DAYS", 30);
    draft = setDraftValue(draft, "CHANNEL_TYPES", ["public"]);
    draft = setDraftValue(draft, "SKIP_FILES", false);

    // Step 2: review. Diff, validate, classify, and describe the commit.
    const changes = diffDraft(model, active, draft);
    assert.equal(changes.length, 3);
    assert.deepEqual(validateDraft(model, draft), {});
    assert.equal(classifyDraft(changes), "collection_scope");
    const commit = describeCommit(changes);
    assert.equal(commit.buttonLabel, "Create proposal");
    assert.equal(unchangedCount(model, changes), 1);
    buildProposalConfig(changes);
    reasonError("");
    resolveAvailability(live);
    buildHistory([active], model, 7);

    // Nothing above may touch the network. A single call here means a preview
    // could have self-activated a transport revision.
    assert.equal(calls, 0, "the draft and review steps must not issue any request");
  } finally {
    globalThis.fetch = original;
  }
});

test("the view-model module imports no client, action, or fetch helper", async () => {
  // The zero-fetch test proves the current code path is clean; this proves the
  // module has no seam through which a future edit could quietly add one.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const here = fileURLToPath(new URL(".", import.meta.url));
  const src = await readFile(`${here}connection-config-view-model.ts`, "utf8");
  assert.doesNotMatch(src, VM_NO_FETCH_RE);
  assert.doesNotMatch(src, VM_NO_ACTIONS_IMPORT_RE);
  assert.doesNotMatch(src, VM_NO_CLIENT_IMPORT_RE);
  assert.doesNotMatch(src, VM_NO_IMPORT_RE);
});

// ─── Transport vs collection-scope commit paths ─────────────────────────────

test("a transport-only bundle applies immediately and says so", () => {
  const model = schema();
  const draft = setDraftValue(buildDraft(model, null), "SKIP_FILES", false);
  const changes = diffDraft(model, null, draft);
  const commit = describeCommit(changes);
  assert.equal(classifyDraft(changes), "transport");
  assert.equal(commit.buttonLabel, "Apply changes");
  assert.equal(commit.expectedStatus, "active");
  assert.match(commit.supportingText, IMMEDIATE_EFFECT_RE);
  assert.doesNotMatch(commit.supportingText, CONFIRM_WORD_RE);
});

test("any collection-scope field makes the whole bundle need confirmation", () => {
  const model = schema();
  let draft = buildDraft(model, null);
  draft = setDraftValue(draft, "SKIP_FILES", false);
  draft = setDraftValue(draft, "LOOKBACK_DAYS", 30);
  const changes = diffDraft(model, null, draft);
  const commit = describeCommit(changes);
  assert.equal(classifyDraft(changes), "collection_scope");
  assert.equal(commit.buttonLabel, "Create proposal");
  assert.equal(commit.expectedStatus, "proposed");
  assert.equal(commit.bundlesTransportWithScope, true);
  assert.match(commit.supportingText, ENTIRE_CHANGE_RE);
});

test("an unclassified field is treated as collection scope, not as transport", () => {
  const model = schema([SKIP_FILES, UNCLASSIFIED]);
  const draft = setDraftValue(buildDraft(model, null), "MYSTERY_KNOB", "x");
  const changes = diffDraft(model, null, draft);
  assert.equal(classifyDraft(changes), "collection_scope");
  const commit = describeCommit(changes);
  assert.equal(commit.hasUnclassified, true);
  assert.match(commit.supportingText, NOT_CLASSIFIED_YET_RE);
  assert.match(confirmationReason(UNCLASSIFIED) ?? "", NOT_CLASSIFIED_SETTING_RE);
});

test("an empty change set never classifies as transport", () => {
  // Mirrors the store: an empty bundle is collection_scope, never self-activating.
  assert.equal(classifyDraft([]), "collection_scope");
});

test("a transport option carries no per-field confirmation warning", () => {
  assert.equal(confirmationReason(SKIP_FILES), null);
  assert.match(confirmationReason(LOOKBACK) ?? "", WHAT_SOURCE_COLLECTS_RE);
});

// ─── Defaults are not owner choices ─────────────────────────────────────────

test("with no active revision every value reads as a connector default", () => {
  const rows = buildCurrentSettings(schema(), null);
  for (const row of rows) {
    assert.equal(row.provenance, "connector_default");
    assert.equal(row.provenanceLabel, "Connector default");
  }
});

test("an owner-set value is attributed to the owner, and untouched keys are not", () => {
  const active = revision({ config: { LOOKBACK_DAYS: 30 } });
  const rows = buildCurrentSettings(schema(), active);
  const lookback = rows.find((row) => row.optionKey === "LOOKBACK_DAYS");
  const skip = rows.find((row) => row.optionKey === "SKIP_FILES");
  assert.equal(lookback?.provenance, "owner_set");
  assert.equal(lookback?.value, 30);
  assert.equal(skip?.provenance, "connector_default");
});

test("a stored value of the wrong type falls back to the default instead of rendering junk", () => {
  const active = revision({ config: { LOOKBACK_DAYS: "not a number" } });
  const rows = buildCurrentSettings(schema(), active);
  const lookback = rows.find((row) => row.optionKey === "LOOKBACK_DAYS");
  assert.equal(lookback?.value, 7);
  assert.equal(lookback?.provenance, "connector_default");
});

// ─── Diff ───────────────────────────────────────────────────────────────────

test("an untouched draft reports no changes", () => {
  const model = schema();
  assert.deepEqual(diffDraft(model, null, buildDraft(model, null)), []);
});

test("a re-ordered array is a real change but an identical one is not", () => {
  const model = schema([CHANNEL_TYPES]);
  const same = setDraftValue(buildDraft(model, null), "CHANNEL_TYPES", ["public", "private"]);
  assert.equal(diffDraft(model, null, same).length, 0);
  const reordered = setDraftValue(buildDraft(model, null), "CHANNEL_TYPES", ["private", "public"]);
  assert.equal(diffDraft(model, null, reordered).length, 1);
});

test("the proposed bundle carries only the changed keys", () => {
  const model = schema();
  const draft = setDraftValue(buildDraft(model, null), "SKIP_FILES", false);
  assert.deepEqual(buildProposalConfig(diffDraft(model, null, draft)), { SKIP_FILES: false });
});

test("a change renders current and proposed as owner-readable words", () => {
  const model = schema([SKIP_FILES]);
  const draft = setDraftValue(buildDraft(model, null), "SKIP_FILES", false);
  const [change] = diffDraft(model, null, draft);
  assert.equal(change?.currentLabel, "On");
  assert.equal(change?.proposedLabel, "Off");
  assert.equal(change?.label, "Skip files");
});

test("an empty selection says so rather than rendering an empty list", () => {
  const model = schema([CHANNEL_TYPES]);
  const draft = setDraftValue(buildDraft(model, null), "CHANNEL_TYPES", []);
  const [change] = diffDraft(model, null, draft);
  assert.equal(change?.proposedLabel, "None selected");
});

// ─── Validation ─────────────────────────────────────────────────────────────

test("a value outside the declared bounds is rejected locally", () => {
  const model = schema([LOOKBACK]);
  assert.match(errorFor(validateDraft(model, { LOOKBACK_DAYS: 0 }), "LOOKBACK_DAYS"), MIN_BOUND_RE);
  assert.match(errorFor(validateDraft(model, { LOOKBACK_DAYS: 400 }), "LOOKBACK_DAYS"), MAX_BOUND_RE);
  assert.deepEqual(validateDraft(model, { LOOKBACK_DAYS: 30 }), {});
});

test("a value outside the declared choices is rejected locally", () => {
  const model = schema([CHANNEL_TYPES]);
  assert.match(errorFor(validateDraft(model, { CHANNEL_TYPES: ["nope"] }), "CHANNEL_TYPES"), NOT_ALLOWED_CHOICE_RE);
});

test("the reason is required, because it becomes the durable record", () => {
  assert.match(reasonError("") ?? "", SAY_WHY_RE);
  assert.match(reasonError("   ") ?? "", SAY_WHY_RE);
  assert.equal(reasonError("Include the launch period"), null);
});

// ─── Schema availability: not_declared vs declared-but-empty ────────────────

test("an undeclared schema says settings are not available yet, never that there are none", () => {
  const availability = resolveAvailability(config({ options_schema: null, options_schema_status: "not_declared" }));
  assert.equal(availability.kind, "not_declared");
  const message = "message" in availability ? availability.message : "";
  assert.match(message, NOT_AVAILABLE_YET_RE);
  assert.doesNotMatch(message, HAS_NO_OPTIONS_RE);
});

test("a declared but empty schema is a different, real claim", () => {
  const availability = resolveAvailability(config({ options_schema: schema([]), options_schema_status: "declared" }));
  assert.equal(availability.kind, "empty");
});

test("a malformed schema reports an authoring defect, not an empty form", () => {
  const availability = resolveAvailability(config({ options_schema: null, options_schema_status: "unreadable" }));
  assert.equal(availability.kind, "unreadable");
  const message = "message" in availability ? availability.message : "";
  assert.match(message, INVALID_SCHEMA_RE);
});

test("a declared schema with options is editable", () => {
  assert.equal(resolveAvailability(config()).kind, "editable");
});

// ─── Pending proposal, history, attribution ─────────────────────────────────

test("the newest proposed revision is the pending one", () => {
  const pending = findPendingProposal([
    revision({ revision: 1, status: "superseded" }),
    revision({ revision: 2, status: "proposed" }),
    revision({ revision: 3, status: "proposed" }),
  ]);
  assert.equal(pending?.revision, 3);
});

test("no proposal pending when everything is settled", () => {
  assert.equal(findPendingProposal([revision({ status: "active" })]), null);
});

test("status and origin read as owner language, never as raw enum values", () => {
  assert.equal(statusLabel("active", true), "Current");
  assert.equal(statusLabel("active", false), "Was active");
  assert.equal(statusLabel("proposed", false), "Awaiting confirmation");
  assert.equal(statusLabel("superseded", false), "Replaced by a newer revision");
  assert.equal(statusLabel("quarantined", false), "Blocked; not used by syncs");
  assert.equal(originLabel("owner", "owner"), "Changed by you");
  assert.equal(originLabel("default", "system"), "Connector default");
  assert.equal(originLabel("migration", "script"), "Carried over during upgrade");
});

// Hoisted per lint/performance/useTopLevelRegex.
const LANE_HANDLE_LEAK_RE = /pdpp-slack-archived-run|NOT owner-authored/;

test("an agent proposal names the app and never reads as owner confirmation", () => {
  assert.equal(originLabel("agent", "client:daisy"), "Proposed by daisy");
  assert.equal(originLabel("agent", "agent"), "Proposed by an automated process");
  assert.doesNotMatch(originLabel("agent", "client:daisy"), YOU_WORD_RE);
});

test("an internal orchestration handle NEVER renders as a pseudo-identity", () => {
  // Live on 2026-08-26 the owner's UI read:
  //   "Proposed by agent:pdpp-slack-archived-run-0822 (NOT owner-authored)"
  // — a workflow lane name plus an internal parenthetical written for US,
  // presented as the party who proposed a change to his data collection. The
  // server cannot authenticate a lane name, so naming one invents an
  // accountable identity that does not exist.
  const laneHandle = "agent:pdpp-slack-archived-run-0822 (NOT owner-authored)";
  assert.equal(originLabel("agent", laneHandle), "Proposed by an automated process");
  assert.doesNotMatch(originLabel("agent", laneHandle), LANE_HANDLE_LEAK_RE);

  // Fails CLOSED: any unmodelled shape, including one nobody remembered to
  // map, degrades to the honest generic rather than leaking the raw handle.
  for (const unknown of ["waspflow/lane-7", "agent:whatever", "  ", "svc-account-12"]) {
    assert.equal(
      originLabel("agent", unknown),
      "Proposed by an automated process",
      `unmodelled actor ${JSON.stringify(unknown)} must not be rendered verbatim`
    );
  }

  // A REGISTERED app still earns its name — this is not a blanket anonymiser.
  assert.equal(originLabel("agent", "client:daisy"), "Proposed by daisy");
});

test("history answers what changed, why, and by whom before any machine field", () => {
  const entries = buildHistory(
    [
      revision({ config: { LOOKBACK_DAYS: 30 }, revision: 8, source_of_change: "Include the launch period" }),
      revision({ config: { SKIP_FILES: false }, revision: 7, status: "superseded" }),
    ],
    schema(),
    8
  );
  assert.equal(entries[0]?.revision.revision, 8, "newest first");
  assert.equal(entries[0]?.statusLabel, "Current");
  assert.equal(entries[0]?.summary, "Changed Lookback (days)");
  assert.equal(entries[0]?.reason, "Include the launch period");
  assert.equal(entries[0]?.isCurrent, true);
  assert.equal(entries[1]?.statusLabel, "Replaced by a newer revision");
});

test("a pending agent proposal is flagged as needing an owner decision", () => {
  const [entry] = buildHistory(
    [revision({ origin: "agent", revision: 9, set_by: "client:daisy", status: "proposed" })],
    schema(),
    8
  );
  assert.equal(entry?.needsOwnerDecision, true);
  assert.match(entry?.attribution ?? "", PROPOSED_BY_DAISY_RE);
});

test("history summarises multiple changed settings in plain words", () => {
  const [entry] = buildHistory(
    [revision({ config: { CHANNEL_TYPES: ["public"], LOOKBACK_DAYS: 30, SKIP_FILES: false } })],
    schema(),
    1
  );
  assert.equal(entry?.summary, "Changed Channel types, Lookback (days), and Skip files");
});

// ─── Labels ─────────────────────────────────────────────────────────────────

test("a raw option key becomes readable, keeping its unit", () => {
  assert.equal(optionLabel("LOOKBACK_DAYS"), "Lookback (days)");
  assert.equal(optionLabel("GMCLI_TIMEOUT_MS"), "Gmcli timeout (ms)");
  assert.equal(optionLabel("CHANNEL_ALLOWLIST"), "Channel allowlist");
  assert.equal(optionLabel("MEMBER_ONLY"), "Member only");
});

// ─── Stale write (409) ──────────────────────────────────────────────────────

test("a stale write is explained in owner words and keeps the server's real base", () => {
  const conflict = parseStaleConflict(
    "connector_instance_config: stale write -- caller's base does not match current (revision=9, epoch=1); rebase and retry, do not merge"
  );
  assert.equal(conflict.actualRevision, 9);
  assert.equal(conflict.actualEpoch, 1);
  assert.equal(conflict.message, "Configuration changed while you were editing.");
  assert.doesNotMatch(conflict.message, STALE_JARGON_RE);
});

test("an unparseable conflict message still yields a usable owner sentence", () => {
  const conflict = parseStaleConflict("something else went wrong");
  assert.equal(conflict.actualRevision, null);
  assert.match(conflict.message, CHANGED_WHILE_EDITING_RE);
});
