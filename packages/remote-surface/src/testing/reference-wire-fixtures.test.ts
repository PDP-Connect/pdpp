import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildReferenceWireAttachedPayload,
  buildReferenceWireBackendReadyPayload,
  buildReferenceWireCompanionEventPayload,
  buildReferenceWireFramePayload,
  normalizeReferenceWireViewportPayload,
  parseReferenceWireInputPayload,
  parseReferenceWireInputTelemetryCursor,
  parseReferenceWireInputTelemetryRecord,
  RemoteSurfaceProtocolError,
} from "../protocol/index.ts";
import {
  REFERENCE_WIRE_ALL_FIXTURES,
  REFERENCE_WIRE_BROWSER_VISIBLE_FIXTURES,
  REFERENCE_WIRE_INPUT_PAYLOAD_FIXTURES,
  REFERENCE_WIRE_INPUT_TELEMETRY_FIXTURE,
  REFERENCE_WIRE_MINT_RESPONSE_FIXTURE,
  REFERENCE_WIRE_NEKO_CLIENT_CONFIG_FIXTURE,
  REFERENCE_WIRE_SSE_EVENT_FIXTURES,
  REFERENCE_WIRE_TARGET_REGISTRATION_RESPONSE_FIXTURE,
  REFERENCE_WIRE_TOKEN,
  REFERENCE_WIRE_VIEWPORT_PAYLOAD_FIXTURE,
  REFERENCE_WIRE_VIEWPORT_ACK_FIXTURE,
  type ReferenceWireFixture,
} from "./reference-wire-fixtures.ts";

