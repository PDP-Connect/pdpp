import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAdapterLifecycleDiagnosticsEvent,
  buildBackendReadinessDiagnosticsEvent,
  buildClipboardActionDiagnosticsEvent,
  buildEventChannelDiagnosticsEvent,
  buildInputPipelineDiagnosticsEvent,
  buildMediaSettleDiagnosticsEvent,
  buildViewportTransitionDiagnosticsEvent,
  classifyRemoteSurfaceInput,
  createDiagnosticsBuffer,
  redactDiagnosticsEvent,
} from "./index.ts";

describe("diagnostics helpers", () => {
  it("redacts secret keys, clipboard text, and raw backend endpoints", () => {
    const event = redactDiagnosticsEvent({
      type: "input",
      timestamp: 1,
      payload: {
        text: "secret paste",
        nested: {
          Authorization: "Bearer abc",
          accessToken: "secret",
          url: "ws://127.0.0.1/devtools/browser/x",
        },
      },
    });

    assert.equal(event.payload && "text" in event.payload ? event.payload.text : undefined, "[redacted]");
    assert.deepEqual(event.payload && "nested" in event.payload ? event.payload.nested : undefined, {
      Authorization: "[redacted]",
      accessToken: "[redacted]",
      url: "[redacted]",
    });
  });

  it("redacts clipboard contents, raw target URLs, auth metadata, CDP bearer paths, and allocator credentials", () => {
    const event = redactDiagnosticsEvent({
      type: "backend.readiness",
      timestamp: 1,
      payload: {
        allocatorCredentials: {
          username: "neko",
          password: "secret",
        },
        authMetadata: {
          authorization: "Bearer route-token",
          cookie: "session=secret",
        },
        cdpBearerPath: "/json/version?authorization=Bearer%20abc",
        clipboard: {
          text: "private clipboard",
        },
        targetUrl: "https://user:pass@example.test/run?access_token=secret",
        websocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      },
      replay: {
        input: {
          headers: {
            authorization: "Bearer replay-token",
          },
          url: "http://127.0.0.1:9222/json/version",
        },
        output: {
          ready: true,
        },
      },
    });

    assert.deepEqual(event.payload, {
      allocatorCredentials: "[redacted]",
      authMetadata: "[redacted]",
      cdpBearerPath: "[redacted]",
      clipboard: "[redacted]",
      targetUrl: "[redacted]",
      websocketDebuggerUrl: "[redacted]",
    });
    assert.deepEqual(event.replay, {
      input: {
        headers: "[redacted]",
        url: "[redacted]",
      },
      output: {
        ready: true,
      },
    });
  });

  it("keeps a bounded buffer with monotonic cursors", () => {
    const buffer = createDiagnosticsBuffer({ capacity: 2 });
    buffer.push({ type: "a", timestamp: 1 });
    const first = buffer.read();
    buffer.push({ type: "b", timestamp: 2 });
    buffer.push({ type: "c", timestamp: 3 });

    assert.deepEqual(
      buffer.read().events.map((event) => event.type),
      ["b", "c"],
    );
    assert.deepEqual(
      buffer.read(first.cursor).events.map((event) => event.type),
      ["b", "c"],
    );
  });

  it("notifies host bridge hooks with the same redacted event that enters the buffer", () => {
    const buffer = createDiagnosticsBuffer({ capacity: 1 });
    const bridged: unknown[] = [];
    const subscription = buffer.subscribe((event) => bridged.push(event));

    buffer.push({ type: "clipboard.action", timestamp: 1, payload: { text: "secret paste" } });
    subscription.unsubscribe();
    buffer.push({ type: "clipboard.action", timestamp: 2, payload: { text: "ignored" } });

    assert.equal(bridged.length, 1);
    assert.deepEqual(bridged[0], { type: "clipboard.action", timestamp: 1, payload: { text: "[redacted]" } });
    assert.deepEqual(buffer.read(0).events.map((event) => event.timestamp), [2]);
  });

  it("defines typed redacted diagnostics events for package telemetry categories", () => {
    const events = [
      buildInputPipelineDiagnosticsEvent({
        payload: { type: "pointer", action: "wheel", x: 1, y: 2, deltaY: 120 },
        timestamp: 1,
      }),
      buildViewportTransitionDiagnosticsEvent({
        next: { type: "viewport", width: 390, height: 560, timestamp: 2 },
        previous: { type: "viewport", width: 390, height: 844, timestamp: 1 },
        timestamp: 2,
        transition: {
          kind: "keyboard-occlusion",
          keyboardInsetBottom: 284,
          reason: "editable-focus-with-keyboard-shaped-occlusion",
          remoteResize: "hold",
        },
      }),
      buildClipboardActionDiagnosticsEvent({
        payload: { type: "clipboard", action: "local_to_remote", text: "secret paste" },
        textLengthBucket: "1-16",
        timestamp: 3,
      }),
      buildEventChannelDiagnosticsEvent({
        event: { type: "lifecycle", sessionId: "session_1", state: "ready", timestamp: 4 },
        timestamp: 4,
      }),
      buildAdapterLifecycleDiagnosticsEvent({ adapter: "neko", lifecycle: "ready", timestamp: 5 }),
      buildBackendReadinessDiagnosticsEvent({ backend: "cdp", ready: true, timestamp: 6 }),
      buildMediaSettleDiagnosticsEvent({ status: "settled", timestamp: 7 }),
    ];

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "input.pipeline",
        "viewport.transition",
        "clipboard.action",
        "event.channel",
        "adapter.lifecycle",
        "backend.readiness",
        "media.settle",
      ],
    );
    assert.equal(events[0]?.type === "input.pipeline" ? events[0].payload.classification : undefined, "wheel");
    assert.equal(events[2]?.type === "clipboard.action" ? events[2].payload.textLengthBucket : undefined, "1-16");
  });

  it("preserves replay data for viewport and input classification decisions without logging raw text", () => {
    const input = createDiagnosticsBuffer({ capacity: 10 }).push(
      buildInputPipelineDiagnosticsEvent({
        payload: { type: "text", text: "do not log", timestamp: 10 },
      }),
    );
    const viewport = buildViewportTransitionDiagnosticsEvent({
      next: { type: "viewport", width: 844, height: 390 },
      timestamp: 11,
      transition: {
        kind: "orientation-change",
        keyboardInsetBottom: 0,
        reason: "orientation-or-aspect-change",
        remoteResize: "post",
      },
    });

    assert.equal(classifyRemoteSurfaceInput({ type: "clipboard", action: "paste", text: "secret" }), "clipboard-paste");
    assert.equal(input.payload?.classification, "text");
    assert.equal(input.replay?.input?.text, "[redacted]");
    assert.deepEqual(input.replay?.output, {
      classification: "text",
      inputType: "text",
    });
    assert.equal(viewport.replay.output.kind, "orientation-change");
    assert.equal(viewport.replay.input?.next && typeof viewport.replay.input.next === "object", true);
  });
});
