// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector-verification scenario format (v1).
 *
 * A scenario is a self-contained, offline-replayable capture of one or more
 * connector `collect()` runs: every HTTP request/response pair the run made,
 * plus what the run is expected to produce (per-stream record counts/ids/
 * content hashes and the final committed STATE). `verify.ts` replays a
 * scenario against the REAL connector collect path and proves the two match.
 *
 * Trust rules (enforced by src/scenario/validate.ts before any replay):
 * - a scenario with `capture.complete !== true` is rejected outright;
 * - a scenario with zero runs is rejected;
 * - the connector id in the scenario must match the connector being verified.
 * validate.ts validates SHAPE only for digests — it does not compare them
 * against the current tree. Digest COMPARISON is bin/scenario-verify.ts's
 * job: by default it REPORTS `captured_with` vs. the current subject's
 * digests (differing is expected and fine — that is what lets a scenario
 * serve as a refactor oracle); `--require-capture-source` restores strict
 * equality for exact-artifact reproduction. See `ScenarioCapturedWith`'s doc
 * comment below for the full rationale.
 */

export const SCENARIO_FORMAT = "pdpp.connector-scenario/1";

/**
 * `"non_loopback_contact_observed"` (repair wave 3A, P1-2) replaces
 * `"derived-from-real"` as the value `bin/scenario-record.ts` actually mints
 * — see this file's `ScenarioProviderContact.basis` doc comment for why: a
 * disclaimer printed BESIDE an overstrong enum value does not make the label
 * itself safe. `"derived-from-real"` is a provenance-and-authenticity claim
 * ("this evidence really came from the real provider") that nothing in this
 * harness currently verifies — no authority allowlist, no provider identity
 * check, nothing beyond "a completed request reached a non-loopback host".
 * `"non_loopback_contact_observed"` names exactly, and only, what was
 * mechanically observed. `"derived-from-real"` is kept in the union
 * PARSE-TOLERATED ONLY, so a scenario captured by an older recorder still
 * loads/validates — new captures must never mint it again.
 */
export type ScenarioEvidenceClass =
  | "synthetic-spike"
  | "non_loopback_contact_observed"
  | "derived-from-real"
  | "scrubbed-real";

/**
 * Mirrors the package's existing fixture privacy_class vocabulary (the
 * fixtures/<connector>/scrubbed convention) so a scenario capture can be
 * classified the same way any other on-disk fixture is. "local-only" is the
 * only class this tooling ever produces today.
 */
export type ScenarioPrivacyClass = "local-only" | "committable-scrubbed" | "committable-synthetic";

export interface ScenarioConnectorRef {
  /**
   * ADDITIVE — see `ScenarioCapturedWith`'s doc comment. Written once by
   * scenario-record and never recomputed; the CURRENT subject's digests are
   * computed fresh by scenario-verify every run and compared against this,
   * REPORTED (not failed) by default.
   */
  captured_with?: ScenarioCapturedWith;
  /**
   * DEPRECATED-BUT-TOLERATED (superseded by `captured_with.declaration_digest`
   * above — see that field's doc comment for why the old top-level digest
   * pair was replaced). sha256 (hex) of the connector's manifest JSON bytes
   * at capture time. Scenarios written before this repair still carry this
   * field; validate.ts's shape validation still accepts it, but
   * scenario-verify no longer hard-fails a mismatch here — that strict
   * behavior moved to `--require-capture-source` against `captured_with`.
   */
  declaration_digest?: string;
  id: string;
  /**
   * DEPRECATED-BUT-TOLERATED — see `declaration_digest`'s doc comment above
   * and `captured_with.source_digest` above. sha256 (hex) over the connector
   * directory's file list and contents at capture time (sorted relative
   * paths + per-file sha256).
   */
  source_digest?: string;
  /** Recorder tool version string (e.g. "scenario-record/1"). */
  tool_version?: string;
}

/**
 * The declaration/source digests of the connector AS IT WAS AT CAPTURE TIME
 * — written once by scenario-record and never recomputed. This is
 * deliberately separate from "the current subject's digest" (which
 * scenario-verify computes fresh, every run, against whatever code is on
 * disk right now): the two are expected to legitimately DIFFER whenever a
 * scenario is replayed as a refactor oracle (the entire point of capturing a
 * scenario once and reusing it across later code changes). Splitting the
 * model this way replaces the old `ScenarioConnectorRef.declaration_digest`/
 * `source_digest` pair's strict-equality drift check (which rejected ANY
 * code change since capture, defeating replay-as-refactor-oracle) with a
 * REPORTED comparison by default, and strict equality only when
 * `--require-capture-source` explicitly asks for exact-artifact
 * reproduction.
 */