describe("reference wire fixtures", () => {
  it("captures current reference route object names and paths", () => {
    assert.equal(REFERENCE_WIRE_MINT_RESPONSE_FIXTURE.object, "run_interaction_stream_session");
    assert.match(REFERENCE_WIRE_MINT_RESPONSE_FIXTURE.viewer_path, /^\/_ref\/run-interaction-streams\/[^/]+\/events$/);
    assert.match(REFERENCE_WIRE_MINT_RESPONSE_FIXTURE.input_path, /^\/_ref\/run-interaction-streams\/[^/]+\/input$/);
    assert.match(REFERENCE_WIRE_MINT_RESPONSE_FIXTURE.viewport_path, /^\/_ref\/run-interaction-streams\/[^/]+\/viewport$/);
    assert.equal(REFERENCE_WIRE_VIEWPORT_ACK_FIXTURE.object, "run_interaction_stream_viewport_ack");
    assert.equal(REFERENCE_WIRE_NEKO_CLIENT_CONFIG_FIXTURE.object, "run_interaction_neko_client");
    assert.equal(REFERENCE_WIRE_TARGET_REGISTRATION_RESPONSE_FIXTURE.object, "run_streaming_target");
  });

  it("captures the expected current SSE event names and frame wire shape", () => {
    assert.deepEqual(
      REFERENCE_WIRE_SSE_EVENT_FIXTURES.map((fixture) => fixture.event),
      [
        "attached",
        "frame",
        "backend_ready",
        "url_changed",
        "popup_opened",
        "popup_closed",
        "clipboard",
        "keyboard_focus",
        "error",
      ],
    );

    const frame = REFERENCE_WIRE_SSE_EVENT_FIXTURES.find((fixture) => fixture.event === "frame");
    assert.ok(frame);
    assert.equal(typeof frame.data, "object");
    assert.equal(frame.data?.session_id, 7);
    assert.equal(typeof frame.data?.data_base64, "string");
    assert.equal(typeof frame.data?.metadata, "object");
  });

  it("captures the dashboard-emitted input payload variants", () => {
    assert.deepEqual(
      REFERENCE_WIRE_INPUT_PAYLOAD_FIXTURES.map((fixture) => fixture.type),
      ["mouse", "mouse", "mouse", "keyboard", "keyboard", "touch", "touch", "scroll", "paste"],
    );
  });

  it("parses current reference input payloads permissively for route parity", () => {
    assert.deepEqual(
      REFERENCE_WIRE_INPUT_PAYLOAD_FIXTURES.map((fixture) => parseReferenceWireInputPayload(fixture)),
      REFERENCE_WIRE_INPUT_PAYLOAD_FIXTURES,
    );
    assert.deepEqual(parseReferenceWireInputPayload(null), {});
    assert.deepEqual(parseReferenceWireInputPayload("invalid"), {});
  });

  it("normalizes current reference viewport payloads like the route helper", () => {
    assert.deepEqual(normalizeReferenceWireViewportPayload(REFERENCE_WIRE_VIEWPORT_PAYLOAD_FIXTURE), {
      width: 1280,
      height: 720,
      screenWidth: 1280,
      screenHeight: 720,
      deviceScaleFactor: 1,
      hasTouch: false,
      userAgent: "Mozilla/5.0 fixture",
    });
    assert.deepEqual(
      normalizeReferenceWireViewportPayload({
        width: 390.8,
        height: 844.2,
        screenWidth: 1170,
        screenHeight: 2532,
        deviceScaleFactor: 3,
        hasTouch: true,
        mobile: true,
        userAgent: "x".repeat(600),
      }),
      {
        width: 390,
        height: 844,
        screenWidth: 1170,
        screenHeight: 2532,
        deviceScaleFactor: 3,
        hasTouch: true,
        mobile: true,
        userAgent: "x".repeat(512),
      },
    );
    assert.equal(normalizeReferenceWireViewportPayload({ width: 0, height: 720 }), null);
  });

  it("parses current reference input telemetry cursors and records", () => {
    assert.deepEqual(parseReferenceWireInputTelemetryCursor("7"), { since: 7 });
    assert.deepEqual(parseReferenceWireInputTelemetryCursor("not-a-number"), { since: 0 });
    assert.deepEqual(
      REFERENCE_WIRE_INPUT_TELEMETRY_FIXTURE.records.map((record) => parseReferenceWireInputTelemetryRecord(record)),
      REFERENCE_WIRE_INPUT_TELEMETRY_FIXTURE.records,
    );
    assert.equal(parseReferenceWireInputTelemetryRecord(null), null);
    assert.throws(
      () => parseReferenceWireInputTelemetryRecord({ kind: "bad", value: undefined }),
      RemoteSurfaceProtocolError,
    );
  });

  it("builds current browser-visible backend_ready payloads without raw authority", () => {
    assert.deepEqual(
      buildReferenceWireBackendReadyPayload({
        backend: "neko",
        token: REFERENCE_WIRE_TOKEN,
        browserOwnerMode: () => "interactive",
        stealthMode: () => "strict",
      }),
      {
        backend: "neko",
        browser_owner_mode: "interactive",
        client_config_path: `/_ref/run-interaction-streams/${REFERENCE_WIRE_TOKEN}/neko/session`,
        iframe_path: `/_ref/run-interaction-streams/${REFERENCE_WIRE_TOKEN}/neko`,
        stealth_mode: "strict",
      },
    );
    assert.deepEqual(buildReferenceWireBackendReadyPayload({ backend: "cdp", token: REFERENCE_WIRE_TOKEN }), {
      backend: "cdp",
      browser_owner_mode: null,
      client_config_path: null,
      iframe_path: null,
      stealth_mode: null,
    });
  });

  it("builds current browser-visible SSE event payloads from package helpers", () => {
    const attached = REFERENCE_WIRE_SSE_EVENT_FIXTURES.find((fixture) => fixture.event === "attached");
    const frame = REFERENCE_WIRE_SSE_EVENT_FIXTURES.find((fixture) => fixture.event === "frame");
    const urlChanged = REFERENCE_WIRE_SSE_EVENT_FIXTURES.find((fixture) => fixture.event === "url_changed");
    const popupOpened = REFERENCE_WIRE_SSE_EVENT_FIXTURES.find((fixture) => fixture.event === "popup_opened");
    const popupClosed = REFERENCE_WIRE_SSE_EVENT_FIXTURES.find((fixture) => fixture.event === "popup_closed");

    assert.ok(attached);
    assert.deepEqual(
      buildReferenceWireAttachedPayload({
        runId: String(attached.data?.run_id),
        interactionId: String(attached.data?.interaction_id),
        browserSessionId: String(attached.data?.browser_session_id),
        viewport: attached.data?.viewport,
      }),
      attached.data,
    );

    assert.ok(frame);
    assert.deepEqual(
      buildReferenceWireFramePayload({
        sessionId: frame.data?.session_id,
        data: frame.data?.data_base64,
        metadata: frame.data?.metadata,
      }),
      frame.data,
    );

    assert.ok(urlChanged);
    assert.deepEqual(
      buildReferenceWireCompanionEventPayload({
        kind: "url_changed",
        url: urlChanged.data?.url,
        title: urlChanged.data?.title,
      }),
      { name: "url_changed", data: urlChanged.data },
    );

    assert.ok(popupOpened);
    assert.deepEqual(
      buildReferenceWireCompanionEventPayload({
        kind: "popup_opened",
        targetId: popupOpened.data?.targetId,
        url: popupOpened.data?.url,
      }),
      { name: "popup_opened", data: popupOpened.data },
    );

    assert.ok(popupClosed);
    assert.deepEqual(
      buildReferenceWireCompanionEventPayload({
        kind: "popup_closed",
        targetId: popupClosed.data?.targetId,
      }),
      { name: "popup_closed", data: popupClosed.data },
    );
  });

  it("keeps every fixture JSON-compatible", () => {
    for (const [name, fixture] of Object.entries(REFERENCE_WIRE_ALL_FIXTURES)) {
      assertJsonCompatible(fixture, name);
      assert.deepEqual(JSON.parse(JSON.stringify(fixture)), fixture, name);
    }
  });

  it("keeps browser-visible fixtures free of raw backend authority and credentials", () => {
    const serialized = JSON.stringify(REFERENCE_WIRE_BROWSER_VISIBLE_FIXTURES);
    const forbiddenPatterns = [
      /ws:\/\/|wss:\/\//i,
      /https?:\/\/(?:127\.0\.0\.1|localhost|neko|[^/"']*docker|[^/"']*allocator)/i,
      /https?:\/\/[^/"']*neko/i,
      /\bneko(?:\.internal|:\d+)/i,
      /\/devtools\/(?:browser|page)\//i,
      /\/json\/(?:version|list|new|activate|close)/i,
      /bearer\s+[a-z0-9._~+/-]+/i,
      /authorization/i,
      /allocator[_-]?(?:token|secret|password|credential)/i,
      /docker(?:Host|_host|[-_]host|:\/\/|\.sock)/i,
      /cdpWsUrl|cdp_ws_url|webSocketDebuggerUrl|wsUrl/i,
      /base_url|baseUrl|upstream_origin|upstreamOrigin/i,
    ];

    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(serialized, pattern);
    }
  });
});

function assertJsonCompatible(value: ReferenceWireFixture, label: string): void {
  assert.equal(isJsonCompatible(value), true, `${label} must contain only JSON-compatible values`);
}

function isJsonCompatible(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonCompatible);
  if (type !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonCompatible);
}
