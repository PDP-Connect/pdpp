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

// ─── Persistent Add-connection discoverability ────────────────────────────
//
// The detailed add-connection guidance only renders in the empty / no-data
// sections, so an owner who already has connections had no visible path to add
// another (the "add a second Amazon" complaint). A persistent header action
// must always be present in the interactive list, pointing at the proven
// device-enrollment entry point. It is gated on `interactive` so the sandbox
// (which cannot create connections) does not show a dead button.

const ADD_CONNECTION_HEADER_ACTION = /data-testid="add-connection-action"/;
const ADD_CONNECTION_HEADER_GATED_INTERACTIVE =
  /\{interactive \? \(\s*<Link[\s\S]*?data-testid="add-connection-action"/;
const ADD_CONNECTION_HEADER_TARGETS_ENROLLMENT =
  /data-testid="add-connection-action"\s+href=\{routes\.section\.deviceExporters\}/;

test("records list exposes a persistent Add-connection header action", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ADD_CONNECTION_HEADER_ACTION);
});

test("persistent Add-connection action is gated on interactive (no dead button in sandbox)", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ADD_CONNECTION_HEADER_GATED_INTERACTIVE);
});

test("persistent Add-connection action targets the device-enrollment entry point", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ADD_CONNECTION_HEADER_TARGETS_ENROLLMENT);
});

// ─── Honest add-connection entry point + copy ─────────────────────────────
//
// The owner-agent typed connection-intent route now exists, but it is
// owner-BEARER REST — the browser owner session has no owner bearer, so the
// console must not call it. The proven console creation primitive is the
// cookie-authed device-exporter enrollment at /dashboard/device-exporters.
// The records-list entry point must therefore be a REAL path: the supported
// connectors (claude_code, codex) deep-link into the enrollment form
// pre-selected, Amazon deep-links into a manual browser_collector proof-run path,
// and unsupported modalities are named honestly with a plain-language reason plus
// a technical primitive for reviewers — never an implied "Add connection"/"Sync
// now" that would silently fail. The supported set + unsupported reasons come
// from the shared connection-modality module. The two audit copy soft spots are
// also fixed: the
// blanket "Click Sync now to pull fresh data" promise and the
// local-collector-only "No data yet" wording.

