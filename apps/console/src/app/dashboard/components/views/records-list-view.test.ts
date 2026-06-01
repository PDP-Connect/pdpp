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
const CHURN_SUMMARY_ELEMENT = /<summary[\s\S]*?Show streams/;
const CHURN_DELEGATES_TO_PURE_SUMMARY = /summarizeVersionChurn\(rows\)/;
const CHURN_RENDERS_ALL_ROWS = /buildChurnDrilldownRows\(rows\)[\s\S]*?drilldownRows\.map\(/;
const CHURN_HAS_TABLE_HEADERS =
  /Versions \/ record[\s\S]*?Current[\s\S]*?History[\s\S]*?Keys[\s\S]*?Last history write/;
const CHURN_PER_ROW_RISK_BADGE = /<ChurnRiskBadge risk=\{row\.risk\}/;
// Copy must frame churn as retained history, not current-data loss.
const CHURN_HISTORY_NOT_LOSS = /not current data loss/;

test("version-churn notice is a native details/summary disclosure, not a dead banner", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, CHURN_DETAILS_DISCLOSURE);
  assert.match(src, CHURN_SUMMARY_ELEMENT);
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
});

test("version-churn copy frames churn as retained history, not data loss", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, CHURN_HISTORY_NOT_LOSS);
});
