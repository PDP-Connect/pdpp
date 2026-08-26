// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure view-model for a connection's configuration editor.
 *
 * Everything an owner sees before anything is written lives here, as pure
 * functions over data the caller already fetched. That is not a style
 * preference — it is the safety property this feature exists to have.
 *
 * The backend classifies a proposal by its WHOLE bundle
 * (`connector-instance-config-store.ts` `deriveOptionKind`): a bundle whose
 * every key is platform-classified `transport` SELF-ACTIVATES the instant it
 * is POSTed, with no owner confirmation step. So a UI that POSTed merely to
 * show the owner a preview would apply a transport change the owner never
 * agreed to. Steps 1 and 2 of the F7 flow (edit draft, review changes) must
 * therefore be computable with zero server contact, and they are: `buildDraft`,
 * `setDraftValue`, `diffDraft`, `classifyDraft`, and `describeCommit` take
 * their inputs as arguments and return plain data. This module imports no
 * fetch, no client, and no server action, so "preview does not mutate" is a
 * structural fact about the import graph rather than a habit a future edit
 * could quietly break.
 *
 * Kind enforcement is mirrored, never invented. The server's registry is the
 * only authority (`connector-config-option-kind-registry.ts`), so the console
 * reads the per-option `option_kind` the API already resolved and re-applies
 * the same any-collection_scope-wins fold. An unknown or unclassified key is
 * treated as `collection_scope`, which matches the platform's fail-closed
 * default. Being wrong in the other direction would render a confirmation-
 * gated knob as self-activating, which is exactly the misrepresentation the
 * propose/confirm split exists to stop.
 */

/** Control type a form renders, mirroring `ConfigOptionType` on the wire. */
export type ConfigOptionType = "boolean" | "integer" | "string" | "string_array";

/** Platform-decided kind. `transport` self-activates; `collection_scope` does not. */
export type ConfigOptionKind = "collection_scope" | "transport";

export type ConfigRevisionStatus = "active" | "proposed" | "quarantined" | "superseded";

export type ConfigOrigin = "agent" | "default" | "migration" | "owner";

/** The three honest answers to "what can the owner configure here?". */
export type OptionsSchemaStatus = "declared" | "not_declared" | "unreadable";

/** A config value, in the closed set the schema can describe. */
export type ConfigValue = boolean | number | string | readonly string[];

/** One option as the API returns it (`optionForWire`). */
export interface ConfigOptionWire {
  readonly default: ConfigValue;
  readonly description: string;
  readonly enum: readonly string[] | null;
  readonly maximum: number | null;
  readonly minimum: number | null;
  readonly option_key: string;
  readonly option_kind: ConfigOptionKind;
  readonly platform_classified: boolean;
  readonly type: ConfigOptionType;
}

export interface ConfigOptionsSchemaWire {
  readonly connector_key: string;
  readonly description: string;
  readonly options: readonly ConfigOptionWire[];
}

/** One revision as the API returns it (`revisionForWire`). */
export interface ConfigRevisionWire {
  readonly collection_boundary_fingerprint: string | null;
  readonly config: Readonly<Record<string, unknown>>;
  readonly config_contract_id: string;
  readonly config_contract_version: number;
  readonly confirmed_at: string | null;
  readonly confirmed_by: string | null;
  readonly connection_id: string;
  readonly is_explicit: boolean;
  readonly option_kind: ConfigOptionKind;
  readonly origin: ConfigOrigin;
  readonly revision: number;
  readonly set_at: string;
  readonly set_by: string;
  readonly source_of_change: string;
  readonly status: ConfigRevisionStatus;
}

/** `GET /v1/owner/connections/:id/config`. */
export interface ConnectionConfigWire {
  readonly active_revision: ConfigRevisionWire | null;
  readonly base_epoch: number;
  readonly base_revision: number;
  readonly connection_id: string;
  readonly connector_key: string;
  readonly options_schema: ConfigOptionsSchemaWire | null;
  readonly options_schema_status: OptionsSchemaStatus;
}

// ─── Owner-facing labels ────────────────────────────────────────────────────

const WORD_SEPARATOR_RE = /[_\s]+/;

const UNIT_SUFFIXES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["_MS", "ms"],
  ["_SECONDS", "seconds"],
  ["_DAYS", "days"],
]);

