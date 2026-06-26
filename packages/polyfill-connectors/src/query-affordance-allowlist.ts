/**
 * Explicit allowlist of query affordances that a first-party connector stream
 * intentionally does NOT declare, even though the field looks useful for
 * search, range filtering, time bucketing, or faceting.
 *
 * This backs the OpenSpec change `complete-connector-query-affordances`
 * (capability `polyfill-runtime`): "A readable field SHALL NOT be treated as
 * searchable, range-filterable, aggregatable, or facetable unless the manifest
 * declares that affordance or the field appears on an explicit justified
 * non-support list."
 *
 * The gate test (`query-affordance-manifest-honesty.test.ts`) cross-checks this
 * list against the manifest tree in BOTH directions every CI run:
 *   - a stream with a useful undeclared affordance that is NOT here fails the
 *     build (no silent affordance drift);
 *   - an allowlist entry whose affordance is ALSO declared in the manifest, or
 *     whose stream/field no longer exists, fails the build, forcing the stale
 *     entry to be removed.
 *
 * Adding an entry is a deliberate, reviewed act — it is the documented escape
 * hatch, not a default. The default is to declare the affordance.
 *
 * Keys are `${connectorKey}.${stream}.${field}.${affordance}` where
 * `connectorKey` is the manifest's canonical `connector_key` (hyphenated, e.g.
 * `claude-code`) and affordance is one of: `lexical`, `semantic`, `range`,
 * `group_by_time`, `group_by`.
 */

export type AffordanceJustification = string;

export const QUERY_AFFORDANCE_ALLOWLIST: Readonly<Record<string, AffordanceJustification>> = Object.freeze({
  // Uber trip addresses are owner-recognizable text but are intentionally not
  // exposed to lexical search. Pickup/dropoff locations are among the most
  // sensitive fields a trip carries; the connector author opts the owner out of
  // making them keyword-searchable by default. Driver/vehicle search is still
  // declared (less sensitive). Revisit only with an explicit owner-facing
  // privacy control.
  "uber.trips.pickup_address.lexical": "addresses intentionally non-searchable for privacy",
  "uber.trips.dropoff_address.lexical": "addresses intentionally non-searchable for privacy",

  // Integer epoch fields are valid range-filter candidates but the server
  // time-bucket aggregation contract (records.js: group_by_time requires a
  // string field with format date|date-time) rejects them. Declaring
  // group_by_time on an integer epoch would ship a manifest the aggregate
  // engine refuses at request time, so non-support is recorded instead.
  "claude-code.skills.mtime_epoch.group_by_time": "integer epoch, not a server-supported time-bucket schema",
  "claude-code.memory_notes.mtime_epoch.group_by_time": "integer epoch, not a server-supported time-bucket schema",
  "claude-code.slash_commands.mtime_epoch.group_by_time": "integer epoch, not a server-supported time-bucket schema",
  "codex.prompts.mtime_epoch.group_by_time": "integer epoch, not a server-supported time-bucket schema",
  "codex.skills.mtime_epoch.group_by_time": "integer epoch, not a server-supported time-bucket schema",

  // Snapshot / telemetry / operational streams: the field name reads as an
  // event time, but the stream is a balance/status snapshot or an operational
  // job, not an owner activity feed. Counting these records over their snapshot
  // time is misleading rather than useful. Range filtering is still declared
  // where present; only the time-bucket chart affordance is withheld.
  "chase.current_activity.posted_date.group_by_time":
    "account-activity snapshot; bucketing by posted date is not an owner event chart",
  "google-maps-data-portability.archive_jobs.start_time.group_by_time":
    "operational export-job timing, not an owner activity stream",
  "slack.user_groups.created_at.group_by_time":
    "workspace admin/membership stream; group-creation counts are not an owner activity chart",

  // YNAB category goal-snooze is a niche budgeting state timestamp, not an owner
  // activity axis; range filtering it is rarely meaningful.
  "ynab.categories.goal_snoozed_at.range": "category goal-snooze state timestamp; not a useful owner filter axis",

  // NOTE: `ynab.months.month` is intentionally NOT allowlisted. The affordance
  // table's audit framed it as a snapshot-period stop-condition, but the
  // connector already declares `group_by_time: ["month"]` (PR #29, "lights up
  // the Explore chart"). That is a deliberate, shipping affordance powering a
  // real UI surface; withholding it here would both contradict the manifest and
  // regress the chart. The declared-affordance path covers it.
});