export interface ScenarioCapturedWith {
  /** sha256 (hex) of the connector's manifest JSON bytes at capture time —
   *  the `captured_with` sibling of the deprecated top-level
   *  `ScenarioConnectorRef.declaration_digest`. */
  declaration_digest?: string;
  /** sha256 (hex) over the connector source directory at capture time — the
   *  `captured_with` sibling of the deprecated top-level
   *  `ScenarioConnectorRef.source_digest`. */
  source_digest?: string;
}

/**
 * Observed provider contact during recording, computed mechanically by the
 * recorder from the requests it actually saw. This is what grounds
 * evidence_class: a capture whose contact was loopback-only (or that ran via
 * a dev/test entrypoint override) is `synthetic-spike` by construction —
 * `non_loopback_contact_observed` requires observed non-loopback provider
 * contact.
 */
export interface ScenarioProviderContact {
  /** Distinct request origins observed (scheme://host[:port]). */
  authorities: string[];
  /**
   * ADDITIVE — names what "non-loopback contact" actually proves, since
   * `evidence_class: "non_loopback_contact_observed"` is grounded ENTIRELY in
   * this struct and a plainer enum label would risk reading as a stronger
   * claim than the mechanics support (see `ScenarioEvidenceClass`'s doc
   * comment — that is exactly why the class itself is named this, not
   * `derived-from-real`). `"non_loopback_contact_observed"` is the one value
   * this recorder can currently produce: it observed at least one completed
   * request to a non-loopback authority against the connector's own
   * registered entrypoint. It does NOT mean the provider's identity was
   * authenticated, that the authority is the provider's documented/expected
   * host, or that any authority allowlist was enforced — see
   * bin/scenario-record.ts's printed evidence_class line for the explicit
   * caveat this field backs. Absent only for a scenario captured before this
   * field existed.
   */
  basis?: "non_loopback_contact_observed";
  completed_requests: number;
  /** True when every observed origin resolved to loopback (127.0.0.0/8,
   *  ::1, localhost). */
  loopback_only: boolean;
  observed: boolean;
}

export interface ScenarioCapture {
  captured_at: string;
  /**
   * False when the recorder failed to persist part of the capture: a storage
   * error, a request still in flight at subprocess exit (pending-request
   * counter), or a truncated response body. A scenario with complete:false is
   * REJECTED by validate.ts — it must never back a replay claim.
   */
  complete: boolean;
  evidence_class: ScenarioEvidenceClass;
  privacy_class: ScenarioPrivacyClass;
  provider_contact?: ScenarioProviderContact;
  recorder_version: string;
}

/**
 * A query-parameter normalizer: a param name the matcher excludes from its
 * strict match key, and why. Every normalizer entry is capture-time evidence
 * of a real accommodation the recorder or matcher needed.
 */
export interface ScenarioNormalizer {
  param: string;
  reason: string;
}

/**
 * A recorded variable binding: a request query param whose raw value is NOT
 * persisted because it was provider-issued (its value appeared at
 * `json_path` in the response body of the earlier interaction `source_seq`).
 * Replay resolves the expected value from the response it actually served
 * for `source_seq` and requires the live request's param to equal it. This
 * replaces raw retention of provider-issued values: provenance is not
 * non-secrecy — access tokens and signed URLs are provider-issued too, so
 * raw values never persist in the request record.
 */
export interface ScenarioBinding {
  json_path: string;
  param: string;
  source_seq: number;
}

export interface ScenarioRequest {
  body_sha256?: string;
  method: string;
  origin: string;
  path: string;
  /** Sorted (by key, then value) [name, value][] pairs. Credential-like
   *  params are never present here: provider-issued ones become `bindings`
   *  entries on the interaction; client-secret ones are stripped and listed
   *  under scenario `normalizers`. */
  query: [string, string][];
}

/** Response headers the recorder retains, allowlisted to the ones connector
 *  control flow legitimately depends on (retry-after, etag, last-modified,
 *  link, x-ratelimit-*). Everything else is dropped at capture time. */
export type ScenarioResponseHeaders = [string, string][];

export interface ScenarioResponse {
  body: unknown;
  content_type?: string;
  headers?: ScenarioResponseHeaders;
  status: number;
  /** True when the stored body was cut at the recorder's size cap. A
   *  truncated response forces capture.complete = false. */
  truncated?: boolean;
}

export interface ScenarioInteraction {
  bindings?: ScenarioBinding[];
  request: ScenarioRequest;
  response: ScenarioResponse;
  /** 1-based order the recorder observed this interaction within its run,
   *  assigned at REQUEST INITIATION (not response completion) so concurrent
   *  requests keep call order. */
  seq: number;
}

