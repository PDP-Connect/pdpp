// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * canary/manifest
 *
 * The pre-registered metric manifest: its schema, its validation, and the
 * pure predicate evaluator that decides pass/fail.
 *
 * Why this file exists
 * --------------------
 * D15 says pre-register each step's canary metrics BEFORE deploying it,
 * because "post-hoc success criteria are how 'green' claims died in this
 * program". A criterion invented after seeing the number is not a check; it
 * is a rationalization with a number attached.
 *
 * The mechanism that makes pre-registration real is *separation in time*:
 * the manifest is parsed, validated, and frozen BEFORE the deploy, and the
 * evaluator here can only compare a `before` value to an `after` value using
 * a predicate that was already written down. Nothing in this module can read
 * the result and then choose the rule. It has no I/O at all — that is the
 * point, and it is why the harness's judgment lives here rather than beside
 * the shell commands that collect the numbers.
 *
 * The safety property this module owns
 * ------------------------------------
 * A canary that triggers a connector run costs the owner a real one-time
 * password on his phone. OTP-gated connectors are refused at PARSE time, so a
 * denied run check cannot reach the deploy path even if a manifest asks for
 * it. It is a code-level gate, not a comment asking nicely.
 *
 * The refusal set is DERIVED fail-closed from connector manifests (see
 * `otp-posture.ts`) rather than hand-listed here. The hand-listed version had
 * already drifted — it missed `wholefoods`, which declares an OTP posture in
 * its own manifest — and a denylist that misses one connector is false
 * confidence. Derivation is asymmetric: a manifest can only add itself to the
 * refusal set, never remove itself, so this is strictly harder to disable at
 * 2am than the constant it replaces.
 */

import { deriveOtpDenylist } from "./otp-posture.ts";

/**
 * Connectors whose runs dispatch a real one-time password to the owner's
 * phone. Triggering these from an automated canary spends a physical,
 * rate-limited, human-attention-bearing resource, so the manifest parser
 * REFUSES them outright rather than warning.
 *
 * Computed once at module load: the value is a function of manifest facts on
 * disk, and the harness is a short-lived CLI, so a stale read is not a risk.
 * A failure to read the manifests THROWS rather than yielding an empty set —
 * an unknown world is a refused world.
 */
export const OTP_DENYLISTED_CONNECTORS: readonly string[] = deriveOtpDenylist();

/**
 * Comparison rules a pre-registered numeric check may declare.
 *
 * `must_not_increase` is the workhorse for damage counters: the honest
 * question after a deploy is rarely "is this number good" but "did my change
 * make it worse". It admits a decrease, which is what a real fix looks like.
 */
export type NumericPredicateKind =
  | "must_not_increase"
  | "must_not_decrease"
  | "must_equal"
  | "must_stay_zero"
  | "must_be_at_most"
  | "must_be_at_least";

export type TimestampPredicateKind = "must_not_advance";

export interface SqlScalarCheck {
  /** A failing check rolls the deploy back. Non-blocking checks only report. */
  readonly blocking: boolean;
  /** Required for the threshold/equality predicates; ignored otherwise. */
  readonly bound?: number;
  readonly description: string;
  readonly id: string;
  readonly kind: "sql_scalar";
  readonly predicate: NumericPredicateKind;
  /**
   * SQL producing a single row. Column 0 is the compared value.
   *
   * TEXT-TIMESTAMP TRAP: several columns that look temporal are TEXT
   * (`records.emitted_at`, `device_ingest_batch_outcomes.created_at` are both
   * `text` in the live schema). Postgres will happily compare TEXT to a cast
   * interval lexicographically and silently match the wrong rows: measured
   * live, an uncast `created_at > (now() - interval '1 hour')::text` returned
   * 208 rows where the cast form `(created_at)::timestamptz > now() - interval
   * '1 hour'` returned 8. A 26x overcount that still looks like a number.
   *
   * `requireExplicitCast` (default true) makes the parser reject a query that
   * compares such a column to an interval without an explicit `::timestamptz`.
   */
  readonly sql: string;
}

