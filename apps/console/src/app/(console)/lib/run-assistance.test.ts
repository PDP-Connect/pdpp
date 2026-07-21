// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { SpineEvent } from "./ref-client.ts";
import {
  getCurrentBrowserSurfaceAssistance,
  getCurrentRunAssistance,
  hasActiveBrowserSurface,
  hasAvailableBrowserSurfaceAttachment,
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
        browser_surface_status: "leased",
        browser_surface_lease_id: "lease_1",
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