/**
 * A single Collection Profile INTERACTION prompt/response pair, captured
 * during a live `scenario-record` run and replayed scripted by
 * `scenario-verify`. Distinct from `ScenarioInteraction` above (which is an
 * HTTP request/response pair) — this is a connector-runtime protocol
 * INTERACTION (src/connector-runtime-protocol.ts's `EmittedMessage` variant
 * with `type: "INTERACTION"`) answered over stdin as an `INTERACTION_RESPONSE`.
 *
 * `prompt` is the INTERACTION message the connector emitted, minus the
 * volatile `request_id` field (a fresh id is minted per run by the
 * connector-runtime and is not stable across record vs. replay). `response`
 * is the answer that was actually sent back (the same shape connector-dev.ts
 * writes to the subprocess's stdin as INTERACTION_RESPONSE, minus
 * `request_id`/`type` — those are re-attached by the replaying side using
 * THAT run's own request_id, matching the same seq-ordered pairing
 * `scenario-verify` uses for HTTP interactions).
 *
 * SECURITY NOTE — DEFAULT-REDACT, OPT-IN VERBATIM (P2-1, repair wave 3A):
 * `kind: "otp"` prompts are redacted BY DEFAULT, exactly like `kind:
 * "credentials"` below — `scenario-record` stores only `{status, redacted:
 * true}` for an OTP response unless the caller explicitly passes
 * `bin/scenario-record.ts`'s `--persist-otp` flag. This REPLACES the
 * harness's earlier unconditional "OTP is always verbatim" behavior (the
 * third independent review's P2-1 finding: OTP codes being single-use/
 * expired by replay time is a property of the SPECIFIC PROVIDER's OTP
 * implementation, not something this harness can verify generically — a
 * long-lived or reusable "OTP" from a nonstandard provider would have made
 * the old unconditional default an actual secret leak). `--persist-otp` asks
 * the caller to explicitly assert that single-use/expired semantics for the
 * provider being captured, printing a one-line justification requirement
 * when passed. When persisted, `response.value`/`response.data` holds the
 * code exactly as the developer entered it, replayed verbatim by
 * `scenario-verify`. Scenarios are local-only (`ScenarioCapture.privacy_class`)
 * and MUST NOT be committed or shared without a scrub pass regardless of
 * this flag.
 *
 * `kind: "credentials"` prompts are NEVER persisted, unconditionally — no
 * flag opts a credentials response into verbatim retention.
 * scenario-record stores only `{status, redacted: true}` for a credentials
 * response — no `value`/`data`, since a credentials prompt is exactly the
 * kind of long-lived secret verbatim retention would be unsafe for.
 * `scenario-verify` refuses to replay a `redacted: true` interaction outright
 * (see bin/scenario-verify.ts) — a redacted scenario is not
 * replayable-as-recorded; it must be re-recorded (with `--persist-otp` for
 * an OTP prompt, if the caller has made that assertion) or answered live.
 */
export interface ScenarioUserInteraction {
  /** The INTERACTION message the connector emitted, with `request_id` removed. */
  prompt: {
    kind: string;
    message: string;
    schema?: Record<string, unknown>;
    timeout_seconds?: number;
  };
  /** The INTERACTION_RESPONSE payload that was sent back, with `request_id`
   *  and `type` removed (both are re-derived at replay time). */
  response: {
    data?: Record<string, string>;
    error?: { message: string };
    /** True when this response's real value/data was withheld at capture
     *  time because `prompt.kind === "credentials"` (see this interface's
     *  doc comment) — `data`/`value` are always absent when this is true.
     *  Additive field; absent (or false) means "not redacted", the
     *  pre-existing behavior for every other prompt kind. */
    redacted?: boolean;
    status: "success" | "cancelled" | "error";
    value?: string;
  };
  /** 1-based order the recorder observed this interaction within its run,
   *  independent of `ScenarioInteraction.seq` (HTTP interactions have their
   *  own separate sequence). */
  seq: number;
}

/** When present, replay patches Date.now()/new Date() in the subprocess to
 *  start from `fixed_now`, so wall-clock-dependent request planning is
 *  deterministic across record and replay. scenario-record stamps the run's
 *  actual start time here. */
export interface ScenarioClock {
  fixed_now: string;
}

export interface ScenarioRunStart {
  scope: unknown;
  state: unknown | null;
  /**
   * When set, verify.ts seeds this run's starting state from the ACTUAL
   * final state a prior verified run in the same scenario emitted (not from
   * `state` above, which is the originally-recorded seed — kept for
   * reference/debugging). Index into `scenario.runs`; must reference an
   * EARLIER run (validate.ts rejects forward/self references).
   */
  state_from_run?: number;
}

