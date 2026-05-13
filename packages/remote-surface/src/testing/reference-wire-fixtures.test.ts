import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REFERENCE_WIRE_ALL_FIXTURES,
  REFERENCE_WIRE_BROWSER_VISIBLE_FIXTURES,
  REFERENCE_WIRE_INPUT_PAYLOAD_FIXTURES,
  REFERENCE_WIRE_MINT_RESPONSE_FIXTURE,
  REFERENCE_WIRE_NEKO_CLIENT_CONFIG_FIXTURE,
  REFERENCE_WIRE_SSE_EVENT_FIXTURES,
  REFERENCE_WIRE_TARGET_REGISTRATION_RESPONSE_FIXTURE,
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