export interface SqlTimestampCheck {
  readonly blocking: boolean;
  readonly description: string;
  readonly id: string;
  readonly kind: "sql_timestamp";
  readonly predicate: TimestampPredicateKind;
  readonly sql: string;
}

export interface ContainerFactCheck {
  readonly blocking: boolean;
  readonly bound?: number;
  readonly description: string;
  readonly fact: "restart_count" | "running_image";
  readonly id: string;
  readonly kind: "container_fact";
  readonly predicate: NumericPredicateKind | "must_change";
}

export interface LogPatternCheck {
  readonly blocking: boolean;
  readonly description: string;
  readonly id: string;
  readonly kind: "log_pattern";
  /** Occurrences allowed in the post-deploy window. `0` means "must not appear". */
  readonly maxOccurrences: number;
  readonly pattern: string;
  readonly sinceSeconds: number;
}

export interface HttpHealthCheck {
  readonly blocking: boolean;
  readonly description: string;
  readonly expectStatus: number;
  readonly id: string;
  readonly kind: "http_health";
  readonly url: string;
}

export interface ConnectorRunCheck {
  readonly blocking: boolean;
  /** Connector instance id (`cin_...`) to trigger. */
  readonly connectionId: string;
  /**
   * The connector's slug, used for the OTP denylist decision. Required
   * precisely so the denylist cannot be dodged by supplying only an opaque
   * `cin_...` the parser cannot classify.
   */
  readonly connectorSlug: string;
  readonly description: string;
  readonly expectStatus: "succeeded";
  readonly id: string;
  readonly kind: "connector_run";
  readonly timeoutSeconds: number;
}

export type CanaryCheck =
  | SqlScalarCheck
  | SqlTimestampCheck
  | ContainerFactCheck
  | LogPatternCheck
  | HttpHealthCheck
  | ConnectorRunCheck;

export interface ArtifactAssertion {
  readonly description: string;
  readonly id: string;
  /**
   * Minimum match count. Assertions are the answer to "did the deploy
   * actually happen": production restarted onto the same tag once and the fix
   * was believed live for hours. A tag is a label; a grep is evidence.
   */
  readonly minCount: number;
  /** Path INSIDE the built image. */
  readonly path: string;
  readonly pattern: string;
}

export interface CanaryManifest {
  readonly artifactAssertions: readonly ArtifactAssertion[];
  readonly checks: readonly CanaryCheck[];
  readonly container: string;
  readonly description: string;
  readonly dockerfileTarget: string;
  readonly imageRepo: string;
  readonly imageTag: string;
  /** Digest-pinned base image. A floating base was a real suspected defect. */
  readonly nodeBaseImage: string;
  readonly postgresContainer: string;
  readonly step: string;
}

export class ManifestError extends Error {}

const NUMERIC_PREDICATES = new Set<string>([
  "must_not_increase",
  "must_not_decrease",
  "must_equal",
  "must_stay_zero",
  "must_be_at_most",
  "must_be_at_least",
]);

const BOUND_REQUIRED = new Set<string>(["must_equal", "must_be_at_most", "must_be_at_least"]);

/**
 * TEXT columns that look like timestamps. Comparing these to an interval
 * without an explicit cast is the silent-overcount trap documented above.
 */
const TEXT_TIMESTAMP_COLUMNS: readonly string[] = [
  "created_at",
  "emitted_at",
  "occurred_at",
  "started_at",
  "completed_at",
  "recorded_at",
];

/**
 * True when `sql` compares a known TEXT-timestamp column against a relative
 * time expression without casting it. Deliberately conservative: it only
 * fires when both an interval expression and an uncast column comparison are
 * present, so ordinary queries are not rejected for using the word `now()`.
 */