/**
 * RECORD FIELD DISPOSITION (P1-1, seventh review) — `ScenarioStreamExpectation`
 * is this oracle's RECORD/STATE projection (the "covered_elsewhere" half of
 * verify.ts's `TRACE_POLICY`; RECORD/STATE are never part of the separate
 * protocol_trace). For completeness, every field on
 * connector-runtime-protocol.ts's RECORD variant gets an explicit
 * disposition here, the same way `NormalizedTraceEntry`'s doc comment tables
 * the seven tracked completeness message kinds:
 *   - `stream`/`key` — compared-directly, via `ids` (this file, canonicalized
 *     by `canonicalRecordKey` in subprocess-fetch-preloads.ts).
 *   - `data` — compared-directly by content, via `record_sha256s`.
 *   - `op` — compared-directly, via `ops` above (index-aligned with `ids`).
 *   - `emitted_at` — EXCLUDED-VOLATILE. It is a wall-clock timestamp stamped
 *     once per run (connector-runtime.ts's `makeEmitRecord` closes over one
 *     `emittedAt` value for the whole run), not a per-record fact about what
 *     the connector actually collected — replaying the same interactions on
 *     a different wall-clock day legitimately produces a different
 *     `emitted_at` with zero change in collection correctness. Comparing it
 *     would make every scenario fail on the day after it was recorded for a
 *     reason that has nothing to do with the connector. This mirrors the
 *     NORMALIZATION list's timestamp-exclusion rule (this file, the
 *     `NormalizedTraceEntry` doc comment) — `emitted_at` is that rule's
 *     concrete example, called out there and restated here as the RECORD
 *     oracle's own explicit disposition, not merely implied by analogy.
 */
export interface ScenarioStreamExpectation {
  count: number;
  ids: string[];
  /**
   * MANDATORY (P1, eighth review — supersedes the P1-1/seventh-review
   * optional design). Each emitted RECORD's normalized `op`, index-aligned
   * with `ids`/`record_sha256s` — `"upsert"` or `"delete"`, matching
   * connector-runtime-protocol.ts's `EmittedMessage`'s RECORD variant (`op?:
   * "delete"`; absent on the wire normalizes to `"upsert"` here, since the
   * wire has no explicit upsert literal — see connector-runtime.ts's
   * `makeEmitRecord`, the only producer, which sets `op: "delete"` for a
   * tombstone and omits `op` entirely otherwise).
   *
   * REQUIRED, not optional: this format is unmerged and scenarios are
   * local-only (never committed, never shared — `ScenarioCapture.privacy_class`
   * is always `"local-only"` today), so there is no real legacy corpus a
   * migration tier would protect. Carrying an optional-with-bypass field
   * would leave a second, permanently-tolerated state ("scenario with no
   * ops") on top of the two real ones (upsert/delete) for zero corpus
   * benefit — one fewer state beats a migration tier here.
   * `validateScenario` (validate.ts) rejects a stream expectation missing
   * `ops`, misaligned in length with `ids`/`count`/`record_sha256s`, or
   * carrying a value outside the two literals, BEFORE any replay is
   * attempted — so a caller reaching `verifyStreamOps` (verify.ts) always has
   * a well-formed `ops` array to compare, unconditionally, no bypass branch.
   */
  ops: ("upsert" | "delete")[];
  /** sha256 of canonical-JSON (sorted keys) of each emitted RECORD's `data`,
   *  in the same order as `ids`. */
  record_sha256s: string[];
}

