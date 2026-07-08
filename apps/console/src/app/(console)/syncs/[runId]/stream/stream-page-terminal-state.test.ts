import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveNoAssistanceEndedTerminalStatus, selectNoAssistanceStreamState } from "./stream-state.ts";

const pageSource = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
const TERMINAL_STATUS_SELECTOR_RE =
  /selectNoAssistanceStreamState\(\{\s*runHandleStatus:\s*runStatus\?\.status \?\? null,\s*terminalStatus:\s*envelope\.terminal_status,\s*\}\)/;
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
const POLLER_TIMELINE_PROBE_RE = /fetch\(`\/_ref\/runs\/\$\{encodeURIComponent\(runId\)\}\/timeline`/;
const POLLER_STREAM_READY_RE = /getCurrentBrowserSurfaceAssistance\(timelineEventsFrom\(body\)\) !== null/;
const POLLER_HARD_RELOAD_RE = /window\.location\.reload\(\)/;
const RUN_STATUS_INSTANCE_CONTEXT_RE =
  /const connectorInstanceId =\s*runStatus\?\.connector_instance_id \?\? getConnectorInstanceIdFromTimeline\(envelope\.events\);/;
const INSTANCE_SCOPED_SUMMARY_MATCH_RE =
  /c\.connector_id === connectorId &&\s*\(c\.connector_instance_id === connectorInstanceId \|\| c\.connection_id === connectorInstanceId\)/;
const CONNECTOR_TYPE_FALLBACK_RE =
  /instanceMatch \?\? summaries\.data\.find\(\(c\) => c\.connector_id === connectorId\)/;
const BROWSER_ASSISTANCE_STREAM_KIND_RE =
  /interactionKind="manual_action"[\s\S]{0,180}interactionMessage=\{streamableAssistance\.message\}/;
const BROWSER_ASSISTANCE_RESPONSE_CONTRACT_RE =
  /interactionRequiresResponse=\{streamableAssistance\.responseContract === "response_required"\}/;
const DEFERRED_BROWSER_SLOT_COPY_RE = /Secure browser slot unavailable\./;
const DEFERRED_BROWSER_SLOT_NOT_DANGER_RE = /terminalStatus === "deferred"[\s\S]{0,600}border border-border bg-card/;

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

test("stream page labels multi-account runs by connection instance before connector type", () => {
  assert.match(pageSource, RUN_STATUS_INSTANCE_CONTEXT_RE);
  assert.match(pageSource, INSTANCE_SCOPED_SUMMARY_MATCH_RE);
  assert.match(pageSource, CONNECTOR_TYPE_FALLBACK_RE);
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