export function findUncastTextTimestampComparison(sql: string): string | null {
  const lowered = sql.toLowerCase();
  if (!lowered.includes("interval")) {
    return null;
  }
  for (const column of TEXT_TIMESTAMP_COLUMNS) {
    // Matches `created_at >` / `created_at <` etc. that is NOT preceded by a
    // cast-closing paren, i.e. `(created_at)::timestamptz >` is accepted.
    const uncast = new RegExp(`(?<!::[a-z]{0,20})\\b${column}\\s*[<>]`, "u");
    const cast = new RegExp(`${column}\\s*\\)?\\s*::\\s*(timestamptz|timestamp)`, "u");
    if (uncast.test(lowered) && !cast.test(lowered)) {
      return column;
    }
  }
  return null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ManifestError(`${field} must be a finite number`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ManifestError(`${field} must be a boolean`);
  }
  return value;
}

/**
 * Normalizes a connector slug for denylist comparison. Manifests in the wild
 * spell the same connector `usaa`, `USAA`, and `usaa_bank`; a denylist that
 * only catches the first spelling is decoration. Separators collapse so
 * `chase-bank` and `chase_bank` both resolve to a `chase` prefix.
 */
export function normalizeConnectorSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
}

/**
 * True when the slug names an OTP-gated connector. Matches the bare slug and
 * any `<slug>_suffix` form, so `chase_bank` is caught while an unrelated
 * connector like `chaseable` is not.
 */
export function isOtpDenylisted(slug: string): boolean {
  const normalized = normalizeConnectorSlug(slug);
  return OTP_DENYLISTED_CONNECTORS.some((denied) => normalized === denied || normalized.startsWith(`${denied}_`));
}

/** Fields every check kind shares, threaded through to each per-kind parser. */
interface CheckCommonFields {
  readonly blocking: boolean;
  readonly description: string;
  readonly id: string;
}

/**
 * Guards the TEXT-timestamp trap documented on `SqlScalarCheck.sql`: rejects
 * `sql` when it compares a known TEXT-timestamp column to an interval without
 * an explicit cast, unless the manifest opts out via `requireExplicitCast:false`.
 */
function guardUncastTextTimestamp(sql: string, raw: Record<string, unknown>, where: string): void {
  const requireExplicitCast = raw.requireExplicitCast !== false;
  if (!requireExplicitCast) {
    return;
  }
  const offender = findUncastTextTimestampComparison(sql);
  if (offender) {
    throw new ManifestError(
      `${where}: '${offender}' is TEXT in the live schema; comparing it to an interval without an explicit ::timestamptz cast silently matches the wrong rows (measured: 208 vs 8). Add the cast, or set requireExplicitCast:false to accept the risk deliberately.`
    );
  }
}

/** Parses a `sql_timestamp` check body once `sql` has already cleared the TEXT-timestamp guard. */
function parseSqlTimestampCheck(
  raw: Record<string, unknown>,
  where: string,
  common: CheckCommonFields,
  sql: string
): SqlTimestampCheck {
  const predicate = requireString(raw.predicate, `${where}.predicate`);
  if (predicate !== "must_not_advance") {
    throw new ManifestError(`${where}.predicate must be 'must_not_advance'`);
  }
  return { ...common, kind: "sql_timestamp", predicate, sql };
}

/** Parses a `sql_scalar` check body once `sql` has already cleared the TEXT-timestamp guard. */
function parseSqlScalarCheck(
  raw: Record<string, unknown>,
  where: string,
  common: CheckCommonFields,
  sql: string
): SqlScalarCheck {
  const predicate = requireString(raw.predicate, `${where}.predicate`);
  if (!NUMERIC_PREDICATES.has(predicate)) {
    throw new ManifestError(`${where}.predicate '${predicate}' is not a known numeric predicate`);
  }
  const check: SqlScalarCheck = {
    ...common,
    kind: "sql_scalar",
    predicate: predicate as NumericPredicateKind,
    sql,
    ...(raw.bound === undefined ? {} : { bound: requireNumber(raw.bound, `${where}.bound`) }),
  };
  if (BOUND_REQUIRED.has(predicate) && check.bound === undefined) {
    throw new ManifestError(`${where}.bound is required for predicate '${predicate}'`);
  }
  return check;
}

