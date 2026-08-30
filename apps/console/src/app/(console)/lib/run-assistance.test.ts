// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { selectNoAssistanceStreamState } from "../syncs/[runId]/stream/stream-state.ts";
import type { SpineEvent } from "./ref-client.ts";
import {
  getCurrentBrowserSurfaceAssistance,
  getCurrentRunAssistance,
  hasActiveBrowserSurface,
  hasAvailableBrowserSurfaceAttachment,
  hasResolvedBrowserSurfaceAssistance,
  requiresBrowserSurfaceAssistance,
} from "./run-assistance.ts";

function event(event_type: string, data: Record<string, unknown>): SpineEvent {
  return {
    actor_id: "connector:test",
    actor_type: "runtime",
    client_id: null,
    data,
    event_id: `${event_type}:1`,
    event_type,
    grant_id: null,
    interaction_id: typeof data.interaction_id === "string" ? data.interaction_id : null,
    object_id: "run_1",
    object_type: "run",
    occurred_at: "2026-05-14T00:00:00.000Z",
    provider_id: null,
    recorded_at: "2026-05-14T00:00:00.000Z",
    request_id: null,
    run_id: "run_1",
    scenario_id: null,
    status: null,
    stream_id: null,
    subject_id: null,
    subject_type: null,
    token_id: null,
    trace_id: "trace_1",
    version: "1",
  };
}

test("browser-surface assistance without a registered surface is current but not streamable", () => {
  const events = [
    event("run.assistance_requested", {
      assistance_request_id: "assist_1",
      attachments: [{ kind: "browser_surface", role: "streaming_companion", status: "waiting_for_browser_surface" }],
      message: "Complete the captcha in the browser.",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      response_contract: "response_required",
    }),
  ];

  const current = getCurrentRunAssistance(events);

  assert.ok(current);
  assert.equal(requiresBrowserSurfaceAssistance(current), true);
  assert.equal(hasAvailableBrowserSurfaceAttachment(current), false);
  assert.equal(getCurrentBrowserSurfaceAssistance(events), null);
});

test("legacy browser-surface assistance without availability metadata remains streamable", () => {
  const events = [
    event("run.assistance_requested", {
      assistance_request_id: "assist_1",
      attachments: [{ kind: "browser_surface", role: "streaming_companion" }],
      message: "Complete the captcha in the browser.",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      response_contract: "response_required",
    }),
  ];

  const streamable = getCurrentBrowserSurfaceAssistance(events);

  assert.ok(streamable);
  assert.equal(hasAvailableBrowserSurfaceAttachment(streamable), true);
  assert.equal(streamable.id, "assist_1");
});

test("browser-surface assistance with a registered surface remains streamable", () => {
  const events = [
    event("run.assistance_requested", {
      assistance_request_id: "assist_1",
      attachments: [{ kind: "browser_surface", ref: "surface_1", role: "streaming_companion" }],
      message: "Complete the captcha in the browser.",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      response_contract: "response_required",
    }),
  ];

  const streamable = getCurrentBrowserSurfaceAssistance(events);

  assert.ok(streamable);
  assert.equal(hasAvailableBrowserSurfaceAttachment(streamable), true);
  assert.equal(streamable.id, "assist_1");
});

test("no-response browser-surface assistance is streamable without becoming a value prompt", () => {
  const events = [
    event("run.assistance_requested", {
      assistance_request_id: "assist_1",
      attachments: [{ kind: "browser_surface", role: "streaming_companion" }],
      message: "Finish login in the browser. Collection continues automatically.",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      response_contract: "none",
    }),
  ];

  const current = getCurrentRunAssistance(events);
  const streamable = getCurrentBrowserSurfaceAssistance(events);

  assert.ok(current);
  assert.equal(current.responseContract, "none");
  assert.equal(requiresBrowserSurfaceAssistance(current), true);
  assert.ok(streamable);
  assert.equal(streamable.id, "assist_1");
  assert.equal(streamable.responseContract, "none");
});

test("passive app-push assistance is not treated as browser-surface work", () => {
  const events = [
    event("run.assistance_requested", {
      assistance_request_id: "assist_1",
      message: "Approve the sign-in in the app.",
      owner_action: "act_elsewhere",
      progress_posture: "running",
      response_contract: "none",
    }),
  ];

  const current = getCurrentRunAssistance(events);

  assert.ok(current);
  assert.equal(requiresBrowserSurfaceAssistance(current), false);
  assert.equal(getCurrentBrowserSurfaceAssistance(events), null);
});

