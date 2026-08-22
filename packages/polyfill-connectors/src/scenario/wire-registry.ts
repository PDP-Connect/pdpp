// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single registry over `EmittedMessage["type"]` (connector-runtime-protocol.ts)
 * — the complete, closed set of message kinds the wire protocol declares.
 * Repair wave 6 (P1-2): built once here so `bin/scenario-verify.ts`'s
 * subprocess stdout accumulator and `bin/scenario-record.ts`'s subprocess
 * stdout accumulator both reject an unrecognized `type` the SAME way, instead
 * of each re-deriving (or, as before this wave, never checking) the known-kind
 * set independently. `KNOWN_MESSAGE_TYPES` is declared `satisfies
 * Record<EmittedMessage["type"], true>` — exactly like verify.ts's
 * `TRACE_POLICY` — so this file BREAKS COMPILATION the moment
 * connector-runtime-protocol.ts's `EmittedMessage` union gains a member this
 * registry doesn't account for. `isKnownMessageType` is the single predicate
 * both CLIs call; `UnknownMessageTypeError` is the single named error both
 * CLIs throw, so "the subprocess wrote a message this protocol doesn't
 * declare" reads identically whether it happened while recording or while
 * verifying.
 */

import type { EmittedMessage, InteractionKind } from "@pdpp/connector-protocol/connector-runtime-protocol";

/**
 * Every `type` literal `EmittedMessage` declares — exhaustive-by-construction
 * via the `satisfies` clause below (see this module's doc comment). Values
 * are `true`; only the key set matters.
 */
export const KNOWN_MESSAGE_TYPES = {
  RECORD: true,
  STATE: true,
  PROGRESS: true,
  ASSISTANCE: true,
  ASSISTANCE_STATUS: true,
  SKIP_RESULT: true,
  DETAIL_GAP: true,
  DETAIL_GAP_ATTEMPTED: true,
  DETAIL_COVERAGE: true,
  DETAIL_GAP_RECOVERED: true,
  DETAIL_GAPS_PAGE_REQUEST: true,
  DONE: true,
  INTERACTION: true,
} satisfies Record<EmittedMessage["type"], true>;

/**
 * Thrown by both `bin/scenario-verify.ts`'s `StdoutProtocolAccumulator` and
 * `bin/scenario-record.ts`'s subprocess line handler when a parsed stdout
 * JSON object's `type` is not one of `KNOWN_MESSAGE_TYPES` — a connector (or
 * a bug in a harness-adjacent tool) emitting a message this protocol has
 * never declared. Distinct from a non-JSON line (already handled by each
 * caller's own "protocol-corrupt stdout" path) — this is well-formed JSON
 * with a `type` field that simply names nothing this wire protocol knows.
 */
export class UnknownMessageTypeError extends Error {
  readonly rawType: unknown;

  constructor(rawType: unknown) {
    super(
      `unrecognized protocol message type ${JSON.stringify(rawType)} — not one of the ${String(Object.keys(KNOWN_MESSAGE_TYPES).length)} kinds EmittedMessage declares`
    );
    this.name = "UnknownMessageTypeError";
    this.rawType = rawType;
  }
}

/** True when `type` is one of `KNOWN_MESSAGE_TYPES`'s keys. */
export function isKnownMessageType(type: unknown): type is EmittedMessage["type"] {
  return typeof type === "string" && Object.hasOwn(KNOWN_MESSAGE_TYPES, type);
}

/**
 * Asserts `parsed` is a JSON object carrying a recognized `type` — throws
 * `UnknownMessageTypeError` naming the offending value otherwise. Callers
 * pass the already-`JSON.parse`d line; a non-object or a missing `type`
 * (which no well-formed protocol message ever omits) is reported the same
 * way, naming whatever value was actually present at `.type`.
 */
export function assertKnownMessageType(parsed: unknown): void {
  const type = parsed !== null && typeof parsed === "object" ? (parsed as { type?: unknown }).type : undefined;
  if (!isKnownMessageType(type)) {
    throw new UnknownMessageTypeError(type);
  }
}

// ─── P1-1: RECORD wire-boundary validation (duty-2) ────────────────────────