/** Parses either SQL-backed check kind, applying the shared TEXT-timestamp guard first. */
function parseSqlCheck(
  raw: Record<string, unknown>,
  where: string,
  common: CheckCommonFields,
  kind: "sql_scalar" | "sql_timestamp"
): SqlScalarCheck | SqlTimestampCheck {
  const sql = requireString(raw.sql, `${where}.sql`);
  guardUncastTextTimestamp(sql, raw, where);
  return kind === "sql_timestamp"
    ? parseSqlTimestampCheck(raw, where, common, sql)
    : parseSqlScalarCheck(raw, where, common, sql);
}

/** Parses a `container_fact` check: a fact name (restart count / running image) plus its predicate. */
function parseContainerFactCheck(
  raw: Record<string, unknown>,
  where: string,
  common: CheckCommonFields
): ContainerFactCheck {
  const fact = requireString(raw.fact, `${where}.fact`);
  if (fact !== "restart_count" && fact !== "running_image") {
    throw new ManifestError(`${where}.fact must be 'restart_count' or 'running_image'`);
  }
  const predicate = requireString(raw.predicate, `${where}.predicate`);
  if (predicate !== "must_change" && !NUMERIC_PREDICATES.has(predicate)) {
    throw new ManifestError(`${where}.predicate '${predicate}' is not valid for container_fact`);
  }
  return {
    ...common,
    fact,
    kind: "container_fact",
    predicate: predicate as NumericPredicateKind | "must_change",
    ...(raw.bound === undefined ? {} : { bound: requireNumber(raw.bound, `${where}.bound`) }),
  };
}

/** Parses a `log_pattern` check: a pattern, its occurrence bound, and the lookback window. */
function parseLogPatternCheck(raw: Record<string, unknown>, where: string, common: CheckCommonFields): LogPatternCheck {
  return {
    ...common,
    kind: "log_pattern",
    maxOccurrences: requireNumber(raw.maxOccurrences, `${where}.maxOccurrences`),
    pattern: requireString(raw.pattern, `${where}.pattern`),
    sinceSeconds: requireNumber(raw.sinceSeconds, `${where}.sinceSeconds`),
  };
}

/** Parses an `http_health` check: a URL and the status code that counts as healthy. */
function parseHttpHealthCheck(raw: Record<string, unknown>, where: string, common: CheckCommonFields): HttpHealthCheck {
  return {
    ...common,
    expectStatus: requireNumber(raw.expectStatus, `${where}.expectStatus`),
    kind: "http_health",
    url: requireString(raw.url, `${where}.url`),
  };
}

/**
 * Parses a `connector_run` check. Re-checks the OTP denylist at parse time
 * (see module doc): a denied run must never reach the deploy path.
 */
function parseConnectorRunCheck(
  raw: Record<string, unknown>,
  where: string,
  common: CheckCommonFields
): ConnectorRunCheck {
  const connectorSlug = requireString(raw.connectorSlug, `${where}.connectorSlug`);
  if (isOtpDenylisted(connectorSlug)) {
    throw new ManifestError(
      `${where}: connector '${connectorSlug}' is OTP-denylisted. Triggering it sends a real one-time password to the owner's phone. Denylist: ${OTP_DENYLISTED_CONNECTORS.join(", ")}.`
    );
  }
  return {
    ...common,
    connectionId: requireString(raw.connectionId, `${where}.connectionId`),
    connectorSlug,
    expectStatus: "succeeded",
    kind: "connector_run",
    timeoutSeconds: requireNumber(raw.timeoutSeconds, `${where}.timeoutSeconds`),
  };
}