/**
 * A raw option key turned into something a non-engineer can read.
 *
 * This is a deterministic FALLBACK, not a claim to know the connector's
 * intent. F7 is explicit that manifests should eventually carry owner labels
 * and units; until then, `LOOKBACK_DAYS` reading as "Lookback (days)" is a
 * strictly better owner surface than `LOOKBACK_DAYS`, and the exact key stays
 * visible under Technical details so nothing is hidden.
 *
 * A known unit suffix is folded into the label rather than dropped, because
 * "Timeout" without "(ms)" would understate the value by three orders of
 * magnitude. A connector-name prefix (`GMCLI_`, `CLAUDE_CODE_`) is left in
 * place: stripping it can collide two distinct keys onto one label.
 */
export function optionLabel(optionKey: string): string {
  let base = optionKey;
  let unit: string | null = null;
  for (const [suffix, rendered] of UNIT_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      unit = rendered;
      break;
    }
  }
  // Sentence case, not Title Case: "Skip files" reads as owner copy, while
  // "Skip Files" reads as a column header lifted from a config file.
  const words = base
    .split(WORD_SEPARATOR_RE)
    .filter((word) => word.length > 0)
    .map((word, index) =>
      index === 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}` : word.toLowerCase()
    );
  const label = words.join(" ") || optionKey;
  return unit ? `${label} (${unit})` : label;
}

/**
 * Owner-facing group for an option, derived from its ENFORCED kind.
 *
 * F7 §2 groups by owner consequence rather than alphabetically, and forbids
 * protocol nouns in visible copy: "collection scope" becomes "what this source
 * collects", "transport" becomes "how collection runs". An option the platform
 * never classified lands in its own group so the conservative reason for its
 * confirmation gate can be stated plainly instead of looking like an error.
 */
export type ConfigGroupId = "advanced" | "how_it_runs" | "what_to_collect";

export interface ConfigGroup {
  readonly description: string;
  readonly id: ConfigGroupId;
  readonly title: string;
}

const GROUPS: Readonly<Record<ConfigGroupId, ConfigGroup>> = Object.freeze({
  advanced: Object.freeze({
    description: "These settings need your confirmation because they have not been classified yet.",
    id: "advanced" as const,
    title: "Advanced",
  }),
  how_it_runs: Object.freeze({
    description: "These change how collection runs, not what it collects.",
    id: "how_it_runs" as const,
    title: "How collection runs",
  }),
  what_to_collect: Object.freeze({
    description: "These change what this source collects.",
    id: "what_to_collect" as const,
    title: "What to collect",
  }),
});

export function groupForOption(option: ConfigOptionWire): ConfigGroup {
  if (!option.platform_classified) {
    return GROUPS.advanced;
  }
  return option.option_kind === "transport" ? GROUPS.how_it_runs : GROUPS.what_to_collect;
}

// ─── Current settings ───────────────────────────────────────────────────────

/**
 * Where a currently-shown value came from.
 *
 * F7 §4 is emphatic that a schema default is NOT an attributed owner choice,
 * so the two are never collapsed: an owner reading their own settings must be
 * able to tell "I chose this" from "nobody has chosen, so the connector's own
 * default applies".
 */
export type ValueProvenance = "connector_default" | "owner_set";

export interface CurrentSettingRow {
  readonly group: ConfigGroup;
  readonly label: string;
  readonly option: ConfigOptionWire;
  readonly optionKey: string;
  readonly provenance: ValueProvenance;
  readonly provenanceLabel: string;
  readonly value: ConfigValue;
  readonly valueLabel: string;
}

/**
 * Coerce a stored value onto the schema's declared type.
 *
 * A revision's `config` is free-form JSON, and a manifest can change shape
 * under an already-stored revision. Rather than render `[object Object]` or
 * crash a settings page, a value that does not match the declared type is
 * treated as absent, so the row falls back to the connector default and says
 * so. Returning `null` (not the default) keeps that decision at the call site,
 * where provenance is also decided.
 */
export function coerceToType(type: ConfigOptionType, raw: unknown): ConfigValue | null {
  switch (type) {
    case "boolean": {
      return typeof raw === "boolean" ? raw : null;
    }
    case "integer": {
      return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
    }
    case "string": {
      return typeof raw === "string" ? raw : null;
    }
    default: {
      return Array.isArray(raw) && raw.every((entry) => typeof entry === "string")
        ? Object.freeze([...(raw as string[])])
        : null;
    }
  }
}

/** Owner-readable rendering of a value. Never a raw JSON blob. */
export function formatValue(type: ConfigOptionType, value: ConfigValue): string {
  if (type === "boolean") {
    return value === true ? "On" : "Off";
  }
  if (type === "string_array") {
    const entries = Array.isArray(value) ? (value as readonly string[]) : [];
    if (entries.length === 0) {
      return "None selected";
    }
    return entries.join(", ");
  }
  if (type === "string" && value === "") {
    return "Not set";
  }
  return String(value);
}

/**
 * The effective settings table: every declared option, its current value, and
 * whether that value is the owner's choice or the connector's default.
 */
export function buildCurrentSettings(
  schema: ConfigOptionsSchemaWire,
  activeRevision: ConfigRevisionWire | null
): CurrentSettingRow[] {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: activeRevision is ConfigRevisionWire | null; tsc rejects removing this guard.
  const config = activeRevision?.config ?? {};
  return schema.options.map((option) => {
    const stored = Object.hasOwn(config, option.option_key)
      ? coerceToType(option.type, config[option.option_key])
      : null;
    const ownerSet = stored !== null;
    const value = ownerSet ? stored : option.default;
    return {
      group: groupForOption(option),
      label: optionLabel(option.option_key),
      option,
      optionKey: option.option_key,
      provenance: ownerSet ? "owner_set" : "connector_default",
      provenanceLabel: ownerSet ? "Set by you" : "Connector default",
      value,
      valueLabel: formatValue(option.type, value),
    };
  });
}

// ─── Local draft ────────────────────────────────────────────────────────────

/** The owner's in-progress edits. Purely local until an explicit commit. */
export type ConfigDraft = Readonly<Record<string, ConfigValue>>;

/**
 * Seed a draft from the effective settings.
 *
 * Seeded from EFFECTIVE values (owner-set where present, connector default
 * otherwise) so the form shows what collection actually does today. The diff
 * in `diffDraft` then compares against these same effective values, which is
 * why re-selecting a connector default over an owner-set value is correctly
 * reported as a change while touching nothing is correctly reported as none.
 */
export function buildDraft(schema: ConfigOptionsSchemaWire, activeRevision: ConfigRevisionWire | null): ConfigDraft {
  const draft: Record<string, ConfigValue> = {};
  for (const row of buildCurrentSettings(schema, activeRevision)) {
    draft[row.optionKey] = row.value;
  }
  return Object.freeze(draft);
}

/** Apply one local edit. Returns a new draft; never mutates in place. */
export function setDraftValue(draft: ConfigDraft, optionKey: string, value: ConfigValue): ConfigDraft {
  return Object.freeze({ ...draft, [optionKey]: value });
}

function sameValue(a: ConfigValue, b: ConfigValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const left = a as readonly string[];
    const right = b as readonly string[];
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
  }
  return a === b;
}

export interface ConfigFieldChange {
  readonly currentLabel: string;
  readonly currentValue: ConfigValue;
  readonly group: ConfigGroup;
  readonly label: string;
  readonly option: ConfigOptionWire;
  readonly optionKey: string;
  readonly proposedLabel: string;
  readonly proposedValue: ConfigValue;
}

/**
 * The review step: which fields changed, current → proposed.
 *
 * Pure and server-free. This is the function the F7 "review changes" screen
 * renders, and the reason that screen can exist without a POST.
 */
export function diffDraft(
  schema: ConfigOptionsSchemaWire,
  activeRevision: ConfigRevisionWire | null,
  draft: ConfigDraft
): ConfigFieldChange[] {
  const changes: ConfigFieldChange[] = [];
  for (const row of buildCurrentSettings(schema, activeRevision)) {
    const proposed = draft[row.optionKey];
    if (proposed === undefined || sameValue(row.value, proposed)) {
      continue;
    }
    changes.push({
      currentLabel: row.valueLabel,
      currentValue: row.value,
      group: row.group,
      label: row.label,
      option: row.option,
      optionKey: row.optionKey,
      proposedLabel: formatValue(row.option.type, proposed),
      proposedValue: proposed,
    });
  }
  return changes;
}

/** How many declared options the owner left alone, for the "N unchanged" line. */
export function unchangedCount(schema: ConfigOptionsSchemaWire, changes: readonly ConfigFieldChange[]): number {
  return Math.max(0, schema.options.length - changes.length);
}

// ─── Kind classification and the honest commit action ───────────────────────

/**
 * The enforced kind of a whole proposed bundle.
 *
 * Mirrors the store's `deriveOptionKind`: any collection_scope key makes the
 * ENTIRE bundle collection_scope, and an empty bundle is collection_scope too.
 * An option the platform never classified counts as collection_scope
 * regardless of what `option_kind` says, matching the registry's fail-closed
 * default — the console must never present a confirmation-gated knob as
 * self-activating.
 */
export function classifyDraft(changes: readonly ConfigFieldChange[]): ConfigOptionKind {
  if (changes.length === 0) {
    return "collection_scope";
  }
  const anyScope = changes.some(
    (change) => !change.option.platform_classified || change.option.option_kind === "collection_scope"
  );
  return anyScope ? "collection_scope" : "transport";
}

export interface CommitDescriptor {
  /** True when the bundle mixes collection-shaping and transport-only fields. */
  readonly bundlesTransportWithScope: boolean;
  readonly buttonLabel: string;
  /** The status the server is expected to return for this bundle. */
  readonly expectedStatus: ConfigRevisionStatus;
  /** True when at least one changed field is unclassified by the platform. */
  readonly hasUnclassified: boolean;
  readonly kind: ConfigOptionKind;
  readonly supportingText: string;
}

/**
 * The honest commit action for a bundle (F7 §3 step 3).
 *
 * The button must promise exactly what the server will do. A transport-only
 * bundle takes effect on POST, so it says "Apply changes"; anything else lands
 * inert, so it says "Create proposal" and states that nothing changes yet.
 * A mixed bundle explains the consequence of the whole-bundle rule rather than
 * exposing the rule itself.
 */
export function describeCommit(changes: readonly ConfigFieldChange[]): CommitDescriptor {
  const kind = classifyDraft(changes);
  const hasUnclassified = changes.some((change) => !change.option.platform_classified);
  const hasTransport = changes.some(
    (change) => change.option.platform_classified && change.option.option_kind === "transport"
  );
  const hasScope = changes.some(
    (change) => change.option.platform_classified && change.option.option_kind === "collection_scope"
  );
  if (kind === "transport") {
    return {
      bundlesTransportWithScope: false,
      buttonLabel: "Apply changes",
      expectedStatus: "active",
      hasUnclassified: false,
      kind,
      supportingText:
        "These settings change how collection runs, not what it collects. They take effect immediately and will be recorded as a new revision.",
    };
  }
  const bundlesTransportWithScope = hasTransport && (hasScope || hasUnclassified);
  let supportingText = "Nothing changes until you confirm the proposal.";
  if (bundlesTransportWithScope) {
    supportingText =
      "This proposal includes settings that change what is collected, so the entire change needs your confirmation. Nothing changes until you confirm.";
  } else if (hasUnclassified && !hasScope) {
    supportingText =
      "This setting needs your confirmation because it has not been classified yet. Nothing changes until you confirm.";
  }
  return {
    bundlesTransportWithScope,
    buttonLabel: "Create proposal",
    expectedStatus: "proposed",
    hasUnclassified,
    kind,
    supportingText,
  };
}

/**
 * Per-field explanation of why a change needs confirmation.
 *
 * Returns null for a field that carries no gate of its own, so the caller can
 * stay silent rather than decorate every row with a reason.
 */
export function confirmationReason(option: ConfigOptionWire): string | null {
  if (!option.platform_classified) {
    return "Requires confirmation because the platform has not classified this setting yet.";
  }
  return option.option_kind === "collection_scope" ? "Changes what this source collects." : null;
}

// ─── Local validation ───────────────────────────────────────────────────────

/**
 * Validate a draft against the schema BEFORE any request.
 *
 * Catching a bad value locally keeps a doomed write off the ledger entirely:
 * the revision table is append-only, so a rejected POST would otherwise be a
 * permanent, unexplainable entry in the owner's own audit history.
 */
/** Bounds check for an `integer` option, or null when it is within range. */
function boundsError(option: ConfigOptionWire, value: number): string | null {
  if (option.minimum !== null && value < option.minimum) {
    return `Enter ${option.minimum} or more.`;
  }
  if (option.maximum !== null && value > option.maximum) {
    return `Enter ${option.maximum} or less.`;
  }
  return null;
}

/** The first value outside the declared choices, or undefined when all are allowed. */
function firstDisallowedChoice(option: ConfigOptionWire, coerced: ConfigValue): string | undefined {
  if (!option.enum || option.enum.length === 0) {
    return;
  }
  const allowed = new Set(option.enum);
  if (option.type === "string_array") {
    return (coerced as readonly string[]).find((entry) => !allowed.has(entry));
  }
  const single = coerced as string;
  return allowed.has(single) ? undefined : single;
}

/** The one owner-facing error for a single option, or null when it is valid. */
function optionError(option: ConfigOptionWire, value: ConfigValue): string | null {
  const coerced = coerceToType(option.type, value);
  if (coerced === null) {
    return `${optionLabel(option.option_key)} must be a ${option.type.replace("_", " ")}.`;
  }
  if (option.type === "integer") {
    const bounds = boundsError(option, coerced as number);
    if (bounds !== null) {
      return bounds;
    }
  }
  const offending = firstDisallowedChoice(option, coerced);
  return offending === undefined ? null : `"${offending}" is not one of the allowed choices.`;
}

export function validateDraft(schema: ConfigOptionsSchemaWire, draft: ConfigDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const option of schema.options) {
    const value = draft[option.option_key];
    if (value === undefined) {
      continue;
    }
    const error = optionError(option, value);
    if (error !== null) {
      errors[option.option_key] = error;
    }
  }
  return errors;
}

/** The reason field is required — `source_of_change` is part of the durable record. */
export function reasonError(reason: string): string | null {
  return reason.trim().length === 0 ? "Say why you are changing this, so the record explains itself later." : null;
}

/**
 * The exact bundle to POST: only the changed keys.
 *
 * Sending only what changed keeps the ledger entry legible ("this revision
 * changed these two things") and avoids re-asserting an unrelated default as a
 * deliberate owner choice.
 */
export function buildProposalConfig(changes: readonly ConfigFieldChange[]): Record<string, ConfigValue> {
  const config: Record<string, ConfigValue> = {};
  for (const change of changes) {
    config[change.optionKey] = change.proposedValue;
  }
  return config;
}

// ─── Schema availability ────────────────────────────────────────────────────

export type ConfigAvailability =
  | { readonly kind: "editable"; readonly schema: ConfigOptionsSchemaWire }
  | { readonly kind: "empty"; readonly schema: ConfigOptionsSchemaWire }
  | { readonly kind: "not_declared"; readonly message: string }
  | { readonly kind: "unreadable"; readonly message: string };

/**
 * What the configuration surface can honestly offer.
 *
 * `not_declared` and declared-but-empty are DIFFERENT owner-facing facts and
 * are never collapsed. 42 of 45 shipped manifests are undeclared, so rendering
 * an empty, authoritative-looking form for them would assert that the
 * connector has nothing to configure — a claim the server explicitly refuses
 * to make on their behalf.
 */
export function resolveAvailability(config: ConnectionConfigWire): ConfigAvailability {
  if (config.options_schema_status === "unreadable") {
    return {
      kind: "unreadable",
      message:
        "This connector's settings description is invalid, so it cannot be shown as a form. Update the connector to fix it.",
    };
  }
  if (config.options_schema_status === "not_declared" || config.options_schema === null) {
    return {
      kind: "not_declared",
      message:
        "Settings are not available for this connector yet. Its existing collection behaviour is unchanged — nobody has described its options.",
    };
  }
  return config.options_schema.options.length === 0
    ? { kind: "empty", schema: config.options_schema }
    : { kind: "editable", schema: config.options_schema };
}

// ─── Pending proposal and history ───────────────────────────────────────────

/** The newest proposal still awaiting confirmation, or null. */
export function findPendingProposal(revisions: readonly ConfigRevisionWire[]): ConfigRevisionWire | null {
  let pending: ConfigRevisionWire | null = null;
  for (const revision of revisions) {
    if (revision.status === "proposed" && (pending === null || revision.revision > pending.revision)) {
      pending = revision;
    }
  }
  return pending;
}

/**
 * Owner-facing label for a revision's status. Raw enum values never reach copy.
 */
export function statusLabel(status: ConfigRevisionStatus, isCurrent: boolean): string {
  switch (status) {
    case "active": {
      return isCurrent ? "Current" : "Was active";
    }
    case "proposed": {
      return "Awaiting confirmation";
    }
    case "superseded": {
      return "Replaced by a newer revision";
    }
    default: {
      return "Blocked; not used by syncs";
    }
  }
}

/**
 * Owner-facing attribution for an origin.
 *
 * An `agent` origin must never read as owner confirmation, so it says who
 * proposed it and stays visibly distinct from a change the owner made.
 */
export function originLabel(origin: ConfigOrigin, actor: string): string {
  switch (origin) {
    case "owner": {
      return "Changed by you";
    }
    case "agent": {
      return `Proposed by ${describeAgentActor(actor)}`;
    }
    case "default": {
      return "Connector default";
    }
    default: {
      return "Carried over during upgrade";
    }
  }
}

/** `client:daisy` is an internal handle; render the readable half. */
export function describeAgentActor(actor: string): string {
  const trimmed = actor.trim();
  if (trimmed.startsWith("client:")) {
    const name = trimmed.slice("client:".length).trim();
    return name || "an app";
  }
  return trimmed === "agent" || trimmed === "" ? "an app" : trimmed;
}

export interface RevisionHistoryEntry {
  readonly attribution: string;
  readonly changedKeys: readonly string[];
  readonly confirmedBy: string | null;
  readonly isCurrent: boolean;
  /** True when this entry is an agent proposal the owner has not confirmed. */
  readonly needsOwnerDecision: boolean;
  readonly reason: string;
  readonly revision: ConfigRevisionWire;
  readonly statusLabel: string;
  readonly summary: string;
}

/**
 * History a non-engineer can read: what changed, what it means, who, when.
 *
 * Machine fields (raw keys, JSON, contract id, fingerprint, actor ids) are
 * deliberately NOT formatted into these sentences; the component keeps them
 * under Technical details. F7 §5 cites the grant-approval page as the
 * anti-pattern to avoid — evidence before decision.
 */
export function buildHistory(
  revisions: readonly ConfigRevisionWire[],
  schema: ConfigOptionsSchemaWire | null,
  activeRevisionNumber: number | null
): RevisionHistoryEntry[] {
  const labelFor = new Map(
    (schema?.options ?? []).map((option) => [option.option_key, optionLabel(option.option_key)])
  );
  return [...revisions]
    .sort((a, b) => b.revision - a.revision)
    .map((revision) => {
      const changedKeys = Object.keys(revision.config).sort();
      const names = changedKeys.map((key) => labelFor.get(key) ?? optionLabel(key));
      const isCurrent = activeRevisionNumber !== null && revision.revision === activeRevisionNumber;
      return {
        attribution: originLabel(revision.origin, revision.set_by),
        changedKeys,
        confirmedBy: revision.confirmed_by,
        isCurrent,
        needsOwnerDecision: revision.status === "proposed",
        reason: revision.source_of_change,
        revision,
        statusLabel: statusLabel(revision.status, isCurrent),
        summary: summarizeChangedNames(names),
      };
    });
}

function summarizeChangedNames(names: readonly string[]): string {
  if (names.length === 0) {
    return "No settings recorded in this revision";
  }
  if (names.length === 1) {
    return `Changed ${names[0]}`;
  }
  if (names.length === 2) {
    return `Changed ${names[0]} and ${names[1]}`;
  }
  return `Changed ${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

// ─── Stale write (409) ──────────────────────────────────────────────────────

export interface StaleConflict {
  readonly actualEpoch: number | null;
  readonly actualRevision: number | null;
  readonly message: string;
}

const STALE_DETAIL_RE = /revision=(\d+),\s*epoch=(\d+)/;

/**
 * Read the server's ACTUAL current base out of a 409 message.
 *
 * The store deliberately reports the real current (revision, epoch) so a
 * caller can rebase explicitly. Parsing is best-effort and every field is
 * nullable: the owner-facing sentence never depends on it, and a message shape
 * change degrades the technical detail rather than the recovery path.
 */
export function parseStaleConflict(message: string): StaleConflict {
  const match = STALE_DETAIL_RE.exec(message);
  return {
    actualEpoch: match ? Number(match[2]) : null,
    actualRevision: match ? Number(match[1]) : null,
    message: "Configuration changed while you were editing.",
  };
}