const ADD_CONNECTION_GUIDANCE_DEF = /function AddConnectionGuidance\(/;
// The guidance is rendered (live only), receives the live catalog, and points at
// device enrollment.
const ADD_CONNECTION_GUIDANCE_RENDERED = /<AddConnectionGuidance\s+catalog=\{connectorCatalog \?\? \[\]\}/;
// The honest guidance must render UNCONDITIONALLY on the live list — gated only
// on `interactive`, immediately before the Connections section — not buried
// inside an empty-state branch. A fully-populated console (no empty-state
// callout) would otherwise show only the header "Add connection" button, which
// deep-links straight to the local-collector-only enrollment form and silently
// dead-ends an owner who wants a browser-bound source (the reported "no obvious
// way to add a second Amazon"). This invariant fails if the guidance regresses
// to rendering only when `primaryConnections.length === 0` / `empty.length > 0`.
const ADD_CONNECTION_GUIDANCE_ALWAYS_VISIBLE =
  /\{interactive \? \(\s*<AddConnectionGuidance[\s\S]*?\/>\s*\) : null\}\s*\n\s*<Section title=\{`Connections/;
// The modality taxonomy + gated reasons must still come from the shared module,
// and the per-connector list must come from the shared catalog model — not be
// re-hardcoded in the view (single source of truth with the backend).
const ADD_CONNECTION_USES_SHARED_MODALITY = /from "\.\.\/\.\.\/lib\/connection-modality\.ts"/;
const ADD_CONNECTION_USES_SHARED_CATALOG = /from "\.\.\/\.\.\/lib\/connection-catalog\.ts"/;
// The picker renders the FULL catalog grouped by disposition, not three
// hardcoded literals. Each group comes from a catalog partition helper.
const ADD_CONNECTION_RENDERS_LOCAL_CATALOG = /localCollectorEntries\(catalog\)/;
const ADD_CONNECTION_RENDERS_BROWSER_MANUAL_CATALOG = /browserCollectorEntries\(catalog\)/;
const ADD_CONNECTION_RENDERS_BROWSER_RUNBOOK_CATALOG = /browserBoundRunbookEntries\(catalog\)/;
const ADD_CONNECTION_RENDERS_LOCAL_UNPROVEN_CATALOG = /localCollectorUnprovenEntries\(catalog\)/;
const ADD_CONNECTION_RENDERS_NETWORK_CATALOG = /unsupportedNetworkEntries\(catalog\)/;
// Supported entries (and only those) deep-link into the enrollment form
// pre-selected, using the entry's enrollment key.
const ADD_CONNECTION_DEEP_LINKS_PRESELECTED =
  /\$\{deviceExportersHref\}\?connector=\$\{encodeURIComponent\(entry\.enrollmentKey \?\? entry\.connectorKey\)\}/;
const ADD_CONNECTION_BROWSER_MANUAL_SECTION = /Manual browser-collector setup/;
const ADD_CONNECTION_BROWSER_MANUAL_NOT_ONE_CLICK = /not a one-click\s+browser flow/;
const ADD_CONNECTION_NAMES_NOT_SUPPORTED_YET = /Not supported from the console yet/;
// The browser-bound owner-run group must surface the documented runbook path
// inline, so the owner is pointed at the real manual flow instead of a dead end.
const ADD_CONNECTION_SURFACES_RUNBOOK_PATH =
  /data-testid="runbook-path-browser_bound"[\s\S]*?BROWSER_BOUND_RUNBOOK_PATH/;
// A gated group (browser-bound runbook, API/network) must NEVER render an
// enrollment deep-link: only the two creatable groups build a `?connector=` href.
// There must be exactly two deep-link sites in the picker.
const ADD_CONNECTION_DEEP_LINK_COUNT_RE = /\$\{deviceExportersHref\}\?connector=/g;
// The PageHeader must not promise that every connection supports Sync now.
const NO_BLANKET_SYNC_NOW_PROMISE = /Click Sync now to pull fresh data/;
const QUALIFIED_SYNC_NOW = /Where a connector supports an owner-triggered pull, Sync now refetches it/;
// The "No data yet" section copy must not present local-collector push as the
// universal next step for every registered-but-empty connection.
const NO_DATA_SECTION_LOCAL_ONLY =
  /Click Sync now to pull initial data, or wait for a local-collector device to push its first records/;
const NO_DATA_SECTION_MIXED_POPULATION = /local-collector connections fill in when their device pushes/;

test("view exposes a real add-connection entry point, not a dead Add button", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ADD_CONNECTION_GUIDANCE_DEF);
  assert.match(src, ADD_CONNECTION_GUIDANCE_RENDERED);
  // Supported connectors deep-link into the enrollment form pre-selected — a
  // real path, not just prose.
  assert.match(src, ADD_CONNECTION_DEEP_LINKS_PRESELECTED);
});

test("honest add-connection guidance is always visible on the live list (no populated-console dead-end)", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // Rendered once, unconditionally for interactive, directly above the
  // Connections section — so an owner whose console is fully populated still
  // sees the supported-vs-runbook-gated breakdown instead of being silently
  // dropped past it by the header "Add connection" button.
  assert.match(src, ADD_CONNECTION_GUIDANCE_ALWAYS_VISIBLE);
  // And it is not duplicated: the hoisted render is the only occurrence.
  const renders = src.match(/<AddConnectionGuidance[\s/]/g) ?? [];
  assert.equal(renders.length, 1, "AddConnectionGuidance must render exactly once (hoisted, not per-branch)");
});

test("add-connection picker sources its taxonomy + per-connector list from the shared modules", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // Single source of truth: the view must consume the shared modality module for
  // the gated reasons/runbook path AND the shared catalog model for the full
  // per-connector list, rather than re-hardcoding either.
  assert.match(src, ADD_CONNECTION_USES_SHARED_MODALITY);
  assert.match(src, ADD_CONNECTION_USES_SHARED_CATALOG);
  // Every disposition group is rendered from a catalog partition helper, so the
  // picker shows the full catalog grouped by modality, not three literals.
  assert.match(src, ADD_CONNECTION_RENDERS_LOCAL_CATALOG);
  assert.match(src, ADD_CONNECTION_RENDERS_BROWSER_MANUAL_CATALOG);
  assert.match(src, ADD_CONNECTION_RENDERS_BROWSER_RUNBOOK_CATALOG);
  assert.match(src, ADD_CONNECTION_RENDERS_LOCAL_UNPROVEN_CATALOG);
  assert.match(src, ADD_CONNECTION_RENDERS_NETWORK_CATALOG);
  assert.match(src, ADD_CONNECTION_BROWSER_MANUAL_SECTION);
  assert.match(src, ADD_CONNECTION_BROWSER_MANUAL_NOT_ONE_CLICK);
  // Unsupported modalities are named honestly, not hidden behind a generic
  // "not supported" line.
  assert.match(src, ADD_CONNECTION_NAMES_NOT_SUPPORTED_YET);
  // Where a documented owner-run path exists today (browser-bound), the group
  // surfaces it instead of dead-ending the owner.
  assert.match(src, ADD_CONNECTION_SURFACES_RUNBOOK_PATH);
});

test("only the two creatable catalog groups render an enrollment deep-link (no phantom connections)", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // The browser-bound-runbook and API/network groups must be display-only; only
  // local-collector + manual-browser-collector build a `?connector=` href. So the
  // picker must contain exactly two deep-link sites.
  const deepLinks = src.match(ADD_CONNECTION_DEEP_LINK_COUNT_RE) ?? [];
  assert.equal(deepLinks.length, 2, "exactly the two creatable groups may deep-link into enrollment");
});

// ─── Easy path leads; honest caveats recede into progressive disclosure ───
//
// Owner feedback: the picker felt "too Amazon-specific, too verbose, confusing".
// The fix is presentation, not honesty: the one-click local-collector group
// leads and stays open, while the four secondary groups (manual
// browser-collector / Amazon, browser-bound runbook, local-collector unproven,
// api_network unsupported) collapse into a native <details> disclosure that
// names its count. Collapsing is NOT omission — every group still renders inside
// the disclosure, keyboard-reachable, with its honest reason and deep-link. This
// pins the new layout so it cannot silently regress back to five always-open
// jargon sections, AND guards that the secondary groups did not get dropped.
const ADD_OTHER_DISCLOSURE = /<details[\s\S]*?data-testid="add-connection-other"/;
const ADD_OTHER_SUMMARY = /<summary[\s\S]*?data-testid="add-connection-other-toggle"/;
const ADD_OTHER_SUMMARY_NAMES_COUNT = /Other connectors[\s\S]*?\(\{otherCount\}\)/;
// The four secondary groups must be RENDERED INSIDE the disclosure, i.e. their
// per-group entry markup follows the <details> open tag — never hoisted back out
// as always-open sections. Anchoring each per-group testid to the text following
// `add-connection-other` proves the group's rendered rows live within the
// collapsed region. (The partition helpers themselves are computed once at the
// top of the function; what matters for "not omission" is that each group's rows
// still render, and that they render inside the disclosure.)
const ADD_OTHER_CONTAINS_SECONDARY_GROUPS =
  /data-testid="add-connection-other"[\s\S]*?catalog-browser-manual-[\s\S]*?catalog-browser-runbook-[\s\S]*?catalog-local-unproven-[\s\S]*?catalog-network-/;
// The one-click local-collector group's rendered rows must appear BEFORE the
// disclosure — it is the lead, not a peer buried inside "Other connectors".
const ADD_LOCAL_LEADS_BEFORE_DISCLOSURE = /catalog-local-\$\{[\s\S]*?data-testid="add-connection-other"/;
// The disclosure must not render when there are no secondary entries (otherwise
// an empty "Other connectors (0)" toggle would show); it is gated on a count.
const ADD_OTHER_GATED_ON_COUNT = /\{otherCount > 0 \? \(\s*<details/;

test("add-connection picker collapses the non-one-click groups into a counted disclosure", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ADD_OTHER_DISCLOSURE);
  assert.match(src, ADD_OTHER_SUMMARY);
  assert.match(src, ADD_OTHER_SUMMARY_NAMES_COUNT);
  assert.match(src, ADD_OTHER_GATED_ON_COUNT);
});

test("the one-click local-collector group leads, above the 'Other connectors' disclosure", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ADD_LOCAL_LEADS_BEFORE_DISCLOSURE);
});

test("collapsing is not omission: all four secondary groups still render inside the disclosure", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // Every secondary partition helper appears after the disclosure open tag, in
  // order — so none of the honest groups was dropped when they moved behind the
  // <details> toggle.
  assert.match(src, ADD_OTHER_CONTAINS_SECONDARY_GROUPS);
});

// ─── Static-secret connect group is surfaced honestly (not "unsupported") ──
//
// Gmail/GitHub gained an owner-session static-secret draft-create path. The
// picker must surface them as a real creation path inside the "Other connectors"
// disclosure — named, runbook-pointed, live-proof-caveated — NOT as a dead
// "appears only after first ingest" notice and NOT deep-linked into the
// device-collector enrollment form (which they don't use). The group and its copy
// come from the shared catalog/modality modules (single source of truth with the
// backend's static-secret connector set).
const ADD_STATIC_SECRET_GROUP = /staticSecretConnectEntries\(catalog\)/;
const ADD_STATIC_SECRET_SECTION = /Static-secret — owner-session setup/;
const ADD_STATIC_SECRET_USES_SHARED_COPY = /STATIC_SECRET_ADD_MODALITY\.ownerFacingReason/;
const ADD_STATIC_SECRET_SURFACES_RUNBOOK =
  /data-testid="runbook-path-static_secret"[\s\S]*?STATIC_SECRET_ADD_MODALITY\.runbookPath/;
const ADD_STATIC_SECRET_NO_DEEP_LINK = /catalog-static-secret-[\s\S]{0,400}deviceExportersHref/;

test("static-secret connectors are surfaced as a real owner-session path, not an unsupported notice", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ADD_STATIC_SECRET_GROUP);
  assert.match(src, ADD_STATIC_SECRET_SECTION);
  // Copy + runbook come from the shared modality descriptor, not re-hardcoded.
  assert.match(src, ADD_STATIC_SECRET_USES_SHARED_COPY);
  assert.match(src, ADD_STATIC_SECRET_SURFACES_RUNBOOK);
});

test("static-secret group never deep-links into the device-collector enrollment form", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // The static-secret rows must be display-only (no `?connector=` enrollment
  // href near them) — Gmail/GitHub are not device-collectors. The two-deep-link
  // invariant above already pins the global count; this guards the specific group.
  assert.doesNotMatch(src, ADD_STATIC_SECRET_NO_DEEP_LINK);
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
// A connector you have not connected stays under Add connection — so a no-data
// row is never read as "a connector I can choose".
const NO_DATA_SECTION_NAMES_CATALOG = /not connected stays under Add connection/;
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