function parseCheck(raw: Record<string, unknown>, index: number): CanaryCheck {
  const where = `checks[${index}]`;
  const kind = requireString(raw.kind, `${where}.kind`);
  const common: CheckCommonFields = {
    blocking: requireBoolean(raw.blocking, `${where}.blocking`),
    description: requireString(raw.description, `${where}.description`),
    id: requireString(raw.id, `${where}.id`),
  };

  if (kind === "sql_scalar" || kind === "sql_timestamp") {
    return parseSqlCheck(raw, where, common, kind);
  }
  if (kind === "container_fact") {
    return parseContainerFactCheck(raw, where, common);
  }
  if (kind === "log_pattern") {
    return parseLogPatternCheck(raw, where, common);
  }
  if (kind === "http_health") {
    return parseHttpHealthCheck(raw, where, common);
  }
  if (kind === "connector_run") {
    return parseConnectorRunCheck(raw, where, common);
  }

  throw new ManifestError(`${where}.kind '${kind}' is not a known check kind`);
}

/**
 * Parses and validates a manifest. Throws `ManifestError` on any violation:
 * a manifest that does not fully validate must not run, because a partially
 * understood pre-registration is a post-hoc criterion waiting to happen.
 */
export function parseManifest(input: unknown): CanaryManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ManifestError("manifest must be a JSON object");
  }
  const raw = input as Record<string, unknown>;
  const nodeBaseImage = requireString(raw.nodeBaseImage, "nodeBaseImage");
  if (!nodeBaseImage.includes("@sha256:")) {
    throw new ManifestError(
      "nodeBaseImage must be digest-pinned (contain '@sha256:'); a floating base image was a real suspected defect"
    );
  }

  const rawChecks = raw.checks;
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    throw new ManifestError("checks must be a non-empty array");
  }
  const checks = rawChecks.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ManifestError(`checks[${index}] must be an object`);
    }
    return parseCheck(entry as Record<string, unknown>, index);
  });

  const ids = new Set<string>();
  for (const check of checks) {
    if (ids.has(check.id)) {
      throw new ManifestError(`duplicate check id '${check.id}'`);
    }
    ids.add(check.id);
  }

  const rawAssertions = Array.isArray(raw.artifactAssertions) ? raw.artifactAssertions : [];
  if (rawAssertions.length === 0) {
    throw new ManifestError(
      "artifactAssertions must be non-empty: without a content grep inside the image, a deploy that never happened looks identical to one that did"
    );
  }
  const artifactAssertions = rawAssertions.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ManifestError(`artifactAssertions[${index}] must be an object`);
    }
    const assertion = entry as Record<string, unknown>;
    return {
      description: requireString(assertion.description, `artifactAssertions[${index}].description`),
      id: requireString(assertion.id, `artifactAssertions[${index}].id`),
      minCount: requireNumber(assertion.minCount, `artifactAssertions[${index}].minCount`),
      path: requireString(assertion.path, `artifactAssertions[${index}].path`),
      pattern: requireString(assertion.pattern, `artifactAssertions[${index}].pattern`),
    };
  });

  return {
    artifactAssertions,
    checks,
    container: requireString(raw.container, "container"),
    description: requireString(raw.description, "description"),
    dockerfileTarget: requireString(raw.dockerfileTarget, "dockerfileTarget"),
    imageRepo: requireString(raw.imageRepo, "imageRepo"),
    imageTag: requireString(raw.imageTag, "imageTag"),
    nodeBaseImage,
    postgresContainer: requireString(raw.postgresContainer, "postgresContainer"),
    step: requireString(raw.step, "step"),
  };
}

export interface CheckOutcome {
  readonly after: string | number | null;
  readonly before: string | number | null;
  readonly blocking: boolean;
  readonly description: string;
  readonly detail: string;
  readonly id: string;
  readonly kind: string;
  readonly passed: boolean;
}

interface PredicateVerdict {
  readonly detail: string;
  readonly passed: boolean;
}

/** `must_not_increase`: fails closed with no `before` value — an unproven non-increase is not a pass. */
function evaluateMustNotIncrease(before: number | null, after: number): PredicateVerdict {
  if (before === null) {
    return { detail: "no before value captured; cannot prove non-increase", passed: false };
  }
  return {
    detail: after <= before ? `${after} <= ${before}` : `increased ${before} -> ${after}`,
    passed: after <= before,
  };
}

