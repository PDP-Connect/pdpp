// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveNoAssistanceEndedTerminalStatus, selectNoAssistanceStreamState } from "./stream-state.ts";

const pageSource = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
const streamViewerSource = readFileSync(fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url)), "utf8");
const TERMINAL_STATUS_SELECTOR_RE =
  /selectNoAssistanceStreamState\(\{[\s\S]{0,200}runHandleStatus:\s*runStatus\?\.status \?\? null,\s*terminalStatus:\s*envelope\.terminal_status,\s*\}\)/;
const RUN_STATUS_FETCH_RE =
  /Promise\.all\(\[\s*getRunTimeline\(runId, \{ cursor: null \}\),\s*getRunStatus\(runId\)\s*\]\)/;
const RESOLVED_SURFACE_GATE_RE = /noAssistanceState === "resolved"[\s\S]{0,120}<ResolvedSurface/;
const ENDED_SURFACE_GATE_RE =
  /noAssistanceState === "ended"[\s\S]{0,360}<RunEndedSurface[\s\S]{0,360}resolveNoAssistanceEndedTerminalStatus/;
const CONTINUING_SURFACE_RE = /<RunContinuingSurface/;
const CONTINUING_POLLER_RE = /<NoAssistanceRunPoller runId=\{runId\} \/>/;
const UNAVAILABLE_STREAM_POLLER_RE =
  /function UnavailableStreamSurface[\s\S]{0,520}<NoAssistanceRunPoller runId=\{runId\} \/>/;
const PREPARING_BROWSER_SURFACE_GATE_RE =
  /hasActiveBrowserSurface\(envelope\.events\)[\s\S]{0,120}<PreparingBrowserSurface/;
const PREPARING_BROWSER_SURFACE_COPY_RE = /Preparing the secure browser\./;
const EXTERNAL_APPROVAL_COPY_RE = /Approve the prompt outside PDPP\./;
const EXTERNAL_APPROVAL_WAITING_COPY_RE = /No browser controls are\s+waiting/;
const POLLER_TIMELINE_PROBE_RE = /fetch\(`\/_ref\/runs\/\$\{encodeURIComponent\(runId\)\}\/timeline`/;
const POLLER_STREAM_READY_RE = /getCurrentBrowserSurfaceAssistance\(timelineEventsFrom\(body\)\) !== null/;
const POLLER_HARD_RELOAD_RE = /window\.location\.reload\(\)/;
const RUN_STATUS_INSTANCE_CONTEXT_RE =
  /const connectorInstanceId =\s*runStatus\?\.connector_instance_id \?\? getConnectorInstanceIdFromTimeline\(envelope\.events\);/;
// The client no longer filters an unbounded fetch in the browser — it scopes
// the reference read itself, via resolveConnectorSummaryRouteId (instance id
// when known, else the bare connector id — the reference resolves exact
// identity first and only falls back to an unambiguous connector-id match,
// same precedence the old client-side filter enforced).
const INSTANCE_SCOPED_SUMMARY_MATCH_RE =
  /listConnectorSummaries\(\{\s*connectionRouteId:\s*resolveConnectorSummaryRouteId\(connectorId,\s*connectorInstanceId\)/;
const BROWSER_ASSISTANCE_STREAM_KIND_RE =
  /interactionKind="manual_action"[\s\S]{0,180}interactionMessage=\{streamableAssistance\.message\}/;
const BROWSER_ASSISTANCE_RESPONSE_CONTRACT_RE =
  /interactionRequiresResponse=\{streamableAssistance\.responseContract === "response_required"\}/;
const DEFERRED_BROWSER_SLOT_COPY_RE = /Secure browser slot unavailable\./;
const DEFERRED_BROWSER_SLOT_NOT_DANGER_RE = /terminalStatus === "deferred"[\s\S]{0,600}border border-border bg-card/;
const RESOLVED_SURFACE_ACCEPTS_RUN_ID_RE = /export function ResolvedSurface\(\{ connector, runId \}/;
const RESOLVED_SURFACE_RUN_LINK_RE = /href=\{`\/syncs\/\$\{encodeURIComponent\(runId\)\}`\}/;
const WINDOW_CLOSE_RE = /window\.close\(\)/;
const CLOSE_TAB_COPY_RE = />\s*Close this tab\s*</;
const NO_CLIENT_SIDE_FIRST_MATCH_RE = /summaries\.data\.find\(\(c\) => c\.connector_id === connectorId\)/;
const BUILDS_CONTEXT_FROM_MATCH_RE = /return buildConnectorContext\(connectorId, match\);/;
const BUILDS_CONTEXT_FROM_UNDEFINED_RE = /return buildConnectorContext\(connectorId, undefined\);/;

test("no-assistance stream state distinguishes success, terminal failure, and active runs", () => {
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "completed" }), "resolved");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "failed" }), "ended");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "cancelled" }), "ended");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "abandoned" }), "ended");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: null }), "running");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: undefined }), "running");
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "failed", terminalStatus: null }), "ended");
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "deferred", terminalStatus: null }), "ended");
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "surface_failed", terminalStatus: null }), "ended");
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "active", terminalStatus: null }), "running");
});