/**
 * Thrown by `assertValidRecordMessage` when a parsed stdout JSON object's
 * `type === "RECORD"` but the message fails the wire's own shape contract —
 * connector-runtime-protocol.ts's RECORD variant of `EmittedMessage`:
 * `stream` a nonempty string, `key` a nonempty string or a nonempty array of
 * nonempty strings (the doc comment on that field: "A scalar `number` is
 * never valid on the wire"), `data` an object (`RecordData`), `emitted_at` a
 * string, and `op` — when present — the single literal `"delete"` (absent
 * means upsert; there is no explicit `"upsert"` literal on the wire). This is
 * the wire-registry's RECORD duty, parallel to `assertKnownMessageType`'s
 * type-level duty — both CLIs (bin/scenario-record.ts recording a live run,
 * bin/scenario-verify.ts replaying one) call this on every RECORD they parse
 * off a subprocess's stdout, so a malformed RECORD is rejected the same way
 * regardless of which side observed it, instead of being silently absorbed
 * into `messagesToRecordsAndState`'s (subprocess-fetch-preloads.ts)
 * best-effort projection.
 */
export class MalformedRecordMessageError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`malformed RECORD message at the wire boundary — ${detail}`);
    this.name = "MalformedRecordMessageError";
    this.detail = detail;
  }
}

/** Raw shape of a RECORD message as parsed off stdout JSONL, loose/defensive
 *  like `RawTraceMessage` (verify.ts) since the source is untyped JSON. */
export interface RawRecordMessage {
  data?: unknown;
  emitted_at?: unknown;
  key?: unknown;
  op?: unknown;
  stream?: unknown;
  type: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** True when `value` is the wire's `key: string | readonly string[]` shape —
 *  a nonempty string, or a nonempty array of nonempty strings (a scalar
 *  `number` or an array containing one is never valid — see
 *  connector-runtime-protocol.ts's RECORD `key` doc comment). */
function isValidRecordKey(value: unknown): boolean {
  if (isNonEmptyString(value)) {
    return true;
  }
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

/** True when `value` is a plain object (not `null`, not an array) — the
 *  wire's `RecordData` shape (connector-runtime-protocol.ts: `{ id?: ...,
 *  [field: string]: unknown }`). */
function isRecordDataObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Asserts `raw` (already parsed JSON, `type === "RECORD"` confirmed by the
 * caller) satisfies the wire's RECORD contract — throws
 * `MalformedRecordMessageError` naming the first violation otherwise. See
 * this section's module doc comment for the exact fields checked and why.
 */
export function assertValidRecordMessage(raw: RawRecordMessage): void {
  if (!isNonEmptyString(raw.stream)) {
    throw new MalformedRecordMessageError(`stream must be a nonempty string, got ${JSON.stringify(raw.stream)}`);
  }
  if (!isValidRecordKey(raw.key)) {
    throw new MalformedRecordMessageError(
      `key must be a nonempty string or a nonempty array of nonempty strings, got ${JSON.stringify(raw.key)}`
    );
  }
  if (!isRecordDataObject(raw.data)) {
    throw new MalformedRecordMessageError(`data must be an object, got ${JSON.stringify(raw.data)}`);
  }
  if (!isNonEmptyString(raw.emitted_at)) {
    throw new MalformedRecordMessageError(
      `emitted_at must be a nonempty string, got ${JSON.stringify(raw.emitted_at)}`
    );
  }
  if (raw.op !== undefined && raw.op !== "delete") {
    throw new MalformedRecordMessageError(
      `op, when present, must be the literal "delete", got ${JSON.stringify(raw.op)}`
    );
  }
}

// ─── P2: STATE wire-boundary validation (symmetric with RECORD/INTERACTION) ─

/**
 * Thrown by `assertValidStateMessage` when a parsed stdout JSON object's
 * `type === "STATE"` but the message fails the wire's own shape contract —
 * connector-runtime-protocol.ts's STATE variant of `EmittedMessage`:
 * `{ type: "STATE"; stream: string; cursor: unknown }`.
 *
 * GROUNDING THE `stream` RULE (eighth review, P2): the wire TYPE declares
 * `stream: string` with no "nonempty" annotation in its own doc comment
 * (unlike RECORD's `key`, whose doc comment explicitly says "A scalar
 * `number` is never valid on the wire") — so this validator's nonempty-string
 * rule for `stream` is not copied from an explicit protocol annotation, it is
 * grounded in EVERY REAL EMISSION SITE this repo has: every connector that
 * emits STATE (connectors/github/index.ts, connectors/imessage/index.ts,
 * connectors/jellyfin/index.ts, connectors/ynab/index.ts,
 * connectors/steam/index.ts, and others) always supplies a nonempty literal
 * stream name (`"user"`, `"accounts"`, `"libraries"`, ...) — none emits
 * `stream: ""`, and a cursor with no stream to attach to cannot be merged
 * into `final_state` by `mergeStateMessages` (verify.ts) or
 * `messagesToRecordsAndState` (subprocess-fetch-preloads.ts) in any
 * meaningful way (`base[""] = cursor` would silently create a
 * `""`-keyed state entry no scenario expectation could ever reference by
 * name). This mirrors RECORD's already-enforced `stream` rule exactly
 * (`assertValidRecordMessage` above) rather than inventing a laxer rule for
 * STATE — the runtime's ACTUAL behavior for both message kinds is "every
 * real emission names a real, nonempty stream", so this validator states
 * that honestly instead of accepting a shape the runtime never produces.
 *
 * `cursor` is intentionally checked for PRESENCE only (the property must
 * exist on the parsed object), never for shape — `cursor: unknown` on the
 * wire type is a deliberate opacity: a cursor is connector-owned and
 * arbitrarily shaped (a string token, a number, an object, even `null`), so
 * this validator must not reject a legitimate cursor value for "looking
 * wrong". What it DOES reject is the property being entirely ABSENT — a
 * STATE message that never carried a `cursor` key at all is not "cursor:
 * null" (a connector deliberately clearing its cursor), it is a malformed
 * message missing a required field, and `Object.hasOwn` distinguishes the
 * two cases (`{stream:"x"}` has no `cursor` key; `{stream:"x",cursor:null}`
 * does).
 */
export class MalformedStateMessageError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`malformed STATE message at the wire boundary — ${detail}`);
    this.name = "MalformedStateMessageError";
    this.detail = detail;
  }
}