/** `must_not_decrease`: fails closed with no `before` value — an unproven non-decrease is not a pass. */
function evaluateMustNotDecrease(before: number | null, after: number): PredicateVerdict {
  if (before === null) {
    return { detail: "no before value captured; cannot prove non-decrease", passed: false };
  }
  return {
    detail: after >= before ? `${after} >= ${before}` : `decreased ${before} -> ${after}`,
    passed: after >= before,
  };
}

/** `must_stay_zero`: passes only when `after` is exactly zero, regardless of `before`. */
function evaluateMustStayZero(after: number): PredicateVerdict {
  return { detail: after === 0 ? "0" : `expected 0, got ${after}`, passed: after === 0 };
}

/** `must_equal`: passes only when `after` matches the declared `bound` exactly. */
function evaluateMustEqual(after: number, bound: number | undefined): PredicateVerdict {
  return {
    detail: after === bound ? `= ${bound}` : `expected ${bound}, got ${after}`,
    passed: after === bound,
  };
}

/** `must_be_at_most`: passes only when `bound` is declared and `after` does not exceed it. */
function evaluateMustBeAtMost(after: number, bound: number | undefined): PredicateVerdict {
  return {
    detail: bound !== undefined && after <= bound ? `${after} <= ${bound}` : `expected <= ${bound}, got ${after}`,
    passed: bound !== undefined && after <= bound,
  };
}

/** `must_be_at_least`: passes only when `bound` is declared and `after` meets or exceeds it. */
function evaluateMustBeAtLeast(after: number, bound: number | undefined): PredicateVerdict {
  return {
    detail: bound !== undefined && after >= bound ? `${after} >= ${bound}` : `expected >= ${bound}, got ${after}`,
    passed: bound !== undefined && after >= bound,
  };
}

/**
 * Applies a numeric predicate. Pure: the same before/after always yields the
 * same verdict, which is what makes the pre-registration enforceable.
 */
export function evaluateNumericPredicate(
  predicate: NumericPredicateKind,
  before: number | null,
  after: number,
  bound: number | undefined
): PredicateVerdict {
  switch (predicate) {
    case "must_not_increase":
      return evaluateMustNotIncrease(before, after);
    case "must_not_decrease":
      return evaluateMustNotDecrease(before, after);
    case "must_stay_zero":
      return evaluateMustStayZero(after);
    case "must_equal":
      return evaluateMustEqual(after, bound);
    case "must_be_at_most":
      return evaluateMustBeAtMost(after, bound);
    case "must_be_at_least":
      return evaluateMustBeAtLeast(after, bound);
    default:
      return { detail: `unknown predicate ${String(predicate)}`, passed: false };
  }
}

/**
 * Timestamp non-advance. Compared as ISO-8601 strings, which sort
 * lexicographically iff they share a format — the harness reads them straight
 * from the same column, so they do. A null `after` with a non-null `before`
 * means the row vanished, which is a change and therefore a failure.
 */
export function evaluateTimestampPredicate(
  before: string | null,
  after: string | null
): { passed: boolean; detail: string } {
  if (before === null && after === null) {
    return { detail: "absent before and after", passed: true };
  }
  if (before === null) {
    return { detail: `appeared: null -> ${String(after)}`, passed: false };
  }
  if (after === null) {
    return { detail: `disappeared: ${before} -> null`, passed: false };
  }
  return {
    detail: after <= before ? `${after} <= ${before}` : `advanced ${before} -> ${after}`,
    passed: after <= before,
  };
}

/**
 * The rollback decision. Any BLOCKING failure rolls back; non-blocking
 * failures are reported and do not. Separated from the outcome list so the
 * rule is one readable line under test rather than a condition buried in the
 * deploy sequence.
 */
export function shouldRollback(outcomes: readonly CheckOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.blocking && !outcome.passed);
}
