/**
 * Source-text invariants for the records-list view.
 *
 * The view file is a JSX React component, so it cannot be imported as a
 * module in Node's test runner without a full JSX/React resolver. We verify
 * the critical structural properties by reading the source file directly.
 * Behavioural tests for the pure formatters live in connection-evidence.test.ts.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VIEW_FILE = `${HERE}records-list-view.tsx`;
const NEEDS_ATTENTION_LABEL_RE = /"Needs attention"/;
const DEGRADED_LABEL_RE = /label="Degraded"/;
const RUNNING_LABEL_RE = /"Running"/;
const STALE_LABEL_RE = /"Stale"/;
const NO_ACTIVE_RUNS_RETURN_RE = /return "No active runs"/;
const FAILING_RETURN_RE = /return "Failing"/;
const ALL_FRESH_RETURN_RE = /return "All fresh"/;
const STALE_OVER_SEVEN_DAYS_RETURN_RE = /return "Stale >7d"/;
const NO_SCHEDULER_RUN_RETURN_RE = /return "No scheduler run"/;
const IDLE_RETURN_RE = /return "Idle"/;
const NEEDS_ATTENTION_STATE_RE = /state === "needs_attention"/;
const BLOCKED_STATE_RE = /state === "blocked"/;
const DEGRADED_STATE_RE = /state === "degraded"/;
const FAILED_RUN_FALLBACK_RE = /!state && o\.lastRun\?\.status === "failed"/;
// The summary counting moved to the pure `connection-summary-stats` module so
// it can be unit-tested without rendering JSX. The view must delegate to it
// rather than re-deriving the counts inline.
const SUMMARY_MODULE_IMPORT_RE = /summarizeConnectionHealth/;
const INLINE_STALE_AXIS_RE = /axes\.freshness === "stale"/;
const INLINE_NEEDS_ATTENTION_RE = /state === "blocked" \|\| state === "needs_attention"/;

test("vital signs strip uses fixed dimension labels that never rotate based on counts", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // Fixed labels must be present (each represents one distinct dimension).
  assert.match(src, NEEDS_ATTENTION_LABEL_RE);
  // Degraded / cooling-off / stalled work has its own attention-visible stat
  // so the summary can never read all-zero attention while degraded cards show.
  assert.match(src, DEGRADED_LABEL_RE);
  assert.match(src, RUNNING_LABEL_RE);
  assert.match(src, STALE_LABEL_RE);
  // Dynamic-label helper functions that rotated labels based on counts must
  // not exist; they made the strip non-comparable across page refreshes.
  assert.doesNotMatch(src, NO_ACTIVE_RUNS_RETURN_RE);
  assert.doesNotMatch(src, FAILING_RETURN_RE);
  assert.doesNotMatch(src, ALL_FRESH_RETURN_RE);
  assert.doesNotMatch(src, STALE_OVER_SEVEN_DAYS_RETURN_RE);
  assert.doesNotMatch(src, NO_SCHEDULER_RUN_RETURN_RE);
  // The Idle health label must never appear in the list view.
  assert.doesNotMatch(src, IDLE_RETURN_RE);
});

test("sort key uses health projection state to surface attention-required connections", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // The sort key must check health state, not just run history.
  // needs_attention and blocked are the two states that require owner action
  // and must bubble to the top of the list.
  assert.match(src, NEEDS_ATTENTION_STATE_RE);
  assert.match(src, BLOCKED_STATE_RE);
  assert.match(src, DEGRADED_STATE_RE);
  // Run-history failure is only used as a fallback when no health projection
  // is present, not as the primary sort signal.
  assert.match(src, FAILED_RUN_FALLBACK_RE);
});

test("summary counts are delegated to the pure connection-summary-stats module", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // The view must consume the testable rollup helper, not re-derive counts.
  assert.match(src, SUMMARY_MODULE_IMPORT_RE);
  // The counting predicates must NOT be inlined in the JSX view anymore;
  // their behavior is owned and tested in connection-summary-stats.test.ts.
  assert.doesNotMatch(src, INLINE_STALE_AXIS_RE);
  assert.doesNotMatch(src, INLINE_NEEDS_ATTENTION_RE);
});

// ─── SLVP ordinal-label fallback ──────────────────────────────────────────
//
// When a user has multiple connections of the same connector type that are
// all unnamed (display_name equals the connector type name), simply removing
// the raw connectorInstanceId leaves them visually indistinguishable. The
// `labelConnections` helper assigns deterministic ordinal subtitles in that
// case so owner-facing rows remain distinguishable without exposing raw IDs.

const LABEL_CONNECTIONS_DEF = /function labelConnections\(/;
const LABEL_CONNECTIONS_APPLIED = /labelConnections\(overviews\)/;
const ORDINAL_SUFFIX_PATTERN = /connection \$\{rank \+ 1\}/;
const STABLE_SORT_BY_CONNECTION_ID = /connectionId\(a\)\.localeCompare\(connectionId\(b\)\)/;
const NO_RAW_INSTANCE_ID_IN_DISPLAY =
  /connectorInstanceId \? \(\s*<>\s*\{" "\}\s*·\s*<code[\s\S]*?>\{connectorInstanceId\}/;

test("labelConnections helper is defined in the view module", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, LABEL_CONNECTIONS_DEF);
});

test("labelConnections is applied to overviews before rendering", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, LABEL_CONNECTIONS_APPLIED);
});

test("labelConnections assigns ordinal subtitles for unnamed same-type groups", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ORDINAL_SUFFIX_PATTERN);
});

test("labelConnections sorts ordinals stably by connection ID", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, STABLE_SORT_BY_CONNECTION_ID);
});

test("records-list-view does not render raw connectorInstanceId in the caption", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // The view must never surface the raw `cin_*` ID as a visible label.
  assert.equal(NO_RAW_INSTANCE_ID_IN_DISPLAY.test(src), false);
});

// ─── Version-churn notice is an actionable disclosure ─────────────────────
//
// The owner observed the churn banner was a dead end. The notice must be a
// native <details>/<summary> disclosure (keyboard-activatable, no client JS)
// whose expanded body renders every supplied churn row, not a static banner
// showing only the highest-signal stream.

const CHURN_DETAILS_DISCLOSURE = /<details[\s\S]*?data-testid="version-churn-notice"/;
// The disclosure must be driven by a native <summary> (keyboard-activatable,
// no client JS) that carries a visible owner-facing action label. The label
// must read as an action ("Review version churn"), not a passive toggle, so the
// banner is unmistakably actionable rather than an inert warning.
const CHURN_SUMMARY_ELEMENT = /<summary[\s\S]*?data-testid="version-churn-review-action"/;
const CHURN_REVIEW_ACTION_LABEL = /Review version churn/;
// The banner must not regress to a dead JS click handler near the notice; the
// native <summary> does the toggling, so no onClick should appear on it.
const CHURN_NO_DEAD_CLICK_HANDLER = /version-churn-notice[\s\S]{0,400}onClick=/;
const CHURN_DELEGATES_TO_PURE_SUMMARY = /summarizeVersionChurn\(rows\)/;
const CHURN_RENDERS_ALL_ROWS = /buildChurnDrilldownRows\(rows\)[\s\S]*?drilldownRows\.map\(/;
const CHURN_HAS_TABLE_HEADERS =
  /Versions \/ record[\s\S]*?Current[\s\S]*?History[\s\S]*?Keys[\s\S]*?Last history write[\s\S]*?Dry-run command/;
const CHURN_PER_ROW_RISK_BADGE = /<ChurnRiskBadge risk=\{row\.risk\}/;
const CHURN_RENDERS_DRY_RUN_COMMAND = /row\.dryRunCommand/;
// Copy must frame churn as retained history, not current-data loss.
const CHURN_HISTORY_NOT_LOSS = /not current data loss/;

test("version-churn notice is a native details/summary disclosure, not a dead banner", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, CHURN_DETAILS_DISCLOSURE);
  assert.match(src, CHURN_SUMMARY_ELEMENT);
});

test("version-churn notice exposes a visible owner-facing 'Review version churn' action", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // The action label must be present (visible CTA), and it must live inside the
  // native <summary> so it is keyboard-activatable without any click handler.
  assert.match(src, CHURN_REVIEW_ACTION_LABEL);
  assert.match(src, CHURN_SUMMARY_ELEMENT);
  // Guard against regressing to a dead <div onClick>-style handler: the notice
  // must not wire a JS click handler on the banner; the <summary> does the work.
  assert.doesNotMatch(src, CHURN_NO_DEAD_CLICK_HANDLER);
});

test("version-churn notice delegates summary + rows to the pure module", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, CHURN_DELEGATES_TO_PURE_SUMMARY);
  assert.match(src, CHURN_RENDERS_ALL_ROWS);
});

test("version-churn drilldown surfaces the full operator-readable column set", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, CHURN_HAS_TABLE_HEADERS);
  assert.match(src, CHURN_PER_ROW_RISK_BADGE);
  assert.match(src, CHURN_RENDERS_DRY_RUN_COMMAND);
});

test("version-churn copy frames churn as retained history, not data loss", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, CHURN_HISTORY_NOT_LOSS);
});

// ─── Churn drilldown rows are themselves actionable ───────────────────────
//
// Expanding the disclosure is only half the journey. Each drilldown row must
// (a) link the connector/stream label to the owning connection's detail page
// so the operator can act on it, and (b) offer a one-gesture copy of the
// dry-run command rather than forcing a manual selection of a wrapping <code>.

const CHURN_ROW_LINKS_CONNECTION =
  /href=\{`\/dashboard\/records\/\$\{encodeURIComponent\(row\.connectorInstanceId\)\}`\}/;
const CHURN_COMMAND_HAS_COPY_BUTTON = /<CopyButton\s+ariaLabel=\{`Copy dry-run command for \$\{row\.label\}`\}/;
const IMPORTS_COPY_BUTTON = /import \{ CopyButton \} from "@pdpp\/operator-ui\/components\/copy-button"/;

test("churn drilldown rows link the stream label to the owning connection detail", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, CHURN_ROW_LINKS_CONNECTION);
});

test("churn dry-run command offers a one-gesture copy affordance", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, IMPORTS_COPY_BUTTON);
  assert.match(src, CHURN_COMMAND_HAS_COPY_BUTTON);
});

// ─── Persistent Add-source discoverability ────────────────────────────────
//
// Records/Sources is the owner home for data-source setup and monitoring. The
// first screen must stay light, but its persistent Add-source action routes to
// the Sources-owned add-source catalog where every connector can be searched and
// routed through the shared setup planner. It must not point at the AI-app
// connection page or directly at the device-exporter form.

const ADD_CONNECTION_HEADER_ACTION = /data-testid="add-connection-action"/;
const ADD_CONNECTION_HEADER_GATED_INTERACTIVE =
  /\{interactive \? \(\s*<Link[\s\S]*?data-testid="add-connection-action"/;
const ADD_CONNECTION_HEADER_TARGETS_ADD_SOURCE =
  /data-testid="add-connection-action"\s+href=\{routes\.section\.addSource\}/;
const ADD_SOURCE_LABEL = /Add source/;
const NO_RECORDS_SETUP_CATALOG_IMPORT = /connection-catalog/;
const NO_RECORDS_ADD_CONNECTION_GUIDANCE = /AddConnectionGuidance|source-setup-\$\{entry\.connectorKey\}/;
const NO_BLANKET_SYNC_NOW_PROMISE = /Click Sync now to pull fresh data/;
const QUALIFIED_SYNC_NOW = /Where a connector supports an owner-triggered pull, Sync now refetches it/;
const NO_DATA_SECTION_LOCAL_ONLY =
  /Click Sync now to pull initial data, or wait for a local-collector device to push its first records/;
const NO_DATA_SECTION_MIXED_POPULATION = /local-collector sources fill in when their device pushes/;
const RECORDS_ACTION_BANNER_RE = /function RecordsActionBanner\(\{ error, message \}/;
const RECORDS_PAGE_READS_SEARCH_PARAMS_RE = /searchParams\?: Promise<\{ error\?: string; message\?: string \}>/;
const RECORDS_PAGE_RENDERS_ACTION_BANNER_RE = /<RecordsActionBanner error=\{actionParams\.error\} message=\{actionParams\.message\} \/>/;

test("records list exposes a persistent Add-source header action", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ADD_CONNECTION_HEADER_ACTION);
  assert.match(src, ADD_SOURCE_LABEL);
});

test("records page renders action result banners from list redirects", async () => {
  const src = await readFile(`${HERE}../../records/page.tsx`, "utf8");
  assert.match(src, RECORDS_PAGE_READS_SEARCH_PARAMS_RE);
  assert.match(src, RECORDS_ACTION_BANNER_RE);
  assert.match(src, RECORDS_PAGE_RENDERS_ACTION_BANNER_RE);
});

test("persistent Add-source action is gated on interactive (no dead button in sandbox)", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ADD_CONNECTION_HEADER_GATED_INTERACTIVE);
});

test("persistent Add-source action targets the Sources add-source catalog", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ADD_CONNECTION_HEADER_TARGETS_ADD_SOURCE);
});

test("records list no longer owns connector setup catalog rendering", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.doesNotMatch(src, NO_RECORDS_SETUP_CATALOG_IMPORT);
  assert.doesNotMatch(src, NO_RECORDS_ADD_CONNECTION_GUIDANCE);
});

test("page header no longer promises every connection supports Sync now", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.doesNotMatch(src, NO_BLANKET_SYNC_NOW_PROMISE);
  assert.match(src, QUALIFIED_SYNC_NOW);
});

test("no-data section copy no longer treats local-collector push as the universal next step", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.doesNotMatch(src, NO_DATA_SECTION_LOCAL_ONLY);
  assert.match(src, NO_DATA_SECTION_MIXED_POPULATION);
});

// ─── Zero-record connection lifecycle: what it is + how to remove it ──────────
//
// Rows in "No data yet" are real connections (the catalog-vs-connection fix
// stopped catalog connectors from being materialized as phantom rows), so the
// copy must (a) keep a connector you have not connected pointed at Add
// connection, and (b) name the real removal path — owner-agent revoke (stops
// future collection) / delete (also erases records). Removal is owner-bearer
// only, so the copy directs the owner to their owner agent rather than implying
// a console click. These pin the meaning; they do not pin the exact prose.

// The no-data section description is sourced from a pure, testable helper rather
// than an inline ternary, so the lifecycle copy can be asserted directly.
const NO_DATA_SECTION_USES_HELPER = /description=\{resolveNoDataSectionDescription\(interactive\)\}/;
const NO_DATA_SECTION_HELPER_DEF = /function resolveNoDataSectionDescription\(interactive: boolean\): string/;
// A source you have not connected stays under Add source — so a no-data
// row is never read as "a connector I can choose".
const NO_DATA_SECTION_NAMES_CATALOG = /not connected stays under Add source/;
// The removal path names honest revoke-vs-delete semantics directed at the
// owner agent: revoke stops future collection, delete also erases records.
const NO_DATA_SECTION_NAMES_OWNER_AGENT = /owner agent/;
const NO_DATA_SECTION_NAMES_REVOKE = /revoke it \(stops future collection\)/;
const NO_DATA_SECTION_NAMES_DELETE = /delete it \(also erases its records\)/;
// The copy must not render a fake Remove/Delete-connection button: the browser
// session cannot call the owner-bearer revoke/delete routes.
const NO_DATA_SECTION_NO_FAKE_REMOVE_BUTTON = /data-testid="(remove|delete)-connection-action"/;

test("no-data section description is sourced from a pure, testable helper", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, NO_DATA_SECTION_HELPER_DEF);
  assert.match(src, NO_DATA_SECTION_USES_HELPER);
});

test("no-data section copy distinguishes a catalog connector from a registered connection", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, NO_DATA_SECTION_NAMES_CATALOG);
});

test("no-data section copy names the real owner-agent removal path with honest revoke/delete semantics", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, NO_DATA_SECTION_NAMES_OWNER_AGENT);
  assert.match(src, NO_DATA_SECTION_NAMES_REVOKE);
  assert.match(src, NO_DATA_SECTION_NAMES_DELETE);
});

test("no-data section copy does not render a console removal button that cannot exist", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // No fake Remove/Delete-connection action element is rendered in the view; the
  // copy directs the owner to their owner agent instead.
  assert.doesNotMatch(src, NO_DATA_SECTION_NO_FAKE_REMOVE_BUTTON);
});

// Connection-lifecycle objective #1: version churn should not feel like
// mystery data loss. Beyond framing it as retained history, the notice must
// tell the owner that the per-row command is the SAFE place to start — it is
// read-only, prints a plan, and changes nothing until re-run with --apply.
// Both claims are verified against compact-record-history.mjs (dry-run is the
// default; --apply backs up affected rows first).
const CHURN_DRY_RUN_SAFETY_TESTID = /data-testid="version-churn-dry-run-safety"/;
const CHURN_DRY_RUN_READ_ONLY = /read-only/;
const CHURN_DRY_RUN_NAMES_APPLY = /--apply/;

test("version-churn notice tells the owner the dry-run command is read-only and safe to start", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, CHURN_DRY_RUN_SAFETY_TESTID);
  assert.match(src, CHURN_DRY_RUN_READ_ONLY);
  assert.match(src, CHURN_DRY_RUN_NAMES_APPLY);
});

// ─── Disposition-honest version-churn banner ──────────────────────────────
//
// The product bug: the banner alarmed "Review version churn" even when every
// churning stream was already classified as expected retained point-in-time
// history. The notice must now be tone- and label-aware: it reads as a warning
// (amber, "Review version churn") only when something genuinely needs review,
// and informational ("View breakdown") otherwise. The summary module computes
// `needsReview`; the view must branch its tone and CTA on it rather than
// hardcoding the alarm.
const CHURN_BRANCHES_ON_NEEDS_REVIEW = /summary\.needsReview/;
const CHURN_CTA_HONEST_WHEN_CLASSIFIED = /needsReview \? "Review version churn →" : "View breakdown →"/;
// The disclosure must surface a per-row disposition so an operator can see
// which rows actually need review vs. which are expected history / compaction
// candidates — the in-table counterpart to the honest headline.
const CHURN_HAS_DISPOSITION_COLUMN = />\s*Disposition\s*</;
const CHURN_RENDERS_DISPOSITION_BADGE = /<ChurnDispositionBadge remediation=\{row\.remediation\}/;
const CHURN_DISPOSITION_NAMES_ALL_BUCKETS =
  /active_defect_or_unclassified:[\s\S]*?lossless_compaction_candidate:[\s\S]*?reviewed_historical_residue:[\s\S]*?point_in_time_retained_history:[\s\S]*?recurring_point_in_time_snapshot:/;

test("version-churn banner branches its tone and CTA on whether review is actually needed", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // The view consumes the module's needsReview verdict instead of always
  // alarming, and the collapsed CTA reflects it.
  assert.match(src, CHURN_BRANCHES_ON_NEEDS_REVIEW);
  assert.match(src, CHURN_CTA_HONEST_WHEN_CLASSIFIED);
});

test("version-churn disclosure surfaces a per-row disposition with all five buckets", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, CHURN_HAS_DISPOSITION_COLUMN);
  assert.match(src, CHURN_RENDERS_DISPOSITION_BADGE);
  // The badge metadata must name all five remediation buckets so none is
  // silently dropped from the operator's vocabulary.
  assert.match(src, CHURN_DISPOSITION_NAMES_ALL_BUCKETS);
});

// ─── version_remediation: the orthogonal next-action cue ───────────────────
//
// The disposition makes three watch rows read as "reviewed residue". The
// remediation cue is what splits them into three distinct next actions —
// fingerprint pending, migration pending, retention policy — so the notice is
// rational, not merely less scary. The view must render the server-derived cue
// (a chip + a guidance line), never re-derive it, and never let it change the
// needs-review headline.
const CHURN_RENDERS_REMEDIATION_CHIP = /<ChurnRemediationBadge[\s\S]*?action=\{row\.remediationAction\}/;
const CHURN_RENDERS_REMEDIATION_CHIP_LABEL = /label=\{row\.remediationChip\}/;
const CHURN_REMEDIATION_CHIP_GATED = /row\.remediationChip \?[\s\S]*?<ChurnRemediationBadge/;
const CHURN_RENDERS_REMEDIATION_GUIDANCE = /row\.remediationGuidance/;
const CHURN_REMEDIATION_GUIDANCE_TESTID = /data-testid="version-churn-remediation-guidance"/;
// The chip metadata must name all three actionable remediations so the
// fingerprint-pending vs. migration-pending vs. retention-policy distinction is
// present in the operator's vocabulary.
const CHURN_REMEDIATION_NAMES_ALL_ACTIONS =
  /content_fingerprint_pending:[\s\S]*?owner_migration_pending:[\s\S]*?owner_retention_policy:/;
// The chip is read from the server field, not re-derived in the browser.
const CHURN_REMEDIATION_FROM_SERVER_FIELD = /remediationAction: remediationForRow\(row\)/;

test("version-churn disclosure renders the per-row remediation chip from the server field", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, CHURN_RENDERS_REMEDIATION_CHIP);
  assert.match(src, CHURN_RENDERS_REMEDIATION_CHIP_LABEL);
  // The chip only renders when the server supplied a non-none remediation.
  assert.match(src, CHURN_REMEDIATION_CHIP_GATED);
  // All three actionable remediations are named in the chip metadata.
  assert.match(src, CHURN_REMEDIATION_NAMES_ALL_ACTIONS);
});

test("version-churn disclosure prefers the remediation guidance line for residue/snapshot rows", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // Both the command-bearing branch (reviewed residue) and the non-compactable
  // branch (recurring snapshot) surface the remediation guidance.
  assert.match(src, CHURN_RENDERS_REMEDIATION_GUIDANCE);
  assert.match(src, CHURN_REMEDIATION_GUIDANCE_TESTID);
});

test("version-churn remediation cue is read from the server field, not re-derived in the browser", async () => {
  // The view consumes buildChurnDrilldownRows, which reads remediationForRow —
  // a straight read of row.version_remediation. Pin that the drilldown builder
  // sources the chip from the server value rather than a browser classifier.
  const summarySrc = await readFile(`${HERE}../../lib/version-churn-summary.ts`, "utf8");
  assert.match(summarySrc, CHURN_REMEDIATION_FROM_SERVER_FIELD);
});