/**
 * A normalized, emission-order projection of one protocol-completeness
 * message a run emitted — the "did the connector honestly account for every
 * item it saw" truth PDPP connectors exist to prove, distinct from (and
 * layered on top of) the RECORD/STATE records-and-cursor oracle above. Seven
 * message shapes become a trace entry (this table, and `TRACE_POLICY` in
 * verify.ts, are the SINGLE machine-enforced source of truth for exactly
 * which of `EmittedMessage`'s members are tracked — see that const's doc
 * comment):
 *   - SKIP_RESULT ("skip_result"): a stream declared it could not account
 *     for something, plus (repair wave 3B) its optional `continuation` —
 *     SLVP §4.3's runtime-owned "more historical work remains" fact.
 *   - DETAIL_COVERAGE ("detail_coverage"): a stream's considered/covered/
 *     gap accounting for a hydration pass.
 *   - DETAIL_GAP ("detail_gap"): one bounded, retryable per-record gap,
 *     including (repair wave 4) its optional `detail`/`last_error`
 *     `network_pressure` evidence in privacy-safe normalized form.
 *   - DETAIL_GAP_ATTEMPTED ("detail_gap_attempted", repair wave 3B): a
 *     served recovery lease was attempted for a pending gap.
 *   - DETAIL_GAP_RECOVERED ("detail_gap_recovered", repair wave 3B): a
 *     previously-declared gap was honestly recovered.
 *   - DETAIL_GAPS_PAGE_REQUEST ("detail_gaps_page_request", repair wave 4):
 *     the runtime's own request for a page of pending recovery-eligible
 *     gaps — request_id/max_bytes/streams are all runtime- or
 *     connector-declared, no provider content.
 *   - the terminal DONE ("done"): final status, the aggregate
 *     `records_emitted` total (repair wave 4), plus, when present, the
 *     error's code/retryable/recovery fields and (repair wave 6) a digest of
 *     `error.message`.
 * PROGRESS is deliberately excluded — connector-runtime-protocol.ts's own
 * doc comment calls it a diagnostic/operator-legibility channel, not a
 * completeness claim, and RECORD/STATE stay in `ScenarioStreamExpectation`/
 * `final_state` above (this array is additive to that oracle, not a
 * replacement).
 *
 * EXCLUDED-BY-POLICY, NOT BY OVERSIGHT (repair wave 3B; now machine-enforced
 * by `TRACE_POLICY`'s `"unsupported_claim_withheld"` disposition, repair
 * wave 4 P1-2): ASSISTANCE and ASSISTANCE_STATUS
 * (connector-runtime-protocol.ts's `AssistanceRequest`/
 * `AssistanceCompletion`) are NOT tracked here, on the same "diagnostic
 * channel, not a completeness claim" footing as PROGRESS above — but unlike
 * PROGRESS, that is a deliberate SCOPE LIMIT this repair wave is flagging,
 * not a settled design call: assistance is the browser/human-in-the-loop
 * escalation surface (owner_action/progress_posture/attachments), and this
 * offline HTTP-replay oracle has no browser or auth driver to verify against
 * yet. A future browser-driven or auth-driver-driven scenario mode may need
 * to track these; until then, this trace format MUST NOT be read as implying
 * completeness proof for the assistance/escalation message class — a
 * connector could silently drop or fabricate an ASSISTANCE exchange and this
 * oracle would not notice. As of repair wave 4 (FIX 2d), a run that actually
 * OBSERVES one of these kinds no longer passes silently: verify.ts's
 * `observedUnsupportedEvidenceSurface` flags it, and
 * `evaluateClaimEligibility` (claims.ts) withholds the canonical
 * `recorded_replay` claim for that run's scenario, naming the reason.
 *
 * NORMALIZATION — fields deliberately DROPPED before an entry is captured,
 * because they are volatile (differ run-to-run for reasons that have
 * nothing to do with connector correctness) and would make an otherwise
 * byte-identical trace fail a naive equality check:
 *   - any request id (SKIP_RESULT/DETAIL_GAP/DETAIL_COVERAGE carry none on
 *     the wire today, but this rule generalizes if one is ever added);
 *   - `DetailGapNetworkPressure.attempt`/`retry_after_ms`/`safe_headers`
 *     (retry-attempt counters and wall-clock-derived retry hints — the
 *     CLASS of pressure is captured via `error_class`/`endpoint_route`/
 *     `method`/`status`, not the timing of a particular attempt);
 *   - any timestamp (none of these six message shapes carry one directly,
 *     but `RECORD.emitted_at` is the reason this rule is stated explicitly
 *     rather than left implicit — a future field must be evaluated against
 *     this same volatility test before being added to a trace entry);
 *   - request/response durations (not present on any of these six shapes
 *     today, called out for the same reason as timestamps above).
 * Everything else — reason/kind/stream identity, record/gap keys, gap
 * counts, DONE's status/error code/retryable/recovery_hint — is
 * completeness-bearing and kept verbatim.
 *
 * FIELD DISPOSITION TABLE (repair wave 3B, P1-3; extended repair wave 4,
 * P1-2 for `network_pressure`, `detail_gaps_page_request`, and DONE's
 * `records_emitted`) — every field on
 * `detail_gap`/`detail_gap_attempted`/`detail_gap_recovered`/
 * `skip_result.continuation`/`detail_gap.detail.network_pressure`/
 * `detail_gap.last_error.network_pressure`/`detail_gaps_page_request`/`done`
 * gets one of three dispositions, chosen from the REAL wire shape in
 * connector-runtime-protocol.ts, not guessed:
 *
 *   compared-directly — kept verbatim, byte-for-byte, in the trace entry.
 *     Reserved for values that are either (a) fixed protocol literals with
 *     no provider content (`retryable: true`, `status: "pending"`,
 *     `reference_only: true`), or (b) connector-declared/deterministic
 *     accounting numbers or boundary tokens that carry no raw provider
 *     payload (`considered`/`covered`/`boundary`/`slice_start`/`slice_end`/
 *     `records_emitted` — see below).
 *   digested — replaced with a PRESENCE flag plus a full sha256 (hex) of the
 *     canonical-JSON value (see `digestTraceValue` in verify.ts). Reserved
 *     for values that are opaque, provider-issued, or provider-shaped and
 *     therefore MAY carry raw provider data (a gap_id or lease_id could be a
 *     provider's own message/thread id; a list_cursor is an opaque provider
 *     pagination token; a detail_locator can carry arbitrary provider-shaped
 *     lookup fields; `network_pressure.endpoint_route` is a request PATH that
 *     may embed provider-shaped identifiers). A digest still lets
 *     `verifyTrace` catch a value SUBSTITUTION (mutation test (f)) without
 *     the scenario file (which IS committable-scrubbed material in some
 *     paths) ever retaining the value itself.
 *   excluded-volatile — dropped entirely, per the NORMALIZATION list above
 *     (retry-attempt counters, retry-after timing, safe_headers).
 *
 * | field                              | kind(s)                         | disposition       | reason |
 * |-------------------------------------|----------------------------------|--------------------|--------|
 * | continuation.boundary               | skip_result                      | compared-directly  | deterministic provider-cursor boundary token (e.g. IMAP UIDVALIDITY); no raw payload |
 * | continuation.considered             | skip_result                      | compared-directly  | connector-declared count, completeness-bearing |
 * | continuation.covered                | skip_result                      | compared-directly  | connector-declared count, completeness-bearing |
 * | continuation.owner                  | skip_result                      | compared-directly  | fixed literal `"runtime"` |
 * | continuation.remaining              | skip_result                      | compared-directly  | fixed literal `true` |
 * | continuation.slice_start            | skip_result                      | compared-directly  | deterministic provider-cursor position (e.g. IMAP UID), NOT wall-clock — verified against connectors/gmail/index.ts's only producer |
 * | continuation.slice_end              | skip_result                      | compared-directly  | same as slice_start |
 * | gap_id                               | detail_gap, attempted, recovered | digested           | opaque id; MAY be provider-issued (e.g. a provider message id used as gap key) |
 * | lease_id                             | detail_gap, attempted, recovered | digested           | opaque run-owned settlement token; treated as sensitive-shaped even though runtime-owned |
 * | list_cursor                          | detail_gap                       | digested           | opaque provider pagination cursor; MAY carry provider data |
 * | detail_locator                       | detail_gap                       | digested (whole)   | free-form `{kind, ...}` bag explicitly typed to carry provider lookup fields |
 * | retryable                            | detail_gap                       | compared-directly  | fixed protocol literal `true` |
 * | status                               | detail_gap                       | compared-directly  | fixed protocol literal `"pending"` |
 * | reference_only                       | detail_gap, attempted, recovered, detail_gaps_page_request | compared-directly | fixed protocol literal `true` |
 * | record_key                           | detail_gap, recovered            | compared-directly  | connector's own record key; already a first-class comparison elsewhere in this oracle (verifyStream ids) |
 * | reason                                | detail_gap                       | compared-directly  | closed enum of protocol reason codes, no provider content |
 * | parent_stream                        | detail_gap                       | compared-directly  | connector's own stream name, no provider content |
 * | network_pressure.error_class          | detail_gap (detail, last_error)  | compared-directly  | connector-classified error kind (connector-runtime-protocol.ts's `DetailGapNetworkPressure.error_class`), no provider content |
 * | network_pressure.status               | detail_gap (detail, last_error)  | compared-directly  | numeric HTTP status, no provider content |
 * | network_pressure.method               | detail_gap (detail, last_error)  | compared-directly  | fixed HTTP verb, no provider content |
 * | network_pressure.endpoint_route       | detail_gap (detail, last_error)  | digested           | a request PATH; MAY embed provider-shaped resource identifiers |
 * | network_pressure.attempt              | detail_gap (detail, last_error)  | excluded-volatile  | retry-attempt counter, per the NORMALIZATION list above |
 * | network_pressure.max_attempts         | detail_gap (detail, last_error)  | excluded-volatile  | retry-budget configuration, not a per-run completeness fact |
 * | network_pressure.retry_after_ms       | detail_gap (detail, last_error)  | excluded-volatile  | wall-clock-derived retry hint, per the NORMALIZATION list above |
 * | network_pressure.safe_headers         | detail_gap (detail, last_error)  | excluded-volatile  | per the NORMALIZATION list above |
 * | request_id                            | detail_gaps_page_request         | compared-directly  | run-scoped correlation id the runtime itself assigns deterministically per request, not provider content |
 * | max_bytes                             | detail_gaps_page_request         | compared-directly  | connector-declared page-size budget, no provider content |
 * | streams                               | detail_gaps_page_request         | compared-directly  | connector's own declared stream names, no provider content |
 * | records_emitted                       | done                              | compared-directly  | aggregate connector-declared record count — the ONE piece of aggregate truth this oracle pins that the per-stream `ScenarioStreamExpectation` oracle does not (that oracle counts per-declared-stream; `records_emitted` is the connector's own total, catching a stream the per-stream oracle never had an expectation for) |
 * | error.message (done)                  | done                              | digested           | required whenever `error` is present (connector-runtime-protocol.ts's DONE variant); MAY carry provider-shaped diagnostic text — repair wave 6 |
 * | recovery_hint.action (object form)     | skip_result, done                | compared-directly  | REQUIRED whenever the object form of recovery_hint is used (connector-runtime-protocol.ts); a connector-declared action name, no provider content — repair wave 6 |
 */

