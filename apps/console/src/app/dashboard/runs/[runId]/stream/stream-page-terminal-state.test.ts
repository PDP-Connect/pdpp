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
const CONTINUING_POLLER_RE = /<NoAssistanceRunPoller \/>/;

test("no-assistance stream state distinguishes success, terminal failure, and active runs", () => {
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "completed" }), "resolved");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "failed" }), "ended");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "cancelled" }), "ended");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "abandoned" }), "ended");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: null }), "running");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: undefined }), "running");
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "failed", terminalStatus: null }), "ended");
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
});

test("stream page does not render resolved copy solely because assistance disappeared", () => {
  assert.match(pageSource, RUN_STATUS_FETCH_RE);
  assert.match(pageSource, TERMINAL_STATUS_SELECTOR_RE);
  assert.match(pageSource, RESOLVED_SURFACE_GATE_RE);
  assert.match(pageSource, ENDED_SURFACE_GATE_RE);
  assert.match(pageSource, CONTINUING_SURFACE_RE);
  assert.match(pageSource, CONTINUING_POLLER_RE);
});