/** Raw shape of a STATE message as parsed off stdout JSONL, loose/defensive
 *  like `RawRecordMessage` above since the source is untyped JSON. */
export interface RawStateMessage {
  cursor?: unknown;
  stream?: unknown;
  type: string;
}

/**
 * Asserts `raw` (already parsed JSON, `type === "STATE"` confirmed by the
 * caller) satisfies the wire's STATE contract — throws
 * `MalformedStateMessageError` naming the first violation otherwise. See
 * this section's module doc comment for the exact fields checked and why.
 */
export function assertValidStateMessage(raw: RawStateMessage): void {
  if (!isNonEmptyString(raw.stream)) {
    throw new MalformedStateMessageError(`stream must be a nonempty string, got ${JSON.stringify(raw.stream)}`);
  }
  if (!Object.hasOwn(raw, "cursor")) {
    throw new MalformedStateMessageError("cursor property is required (opaque value; even null must be explicit)");
  }
}

// ─── P1-2: INTERACTION wire-boundary validation ────────────────────────────

/**
 * Thrown by `assertValidInteractionMessage` when a parsed stdout JSON
 * object's `type === "INTERACTION"` but the message fails the wire's own
 * shape contract — connector-runtime-protocol.ts's INTERACTION variant of
 * `EmittedMessage`: `kind` one of the closed `InteractionKind` enum
 * (`"credentials" | "otp" | "manual_action"`), `request_id` a nonempty
 * string, `message` a string, `schema` — when present — an object, and
 * `timeout_seconds` — when present — a finite positive number. Used by
 * `bin/scenario-verify.ts`'s scripted-answer path (P1-2, seventh review) to
 * validate the ACTUAL prompt a replaying subprocess emits BEFORE comparing
 * it against the recorded one — a malformed live prompt must not be silently
 * compared field-by-field against a well-formed recorded one (which could
 * make a real protocol violation read as an ordinary content mismatch, or
 * vice versa mask one behind a comparison that never runs because a field
 * was missing).
 */
export class MalformedInteractionMessageError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`malformed INTERACTION message at the wire boundary — ${detail}`);
    this.name = "MalformedInteractionMessageError";
    this.detail = detail;
  }
}

const KNOWN_INTERACTION_KINDS: ReadonlySet<string> = new Set(["credentials", "otp", "manual_action"] satisfies [
  InteractionKind,
  InteractionKind,
  InteractionKind,
]);