/**
 * Normalized `DetailGapNetworkPressure` (connector-runtime-protocol.ts) —
 * `error_class`/`status`/`method` compared-directly (connector-classified,
 * no provider content), `endpoint_route` digested (a request path that MAY
 * embed provider-shaped identifiers), `attempt`/`max_attempts`/
 * `retry_after_ms`/`safe_headers` excluded entirely (volatile — see the
 * field-disposition table above).
 */
export interface NormalizedNetworkPressure {
  /** Digest of `endpoint_route` — see field-disposition table above. */
  endpoint_route_digest: TraceValueDigest;
  error_class: string;
  method: string;
  status?: number;
}

export type NormalizedTraceEntry =
  | {
      kind: "skip_result";
      stream: string;
      reason: string;
      message: string;
      recovery_action?: string;
      recovery_retryable?: boolean;
      continuation?: {
        boundary: string;
        considered: number;
        covered: number;
        owner: "runtime";
        remaining: true;
        slice_start: number;
        slice_end: number;
      };
    }
  | {
      kind: "detail_coverage";
      stream: string;
      state_stream: string;
      required_keys: Array<string | number>;
      hydrated_keys: Array<string | number>;
      gap_keys?: Array<string | number>;
      optional_skip_keys?: Array<string | number>;
      considered?: number;
      covered?: number;
    }
  | {
      kind: "detail_gap";
      stream: string;
      parent_stream?: string;
      record_key: string | number;
      reason: "rate_limited" | "retry_exhausted" | "temporary_unavailable" | "upstream_pressure";
      status: "pending";
      retryable: true;
      reference_only: true;
      detail_class?: string;
      detail_http_status?: number;
      /** Normalized `detail.network_pressure` — see field-disposition table above. */
      detail_network_pressure?: NormalizedNetworkPressure;
      last_error_class?: string;
      last_error_http_status?: number;
      last_error_message?: string;
      /** Normalized `last_error.network_pressure` — see field-disposition table above. */
      last_error_network_pressure?: NormalizedNetworkPressure;
      /** Digest of `detail_locator` (whole object) — see field-disposition table above. */
      detail_locator_digest?: TraceValueDigest;
      /** Digest of `gap_id` — see field-disposition table above. */
      gap_id_digest?: TraceValueDigest;
      /** Digest of `lease_id` — see field-disposition table above. */
      lease_id_digest?: TraceValueDigest;
      /** Digest of `list_cursor` — see field-disposition table above. */
      list_cursor_digest?: TraceValueDigest;
    }
  | {
      kind: "detail_gap_attempted";
      stream: string;
      reference_only: true;
      /** Digest of `gap_id` — see field-disposition table above. */
      gap_id_digest: TraceValueDigest;
      /** Digest of `lease_id` — see field-disposition table above. */
      lease_id_digest: TraceValueDigest;
    }
  | {
      kind: "detail_gap_recovered";
      stream: string;
      reference_only: true;
      record_key?: string | number;
      /** Digest of `gap_id` — see field-disposition table above. */
      gap_id_digest: TraceValueDigest;
      /** Digest of `lease_id` — see field-disposition table above, omitted when the message carried none. */
      lease_id_digest?: TraceValueDigest;
    }
  | {
      kind: "detail_gaps_page_request";
      request_id: string;
      reference_only: true;
      max_bytes?: number;
      streams?: readonly string[];
    }
  | {
      kind: "done";
      status: "succeeded" | "failed";
      /** Aggregate connector-declared total emitted record count — see
       *  field-disposition table above for why this is the one aggregate
       *  fact this trace pins that the per-stream oracle doesn't. */
      records_emitted: number;
      error_code?: string;
      error_retryable?: boolean;
      /** Digest of `error.message` — see field-disposition table above
       *  (repair wave 6, P2-2 duty 2). */
      error_message_digest?: TraceValueDigest;
      error_recovery_action?: string;
      error_recovery_retryable?: boolean;
    };

