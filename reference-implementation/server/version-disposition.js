/**
 * Server-derived `version_disposition` for record-version-churn rows.
 *
 * The owner-only `GET /_ref/records/version-stats` envelope returns numeric
 * churn facts (versions-per-record, risk level, risk reasons). This module adds
 * the *meaning* of a non-normal row — is it an active defect, expected
 * point-in-time history, an owner-reviewed residue, an actionable compaction
 * candidate, or a recurring snapshot stream? — as a reference-DERIVED label, so
 * the meaning lives in the auditable contract instead of the browser bundle.
 *
 * Why server-derived (not connector-authored): a connector must not be able to
 * self-declare its churn away. There is NO connector input to this derivation.
 * It reads only signals the reference controls:
 *   - the registered compaction-policy presence (passed in as a boolean the
 *     caller computes from `compact-record-history.mjs`'s COMPACTION_POLICIES
 *     registry — the same registry the maintenance tool treats as
 *     authoritative);
 *   - the point-in-time real-field split list (entity streams whose sampled
 *     metric was moved to an append-keyed sibling — never compactable);
 *   - the recurring point-in-time snapshot list (evolving local-agent session
 *     streams whose whole record is the moving observation — never compactable
 *     and never re-alarming on growth);
 *   - the owner-maintained reviewed-residue evidence (an explicit owner
 *     acknowledgement, timestamp-gated so post-review growth re-alarms).
 *
 * This is a label only: it never alters `risk_thresholds`, `risk_level`, or
 * `risk_reasons`. Those are computed exactly as before in
 * `classifyRecordVersionChurn` and are independent of disposition.
 *
 * This module is intentionally free of `pg`/`db` imports so it stays a pure,
 * in-process unit-testable classifier. The caller (record-version-stats.js)
 * supplies the `hasCompactionPolicy` boolean it resolved from the registry.
 */

/**
 * The five operator-meaningful dispositions. Only
 * `active_defect_or_unclassified` counts toward an operator "needs review"
 * signal; the other four are recognized, expected retained history.
 */
export const VERSION_DISPOSITIONS = Object.freeze([
  'active_defect_or_unclassified',
  'reviewed_historical_residue',
  'point_in_time_retained_history',
  'lossless_compaction_candidate',
  'recurring_point_in_time_snapshot',
]);

/**
 * Streams that version on a GENUINELY changing real field carried on the same
 * record as a stable identity, whose sampled metric has already been split into
 * its own append-keyed point-in-time stream. The retained entity history is the
 * sole surviving copy of those observations and is NEVER compactable (a
 * compaction policy would delete real history). These deliberately have NO
 * registered compaction policy; the regression guard in
 * `reference-implementation/test/compact-record-history.test.js` pins that.
 *
 * Connector id is matched against both the short id (`github`) and the
 * registry-URL form (`https://registry.pdpp.org/connectors/github`).
 */
export const POINT_IN_TIME_REAL_FIELD_STREAMS = Object.freeze([
  Object.freeze({ connector: 'github', stream: 'user', realField: 'follower / repo / gist counts' }),
  Object.freeze({ connector: 'slack', stream: 'channels', realField: 'num_members' }),
  Object.freeze({ connector: 'ynab', stream: 'accounts', realField: 'balance / cleared_balance / uncleared_balance' }),
]);

/**
 * Streams that legitimately re-version on every real session-growth pass. The
 * whole record (`message_count`, `last_event_at`, …) IS the evolving
 * observation, not a metric you can peel off onto a stable identity, so the
 * stream cannot be append-split. The connector mtime-gate prevents
 * byte-identical no-op re-emits, so each version is a distinct real snapshot.
 *
 * These streams DO have a registered compaction policy (the exact-stable-JSON
 * family in `compact-record-history.mjs` covers them) — that policy is the
 * regression safety net: if the mtime gate ever broke and produced
 * byte-identical no-op re-emits, the dry-run would surface `removableVersions
 * > 0` and a connector-level test would catch it. But for normal growth there
 * is nothing to remove, so the row must NOT read as an actionable compaction
 * candidate, and growth must NOT re-alarm it. This list therefore takes
 * precedence over both the reviewed-residue map and the compaction-policy
 * signal during derivation.
 *
 * (This is the correction to the proposal's draft rule "#5 = no registered
 * compaction policy": the named example streams `claude-code/sessions` and
 * `codex/sessions` both HAVE a policy. The distinguishing signal is explicit
 * membership in this list, evaluated with precedence — not policy absence.)
 *
 * Connector id is matched against the short id, the registry-URL form, and the
 * `local-device:` multi-device prefix.
 */