test("active browser-surface events keep stream fallback in the browser-preparing state", () => {
  const events = [
    event("run.browser_surface_requested", {
      browser_surface: {
        browser_surface_status: "waiting_for_browser_surface",
        browser_surface_wait_reason: "capacity_full",
      },
    }),
    event("run.browser_surface_ready", {
      browser_surface: {
        browser_surface_lease_id: "lease_1",
        browser_surface_status: "leased",
      },
    }),
    event("run.started", {
      automation_mode: "assisted",
    }),
  ];

  assert.equal(hasActiveBrowserSurface(events), true);
});

test("terminal browser-surface events do not keep stream fallback in the browser-preparing state", () => {
  const events = [
    event("run.browser_surface_ready", {
      browser_surface: {
        browser_surface_status: "leased",
      },
    }),
    event("run.browser_surface_released", {
      browser_surface: {
        browser_surface_status: "released",
      },
    }),
  ];

  assert.equal(hasActiveBrowserSurface(events), false);
});

// fr-setup-status-lifecycle-0806: an H-E-B-style browser login that already
// resolved must read as "browser step complete," not the same "nothing has
// ever happened" signal a fresh run reports before assistance is requested.

test("a never-requested run reports no resolved browser-surface assistance", () => {
  const events = [event("run.started", { automation_mode: "assisted" })];

  assert.equal(hasResolvedBrowserSurfaceAssistance(events), false);
});

test("a currently-open browser-surface assistance request is not yet resolved", () => {
  const events = [
    event("run.assistance_requested", {
      assistance_request_id: "assist_1",
      attachments: [{ kind: "browser_surface", ref: "surface_1", role: "streaming_companion" }],
      message: "Log in to continue.",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      response_contract: "response_required",
    }),
  ];

  assert.equal(hasResolvedBrowserSurfaceAssistance(events), false);
});

test("a resolved structured browser-surface assistance request reports handoff-ready", () => {
  const events = [
    event("run.assistance_requested", {
      assistance_request_id: "assist_1",
      attachments: [{ kind: "browser_surface", ref: "surface_1", role: "streaming_companion" }],
      message: "Log in to continue.",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      response_contract: "response_required",
    }),
    event("run.assistance_resolved", { assistance_request_id: "assist_1" }),
  ];

  assert.equal(hasResolvedBrowserSurfaceAssistance(events), true);
  // The run keeps going — this must not read as fully resolved/ended.
  assert.equal(getCurrentBrowserSurfaceAssistance(events), null);
});

test("a rejected browser readiness probe closes the streamed assistance so a failed run renders terminal state", () => {
  const events = [
    event("run.assistance_requested", {
      assistance_request_id: "assist_rejected",
      attachments: [{ kind: "browser_surface", ref: "surface_1", role: "streaming_companion" }],
      message: "Finish sign-in in the secure browser. PDPP continues automatically.",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      response_contract: "none",
    }),
    event("run.assistance_escalated", { assistance_request_id: "assist_rejected" }),
  ];

  assert.equal(getCurrentRunAssistance(events), null);
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "failed", terminalStatus: null }), "ended");
});

test("a self-resolved no-response browser handoff leaves the stream page in its background-continuing state", () => {
  const events = [
    event("run.assistance_requested", {
      assistance_request_id: "assist_resolved",
      attachments: [{ kind: "browser_surface", ref: "surface_1", role: "streaming_companion" }],
      message: "Finish sign-in in the secure browser. PDPP continues automatically.",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      response_contract: "none",
    }),
    event("run.assistance_resolved", { assistance_request_id: "assist_resolved" }),
  ];

  assert.equal(getCurrentRunAssistance(events), null);
  assert.equal(hasResolvedBrowserSurfaceAssistance(events), true);
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "active", terminalStatus: null }), "running");
});

test("a resolved legacy manual_action interaction reports handoff-ready", () => {
  const events = [
    event("run.interaction_required", {
      interaction_id: "int_1",
      kind: "manual_action",
      message: "Log in to continue.",
    }),
    event("run.interaction_completed", { interaction_id: "int_1" }),
  ];

  assert.equal(hasResolvedBrowserSurfaceAssistance(events), true);
});

test("a resolved non-browser (app-push) assistance request is not treated as browser handoff", () => {
  const events = [
    event("run.assistance_requested", {
      assistance_request_id: "assist_1",
      message: "Approve the sign-in in the app.",
      owner_action: "act_elsewhere",
      progress_posture: "running",
      response_contract: "none",
    }),
    event("run.assistance_resolved", { assistance_request_id: "assist_1" }),
  ];

  assert.equal(hasResolvedBrowserSurfaceAssistance(events), false);
});