/**
 * A digested (PRESENCE + full sha256) stand-in for a trace field this oracle
 * must not retain verbatim — see `NormalizedTraceEntry`'s field-disposition
 * table above and `digestTraceValue` (verify.ts) for how it is computed.
 * `present: false` means the source message carried no value for this field
 * at all (distinguishing "absent" from "present but empty string", which
 * digest to different hashes anyway, but `present` keeps the distinction
 * legible without decoding the digest).
 *
 * Repair wave 4 (P2-2): `sha256` is the FULL sha256 hex digest of the
 * value's canonical-JSON form (`hashCanonicalJson`, local-device-envelope.ts
 * — the same routine record-content hashing uses), replacing the previous
 * 8-hex-char `JSON.stringify`-based prefix. `JSON.stringify` is not
 * canonical (key order is insertion order, not sorted), and an 8-hex-char
 * (32-bit) prefix carries non-negligible collision risk across a large
 * corpus of distinct opaque provider ids — see verify.ts's `digestTraceValue`
 * doc comment for the full rationale.
 */
export interface TraceValueDigest {
  present: boolean;
  /** Full sha256 (hex) of canonical-JSON(value). Omitted when `present` is false. */
  sha256?: string;
}

export interface ScenarioRunExpected {
  final_state: unknown;
  /**
   * ADDITIVE — optional so every scenario captured before this field existed
   * still validates and replays exactly as before. When present, `verify.ts`
   * compares the ACTUAL run's normalized trace (built the same way
   * scenario-record builds it) against this array, in emission order, and
   * reports a `trace_mismatch` VerifyFailure naming the first divergence.
   * Absent means "this scenario predates trace capture, or genuinely emitted
   * none of the six tracked message kinds" — `scenario-verify` prints
   * "protocol trace: not captured (legacy scenario)" rather than silently
   * treating a missing array as an empty (and therefore vacuously
   * satisfied) expectation.
   */
  protocol_trace?: NormalizedTraceEntry[];
  records: Record<string, ScenarioStreamExpectation>;
}