export const RECURRING_POINT_IN_TIME_SNAPSHOT_STREAMS = Object.freeze([
  Object.freeze({ connector: 'claude-code', stream: 'sessions' }),
  Object.freeze({ connector: 'codex', stream: 'sessions' }),
]);

/**
 * Per-stream review evidence: the ISO 8601 timestamp at which the owner
 * inspected a stream and confirmed it was expected residue. A row can only be
 * classified as `reviewed_historical_residue` when its `last_history_at` is at
 * or before this timestamp — if new history was written since the review, the
 * row re-alarms as a `lossless_compaction_candidate`.
 *
 * Keys are `"connector/stream"` in bare-id form. Values are ISO 8601 UTC.
 *
 * Adding an entry here is an explicit owner acknowledgement that (1) the
 * connector is fingerprint-correct, (2) the dry-run at review time showed
 * `removableVersions = 0`, and (3) any later history write is fresh churn that
 * must re-alarm.
 *
 * Every key here MUST also have a registered compaction policy.
 * `claude-code/sessions` is intentionally NOT here: it is a recurring
 * point-in-time snapshot (its growth is expected and not removable), so it is
 * classified by RECURRING_POINT_IN_TIME_SNAPSHOT_STREAMS instead, which is why
 * it stopped re-alarming on each new session.
 */
export const REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT = Object.freeze(
  new Map([
    ['usaa/accounts', '2026-06-05T13:57:05.707Z'],
    ['usaa/statements', '2026-06-05T13:57:05.707Z'],
    ['chase/statements', '2026-06-05T13:57:05.707Z'],
  ]),
);

// Registry-URL connector id → bare connector id (last path segment). Also
// strips the `local-device:` multi-device prefix so the point-in-time and
// recurring-snapshot lists match local-collector connections.
const REGISTRY_CONNECTOR_ID_RE = /\/connectors\/([^/]+)\/?$/;

/**
 * Normalize a connector_id to its bare short id for list lookups. Handles the
 * registry-URL form and the `local-device:` prefix. Returns null for a null
 * input.
 */
export function normalizeConnectorId(connectorId) {
  if (!connectorId) {
    return null;
  }
  const match = connectorId.match(REGISTRY_CONNECTOR_ID_RE);
  const bare = match ? match[1] : connectorId;
  return bare.startsWith('local-device:') ? bare.slice('local-device:'.length) : bare;
}

function isPointInTimeRealField(connector, stream) {
  return POINT_IN_TIME_REAL_FIELD_STREAMS.some(
    (entry) => entry.connector === connector && entry.stream === stream,
  );
}

function isRecurringSnapshot(connector, stream) {
  return RECURRING_POINT_IN_TIME_SNAPSHOT_STREAMS.some(
    (entry) => entry.connector === connector && entry.stream === stream,
  );
}

// ─── version_remediation: the orthogonal next-action axis ────────────────────
//
// `version_disposition` (above) answers "why does this row's retained history
// exist?". `version_remediation` answers the second, orthogonal question the
// records-page notice left open: "what does the operator do about it?". The two
// are genuinely independent — three of the live watch rows share the SAME
// disposition (`reviewed_historical_residue`) but need three different next
// actions — which is exactly why remediation is a second derived field, not a
// finer split of disposition. `classifyVersionDisposition` is unchanged here;
// remediation consumes its already-derived output plus the reference-maintained
// lists below.
//
// Like disposition, remediation has NO connector input. A connector that could
// declare its own remediation `none` could declare a needed fix away. The
// derivation reads only the server-derived disposition and these three lists.