/** Raw shape of an INTERACTION message as parsed off stdout JSONL. */
export interface RawInteractionMessage {
  kind?: unknown;
  message?: unknown;
  request_id?: unknown;
  schema?: unknown;
  timeout_seconds?: unknown;
  type: string;
}

/**
 * Asserts `raw` (already parsed JSON, `type === "INTERACTION"` confirmed by
 * the caller) satisfies the wire's INTERACTION contract — throws
 * `MalformedInteractionMessageError` naming the first violation otherwise.
 * See this section's module doc comment for the exact fields checked.
 */
export function assertValidInteractionMessage(raw: RawInteractionMessage): void {
  if (typeof raw.kind !== "string" || !KNOWN_INTERACTION_KINDS.has(raw.kind)) {
    throw new MalformedInteractionMessageError(
      `kind must be one of ${[...KNOWN_INTERACTION_KINDS].join(", ")}, got ${JSON.stringify(raw.kind)}`
    );
  }
  if (typeof raw.request_id !== "string" || raw.request_id.length === 0) {
    throw new MalformedInteractionMessageError(
      `request_id must be a nonempty string, got ${JSON.stringify(raw.request_id)}`
    );
  }
  if (typeof raw.message !== "string") {
    throw new MalformedInteractionMessageError(`message must be a string, got ${JSON.stringify(raw.message)}`);
  }
  if (
    raw.schema !== undefined &&
    (typeof raw.schema !== "object" || raw.schema === null || Array.isArray(raw.schema))
  ) {
    throw new MalformedInteractionMessageError(
      `schema, when present, must be an object, got ${JSON.stringify(raw.schema)}`
    );
  }
  if (
    raw.timeout_seconds !== undefined &&
    !(typeof raw.timeout_seconds === "number" && Number.isFinite(raw.timeout_seconds) && raw.timeout_seconds > 0)
  ) {
    throw new MalformedInteractionMessageError(
      `timeout_seconds, when present, must be a finite positive number, got ${JSON.stringify(raw.timeout_seconds)}`
    );
  }
}

// ─── P1-1: per-driver minimum evidence policy ──────────────────────────────

/**
 * The generic driver-evidence prerequisite for the canonical `recorded_replay`
 * claim (repair wave 6, P1-1): a driver's own minimum bar for "this run
 * actually exercised its transport", independent of and additional to
 * `evaluateClaimEligibility`'s other seven conditions (identity binding,
 * digest bindings, environment-driver declaration, protocol-trace presence,
 * namespace isolation, unsupported-evidence-surface). A scenario can declare
 * `environment.network.driver === "recorded-http"` on every run (condition
 * (d), already checked) while still never having recorded a single real HTTP
 * interaction — e.g. every run's `interactions` array is empty because the
 * connector only emitted STATE/DONE, or a scenario file was hand-assembled
 * rather than genuinely captured. Declaring the driver is not the same as
 * having evidence FOR that driver; this map closes that gap per-driver.
 *
 * Structured as a small map (not an `if driver === "recorded-http"`
 * special-case inline in `evaluateClaimEligibility` or `scenario-verify.ts`)
 * so a future driver (browser/imap/subprocess) adds its own entry here —
 * its own minimum-evidence predicate over the scenario — without touching
 * the recorded-http entry or claims.ts's evaluator logic at all.
 *
 * `recorded-http`'s policy (the only driver this build implements —
 * `bin/scenario-verify.ts`'s `SUPPORTED_NETWORK_DRIVER`): satisfied only
 * when the scenario has at least one recorded HTTP interaction across ITS
 * RUNS — `scenario.runs.some((run) => run.interactions.length > 0)`.
 * Consumption of a recorded interaction (every recorded interaction actually
 * being replayed, none left over) is already enforced elsewhere and is
 * DELIBERATELY NOT duplicated here: `replay.ts`'s `ReplayFetch.
 * assertAllConsumed()`, called from `verify.ts`'s `verifyRun` for every run,
 * already fails the run (`unconsumed_interactions` `VerifyFailure`) when any
 * recorded interaction was never consumed by the replay. This policy answers
 * a narrower, prerequisite question — "did this scenario capture any
 * recorded-http evidence AT ALL" — which `assertAllConsumed()` cannot answer
 * on its own (a scenario with zero interactions trivially has zero
 * unconsumed ones too, so it would pass that check vacuously).
 */