test("ended fallback status preserves specific terminal labels when timeline status is absent", () => {
  assert.equal(
    resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: "cancelled", terminalStatus: null }),
    "cancelled"
  );
  assert.equal(
    resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: "abandoned", terminalStatus: null }),
    "abandoned"
  );
  assert.equal(
    resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: "surface_failed", terminalStatus: null }),
    "failed"
  );
  assert.equal(
    resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: "deferred", terminalStatus: null }),
    "deferred"
  );
});

test("stream page does not render resolved copy solely because assistance disappeared", () => {
  assert.match(pageSource, RUN_STATUS_FETCH_RE);
  assert.match(pageSource, TERMINAL_STATUS_SELECTOR_RE);
  assert.match(pageSource, RESOLVED_SURFACE_GATE_RE);
  assert.match(pageSource, ENDED_SURFACE_GATE_RE);
  assert.match(pageSource, PREPARING_BROWSER_SURFACE_GATE_RE);
  assert.match(pageSource, PREPARING_BROWSER_SURFACE_COPY_RE);
  assert.match(pageSource, CONTINUING_SURFACE_RE);
  assert.match(pageSource, CONTINUING_POLLER_RE);
});

test("external provider approval does not render as a browser-session repair", () => {
  const externalApprovalGate = pageSource.indexOf(
    'currentAssistance?.ownerAction === "act_elsewhere" && currentAssistance.responseContract === "none"'
  );
  const browserPrepGate = pageSource.indexOf("hasActiveBrowserSurface(envelope.events)");

  assert.notEqual(externalApprovalGate, -1);
  assert.notEqual(browserPrepGate, -1);
  assert.ok(
    externalApprovalGate < browserPrepGate,
    "external app approval must be handled before the generic active-browser fallback"
  );
  const externalApprovalStart = pageSource.indexOf("function ExternalApprovalSurface(");
  const externalApprovalEnd = pageSource.indexOf("function UnavailableStreamSurface(", externalApprovalStart);
  assert.notEqual(externalApprovalStart, -1);
  assert.ok(externalApprovalEnd > externalApprovalStart, "approval surface must have a stable source boundary");
  const externalApprovalSource = pageSource.slice(externalApprovalStart, externalApprovalEnd);
  assert.match(externalApprovalSource, EXTERNAL_APPROVAL_COPY_RE);
  assert.match(externalApprovalSource, EXTERNAL_APPROVAL_WAITING_COPY_RE);
});

test("stream page labels multi-account runs by connection instance before connector type", () => {
  assert.match(pageSource, RUN_STATUS_INSTANCE_CONTEXT_RE);
  assert.match(pageSource, INSTANCE_SCOPED_SUMMARY_MATCH_RE);
});