/**
 * The four operator-meaningful remediations. Only the three non-`none` values
 * name a pending action that is NOT already covered by the dry-run command the
 * disposition surface renders.
 */
export const VERSION_REMEDIATIONS = Object.freeze([
  'none',
  'content_fingerprint_pending',
  'owner_migration_pending',
  'owner_retention_policy',
]);

/**
 * Streams whose byte churn is run-clock / blob-identity noise (RC4
 * re-encryption, regeneration timestamps) but whose owner-visible content is
 * invariant. They are fingerprint-correct on `fetched_at`, so the registered
 * compaction dry-run reports `removableVersions = 0` and frees nothing. The
 * real remediation is net-new CONNECTOR work — emitting a stable content
 * fingerprint (`pdf_text_sha256` + `pdf_page_count`) so the volatile
 * acquisition/blob fields can be excluded losslessly — tracked by a separate
 * change (`add-statement-content-fingerprint`). Naming this here lets the notice
 * say "compaction frees nothing yet; the connector fingerprint is the fix"
 * instead of flattening into "reviewed residue, safe to leave or compact."
 *
 * Connector id is matched against the bare short id after `normalizeConnectorId`
 * (registry-URL and `local-device:` forms collapse to it).
 */
export const CONTENT_FINGERPRINT_PENDING_STREAMS = Object.freeze([
  Object.freeze({ connector: 'chase', stream: 'statements' }),
  Object.freeze({ connector: 'usaa', stream: 'statements' }),
]);

/**
 * Streams whose retained entity history is the SOLE surviving copy of real
 * observations that must be migrated into their canonical append-keyed home
 * before the history could ever be collapsed. For `usaa/accounts` that is 11
 * pre-split balance observations that predate the `account_stats` split; the
 * forward fingerprint gate is lossless today (only `fetched_at` no-ops collapse,
 * so `--apply` would not destroy them right now), but the row carries a pending
 * owner-gated migration decision. Compaction is NOT the remediation here and
 * could destroy real history if attempted out of order — so this row must read
 * distinctly from a fingerprint-pending statement row even though both share the
 * `reviewed_historical_residue` disposition. The migration itself is a separate
 * owner-gated change (`migrate-usaa-pre-split-balances-to-account-stats`).
 */
export const OWNER_MIGRATION_PENDING_STREAMS = Object.freeze([
  Object.freeze({ connector: 'usaa', stream: 'accounts' }),
]);

/**
 * Recurring point-in-time snapshot streams whose only open lever is an owner
 * retention-policy decision — whether to BOUND an otherwise unbounded-growth
 * snapshot history (e.g. a single long-running `claude-code` session driving
 * nearly all the growth). This is not a defect; the owner may decline it. The
 * guard in `classifyVersionRemediation` requires the disposition to be
 * `recurring_point_in_time_snapshot` for a stream on this list to read
 * `owner_retention_policy`, making the invariant explicit and regression-pinned
 * (these lists are intentionally aligned with
 * RECURRING_POINT_IN_TIME_SNAPSHOT_STREAMS).
 */
export const OWNER_RETENTION_POLICY_STREAMS = Object.freeze([
  Object.freeze({ connector: 'claude-code', stream: 'sessions' }),
  Object.freeze({ connector: 'codex', stream: 'sessions' }),
]);

function isInStreamList(list, connector, stream) {
  return list.some((entry) => entry.connector === connector && entry.stream === stream);
}

/**
 * Derive the four-way `version_remediation` for one churn row from the row's
 * already-derived `version_disposition` and the reference-maintained stream
 * lists. NO connector-authored value participates.
 *
 * Inputs (all reference-controlled):
 *   - `connectorId`        : the row's connector_id (any id form);
 *   - `stream`             : the row's stream;
 *   - `versionDisposition` : the value `classifyVersionDisposition` already
 *     returned for this row (remediation never re-derives or contradicts it).
 *
 * Consistency precedence (first match wins), enforcing that remediation can
 * never disagree with disposition:
 *   1. retention-policy list membership AND disposition is
 *      `recurring_point_in_time_snapshot` → `owner_retention_policy`.
 *   2. else migration list membership → `owner_migration_pending`.
 *   3. else fingerprint list membership → `content_fingerprint_pending`.
 *   4. else `none`.
 *
 * Hard guards (independent of any list): an `active_defect_or_unclassified` or
 * `lossless_compaction_candidate` row is ALWAYS `none`. Its action is already
 * conveyed — review it, or run the dry-run command the disposition surface
 * renders — so a list entry must not override it to a pending remediation. (No
 * such stream is on a list today; the guard pins the invariant regardless.)
 */
