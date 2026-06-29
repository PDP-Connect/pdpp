import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { selectNoAssistanceStreamState } from "./stream-state.ts";

const pageSource = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
const TERMINAL_STATUS_SELECTOR_RE = /selectNoAssistanceStreamState\(envelope\.terminal_status\)/;
const RESOLVED_SURFACE_GATE_RE = /noAssistanceState === "resolved"[\s\S]{0,120}<ResolvedSurface/;
const ENDED_SURFACE_GATE_RE = /noAssistanceState === "ended"[\s\S]{0,160}<RunEndedSurface/;
const CONTINUING_SURFACE_RE = /<RunContinuingSurface/;

test("no-assistance stream state distinguishes success, terminal failure, and active runs", () => {
  assert.equal(selectNoAssistanceStreamState("completed"), "resolved");
  assert.equal(selectNoAssistanceStreamState("failed"), "ended");
  assert.equal(selectNoAssistanceStreamState("cancelled"), "ended");
  assert.equal(selectNoAssistanceStreamState("abandoned"), "ended");
  assert.equal(selectNoAssistanceStreamState(null), "running");
  assert.equal(selectNoAssistanceStreamState(undefined), "running");
});

test("stream page does not render resolved copy solely because assistance disappeared", () => {
  assert.match(pageSource, TERMINAL_STATUS_SELECTOR_RE);
  assert.match(pageSource, RESOLVED_SURFACE_GATE_RE);
  assert.match(pageSource, ENDED_SURFACE_GATE_RE);
  assert.match(pageSource, CONTINUING_SURFACE_RE);
});