// Intentional migration behavior change (gate finding #6, 2026-07-29):
//
// BEFORE: when the run timeline carried no connector_instance_id, the page
// fetched the WHOLE fleet and did
//   `instanceMatch ?? summaries.data.find((c) => c.connector_id === connectorId)`
// — an ambiguous connector_id (multiple connections of the same connector
// type) silently resolved to the FIRST configured connection, attaching
// that connection's display_name to a run that might belong to a sibling
// connection. This was a real, if narrow, mislabeling bug.
//
// AFTER: the page scopes the reference read itself, via
// `resolveConnectorSummaryRouteId` (instance id when known, else the bare
// connector id), which server-side resolves exact instance identity first,
// then a connector_id fallback ONLY when exactly one configured connection
// has that connector type (`resolveUnambiguousConnectionForConnectorId`,
// `connection-route.ts`'s established precedent for the SAME tradeoff on
// the records subpage). An ambiguous connector_id now resolves to NO
// match — `buildConnectorContext` (connector-context-resolution.ts,
// executable-tested there) degrades to the generic connector-type label
// (e.g. "Strava") instead of a specific but possibly-wrong connection's
// display_name (e.g. "Strava (work account)"). This is strictly safer
// (never attributes to the wrong sibling connection) but is a real,
// observable UX change for the rare multi-instance-same-connector-type
// case with no instance id on the timeline, so it is pinned here as an
// intentional scenario rather than left as an unexamined side effect.
test("multi-instance fallback: the resolver delegates to the exact-identity-first, no-silent-first-match helpers", () => {
  const resolverBody = pageSource.slice(
    pageSource.indexOf("async function resolveConnectorContext"),
    pageSource.indexOf("function renderNoAssistanceSurface")
  );
  // The scoped call resolves its route id via resolveConnectorSummaryRouteId
  // (instance id when known, else connector id) — there is no client-side
  // "first match" fallback left in this function.
  assert.match(resolverBody, INSTANCE_SCOPED_SUMMARY_MATCH_RE);
  assert.doesNotMatch(
    resolverBody,
    NO_CLIENT_SIDE_FIRST_MATCH_RE,
    "no residual client-side first-match-by-connector_id fallback may remain"
  );
  // Both the resolved-match and error paths build the context through the
  // shared, directly-unit-tested buildConnectorContext helper — never an
  // inline fallback that could silently diverge from the tested behavior.
  assert.match(resolverBody, BUILDS_CONTEXT_FROM_MATCH_RE);
  assert.match(resolverBody, BUILDS_CONTEXT_FROM_UNDEFINED_RE);
});

test("stream page opens browser-surface assistance without assuming a response is required", () => {
  assert.match(pageSource, BROWSER_ASSISTANCE_STREAM_KIND_RE);
  assert.match(pageSource, BROWSER_ASSISTANCE_RESPONSE_CONTRACT_RE);
});

test("ended browser stream labels browser-capacity deferrals without danger styling", () => {
  assert.match(pageSource, DEFERRED_BROWSER_SLOT_COPY_RE);
  assert.match(pageSource, DEFERRED_BROWSER_SLOT_NOT_DANGER_RE);
});

test("no-assistance poller explicitly transitions into current browser assistance", () => {
  const pollerSource = readFileSync(fileURLToPath(new URL("./no-assistance-run-poller.tsx", import.meta.url)), "utf8");

  assert.match(pollerSource, POLLER_TIMELINE_PROBE_RE);
  assert.match(pollerSource, POLLER_STREAM_READY_RE);
  assert.match(pollerSource, POLLER_HARD_RELOAD_RE);
  assert.match(pageSource, UNAVAILABLE_STREAM_POLLER_RE);
});

test("resolved browser stream offers reliable navigation instead of blocked tab close", () => {
  assert.match(streamViewerSource, RESOLVED_SURFACE_ACCEPTS_RUN_ID_RE);
  assert.match(streamViewerSource, RESOLVED_SURFACE_RUN_LINK_RE);
  assert.doesNotMatch(streamViewerSource, WINDOW_CLOSE_RE);
  assert.doesNotMatch(streamViewerSource, CLOSE_TAB_COPY_RE);
});