export function classifyVersionRemediation({
  connectorId,
  stream,
  versionDisposition,
} = {}) {
  // A row whose action is already "review it" or "run the dry-run command"
  // never carries a pending remediation, regardless of list membership.
  if (
    versionDisposition === 'active_defect_or_unclassified'
    || versionDisposition === 'lossless_compaction_candidate'
  ) {
    return 'none';
  }

  const connector = normalizeConnectorId(connectorId);
  if (!connector) {
    return 'none';
  }

  if (
    versionDisposition === 'recurring_point_in_time_snapshot'
    && isInStreamList(OWNER_RETENTION_POLICY_STREAMS, connector, stream)
  ) {
    return 'owner_retention_policy';
  }
  if (isInStreamList(OWNER_MIGRATION_PENDING_STREAMS, connector, stream)) {
    return 'owner_migration_pending';
  }
  if (isInStreamList(CONTENT_FINGERPRINT_PENDING_STREAMS, connector, stream)) {
    return 'content_fingerprint_pending';
  }
  return 'none';
}

/**
 * Derive the five-way `version_disposition` for one churn row.
 *
 * Inputs (all reference-controlled — NO connector-authored value participates):
 *   - `connectorId`   : the row's connector_id (any id form);
 *   - `stream`        : the row's stream;
 *   - `lastHistoryAt` : ground-truth max(record_changes.emitted_at), or null;
 *   - `hasCompactionPolicy` : boolean the caller resolved from the registered
 *     COMPACTION_POLICIES registry (`findPolicy(connectorId, stream) != null`).
 *
 * Precedence (first match wins):
 *   1. recurring point-in-time snapshot (sessions) → never compactable, never
 *      re-alarms on growth. Checked first so its registered compaction policy
 *      does not pull it into the candidate bucket.
 *   2. point-in-time real-field split residual → never compactable.
 *   3. reviewed historical residue (policy + reviewed map + timestamp guard).
 *      Demotes to (4) when `last_history_at` is after the review timestamp or
 *      is unavailable (unverifiable guard → re-alarm rather than suppress).
 *   4. lossless compaction candidate (registered policy, redundant versions
 *      removable; the read-only dry-run is a real remediation).
 *   5. otherwise active defect or unclassified (the only "needs review" class).
 *
 * The numeric churn classification (risk_level / risk_reasons /
 * versions_per_record) is NOT consulted or altered here — disposition is a pure
 * label over the row's identity and history-evidence.
 */
export function classifyVersionDisposition({
  connectorId,
  stream,
  lastHistoryAt = null,
  hasCompactionPolicy = false,
} = {}) {
  const connector = normalizeConnectorId(connectorId);

  if (connector && isRecurringSnapshot(connector, stream)) {
    return 'recurring_point_in_time_snapshot';
  }
  if (connector && isPointInTimeRealField(connector, stream)) {
    return 'point_in_time_retained_history';
  }
  if (connector) {
    const key = `${connector}/${stream}`;
    const reviewedAt = REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT.get(key);
    if (reviewedAt !== undefined && lastHistoryAt !== null && lastHistoryAt <= reviewedAt) {
      // Ground-truth evidence shows no new history since the review.
      return 'reviewed_historical_residue';
    }
    // reviewedAt present but last_history_at absent / after review → fall
    // through to the candidate bucket (re-alarm), not silent suppression.
  }
  if (hasCompactionPolicy) {
    return 'lossless_compaction_candidate';
  }
  return 'active_defect_or_unclassified';
}