/**
 * ADDITIVE, modality-neutral envelope (one field, not a framework): what
 * transport this run's evidence was captured/replayed over. Today the only
 * driver this tooling implements is `"recorded-http"` (the HTTP request/
 * response capture-and-replay this whole module documents) — a future
 * browser-driven or subprocess-driven capture mode would add its own driver
 * literal here rather than inventing a parallel envelope. `[k: string]:
 * unknown` lets a later driver attach its own driver-specific fields
 * (e.g. a browser driver's viewport/profile info) without another format
 * version bump; `scenario-verify` only ever reads `network.driver`.
 */
export interface ScenarioRunEnvironment {
  network?: { driver: "recorded-http" };
  [k: string]: unknown;
}

export interface ScenarioRun {
  clock?: ScenarioClock;
  /**
   * ADDITIVE — see `ScenarioRunEnvironment`'s doc comment. Absent for any
   * scenario captured before this field existed; `scenario-verify` treats an
   * absent environment as "no modality claim made" (neither accepted nor
   * rejected) rather than defaulting it to `recorded-http` on the run's
   * behalf.
   */
  environment?: ScenarioRunEnvironment;
  expected: ScenarioRunExpected;
  interactions: ScenarioInteraction[];
  start: ScenarioRunStart;
  /**
   * Recorded Collection Profile INTERACTION prompt/response pairs for this
   * run, in the order the connector emitted them. Optional/absent for any
   * scenario captured before this field existed, or for a run that emitted
   * no INTERACTION at all — `scenario-verify` treats an absent array the
   * same as an empty one (zero interactions to replay).
   */
  user_interactions?: ScenarioUserInteraction[];
}

export interface ConnectorScenario {
  capture: ScenarioCapture;
  connector: ScenarioConnectorRef;
  format: typeof SCENARIO_FORMAT;
  normalizers?: ScenarioNormalizer[];
  runs: ScenarioRun[];
}