/**
 * Scenario shape `driverEvidenceSatisfied`/policy `satisfied` predicates
 * read from — a structural superset of every driver's evidence surface
 * (recorded-http's `run.interactions`, recorded-browser's
 * `run.environment.network.har_entry_count` when that driver is declared).
 * Every field is read defensively (this is untyped-at-the-boundary JSON, the
 * same posture every other reader in this module takes) so a policy can
 * never throw on a scenario shaped for a DIFFERENT driver.
 */
interface DriverEvidenceScenario {
  runs: readonly {
    environment?: { network?: { driver?: string; har_entry_count?: unknown } };
    interactions: readonly unknown[];
  }[];
}

export interface DriverEvidencePolicy {
  /** Exact string printed under `limitations:` when this driver's minimum
   *  evidence bar is not met — see claims.ts's `ClaimLimitation`. */
  limitation: string;
  /** True when `scenario` carries this driver's minimum evidence bar. */
  satisfied: (scenario: DriverEvidenceScenario) => boolean;
}

/**
 * `recorded-browser`'s policy (repair wave: browser-driven connector
 * verification) — satisfied only when at least one run in the scenario
 * declares `environment.network.driver === "recorded-browser"` AND that
 * run's `har_entry_count` is a positive integer. Mirrors `recorded-http`'s
 * "at least one recorded HTTP interaction across ITS RUNS" reasoning exactly
 * (see `DRIVER_EVIDENCE_POLICIES`'s module doc comment above): declaring the
 * driver is not the same as having evidence FOR it — a scenario could
 * declare `recorded-browser` on every run while every run's HAR is actually
 * empty (a hand-assembled scenario file, or a capture that produced zero
 * entries), which is exactly the vacuous case this predicate exists to
 * catch. `har_entry_count` is read directly off the format field
 * (`ScenarioBrowserNetworkDriver`, format.ts) rather than by re-parsing the
 * HAR file from disk — this module (and `evaluateClaimEligibility`, its
 * caller) is a pure function of the scenario's own in-memory shape, exactly
 * like the recorded-http policy above; verifying the HAR file itself exists
 * and is readable is `browser-har-replay.ts`'s job at actual replay time,
 * not this pre-flight evidence-sufficiency check's.
 */
function hasPositiveHarEntryCount(harEntryCount: unknown): boolean {
  return typeof harEntryCount === "number" && Number.isInteger(harEntryCount) && harEntryCount > 0;
}

export const DRIVER_EVIDENCE_POLICIES: Readonly<Record<string, DriverEvidencePolicy>> = {
  "recorded-http": {
    limitation: "no recorded provider interaction - driver evidence for recorded-http not satisfied",
    satisfied: (scenario) => scenario.runs.some((run) => run.interactions.length > 0),
  },
  "recorded-browser": {
    limitation: "no recorded HAR entries - driver evidence for recorded-browser not satisfied",
    satisfied: (scenario) =>
      scenario.runs.some(
        (run) =>
          run.environment?.network?.driver === "recorded-browser" &&
          hasPositiveHarEntryCount(run.environment.network.har_entry_count)
      ),
  },
};

/**
 * Evaluates `DRIVER_EVIDENCE_POLICIES` for `driver` against `scenario`. A
 * `driver` with no entry in the map (a future/unimplemented driver, or the
 * "(none declared)" legacy case) is treated as UNSATISFIED — the same
 * fail-closed posture `evaluateClaimEligibility`'s other conditions take:
 * absence of a policy is not evidence the bar was met, and
 * `assertSupportedEnvironmentDrivers` (bin/scenario-verify.ts) already
 * rejects any driver this build doesn't implement before this function would
 * ever be reached with one, so in practice `driver` here is always
 * `"recorded-http"`, `"recorded-browser"`, or `undefined` (no driver
 * declared on some run, already separately caught by condition (d)).
 */
export function driverEvidenceSatisfied(driver: string | undefined, scenario: DriverEvidenceScenario): boolean {
  if (driver === undefined) {
    return false;
  }
  const policy = DRIVER_EVIDENCE_POLICIES[driver];
  return policy?.satisfied(scenario) ?? false;
}
