// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPdppRemoteSurfaceTransport } from "./stream-viewer-remote-surface-transport.ts";

interface FetchCall {
  body: Record<string, unknown>;
  url: string;
}

function makeTransport() {
  const inputUrlRef = { current: "/input" };
  const viewportUrlRef = { current: "/viewport" };
  const clipboardUrlRef = { current: "/clipboard" };
  const presentationAttachmentReadyRef = { current: false };
  const logs: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const transport = createPdppRemoteSurfaceTransport({
    clipboardUrlRef,
    inputUrlRef,
    logDebug: (_event, payload) => {
      logs.push(payload ?? {});
    },
    presentationAttachmentReadyRef,
    viewportUrlRef,
  });
  transport.subscribe((message) => messages.push(message));
  return { clipboardUrlRef, inputUrlRef, logs, messages, presentationAttachmentReadyRef, transport, viewportUrlRef };
}

async function withFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
  work: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call = { body, url: String(input) };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  try {
    await work();
  } finally {
    globalThis.fetch = original;
  }
}

test("Remote Surface pointer/text intents use one input POST without host-side remapping", async () => {
  const { messages, transport } = makeTransport();
  const calls: FetchCall[] = [];
  await withFetch(
    (call) => {
      calls.push(call);
      return new Response(null, { status: 202 });
    },
    async () => {
      transport.send({
        action: "pointerdown",
        clickCount: 2,
        pointerType: "mouse",
        type: "pointer",
        x: 10,
        y: 20,
      });
      transport.send({ text: "typed once", type: "text" });
      await Promise.resolve();
    }
  );
  assert.deepEqual(
    calls.map((call) => call.body),
    [
      {
        action: "pointerdown",
        clickCount: 2,
        pointerType: "mouse",
        type: "pointer",
        x: 10,
        y: 20,
      },
      { text: "typed once", type: "text" },
    ]
  );
  assert.equal(messages.length, 0);
});

test("viewport matching queues before attachment and emits one correlated acknowledgement", async () => {
  const { messages, presentationAttachmentReadyRef, transport } = makeTransport();
  const calls: FetchCall[] = [];
  await withFetch(
    (call) => {
      calls.push(call);
      return new Response(JSON.stringify({ object: "run_interaction_stream_viewport_ack" }), {
        headers: { "Content-Type": "application/json" },
        status: 202,
      });
    },
    async () => {
      transport.send({ height: 600, requestId: 7, type: "viewport", width: 800 });
      await Promise.resolve();
      assert.equal(calls.length, 0);
      presentationAttachmentReadyRef.current = true;
      transport.setPresentationAttachmentReady(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.body, { height: 600, requestId: 7, type: "viewport", width: 800 });
  assert.deepEqual(messages, [
    {
      object: "run_interaction_stream_viewport_ack",
      requestId: 7,
      type: "viewport-applied",
    },
  ]);
});

test("SSE frames and keyboard focus enter the assembled session as inbound messages", () => {
  const { messages, transport } = makeTransport();
  transport.receiveSseMessage("frame", { data_base64: "AA==" });
  transport.receiveSseMessage("keyboard_focus", { element: { inputType: "text" }, focused: true });
  assert.deepEqual(messages, [
    { contentType: "image/jpeg", data: "AA==", sequence: 1, type: "frame" },
    {
      name: "keyboard_focus",
      payload: { element: { inputType: "text" }, focused: true },
      type: "backend_event",
    },
  ]);
});

test("remote selection reads use the clipboard endpoint and preserve request correlation", async () => {
  const { messages, transport } = makeTransport();
  const calls: FetchCall[] = [];
  await withFetch(
    (call) => {
      calls.push(call);
      return new Response(JSON.stringify({ text: "selected text" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    },
    async () => {
      transport.send({ requestId: 12, type: "read_remote_selection" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  );
  assert.deepEqual(calls, [
    { body: { action: "remote_to_local", requestId: 12, type: "clipboard" }, url: "/clipboard" },
  ]);
  assert.deepEqual(messages, [{ requestId: 12, text: "selected text", type: "remote-selection" }]);
});

test("clipboard controls use the dedicated authenticated clipboard endpoint", async () => {
  const { transport } = makeTransport();
  const calls: FetchCall[] = [];
  await withFetch(
    (call) => {
      calls.push(call);
      return new Response(JSON.stringify({ object: "run_interaction_stream_clipboard_ack" }), {
        headers: { "Content-Type": "application/json" },
        status: 202,
      });
    },
    async () => {
      assert.equal(await transport.sendClipboardText("manual text"), true);
    }
  );
  assert.deepEqual(calls, [
    { body: { action: "local_to_remote", text: "manual text", type: "clipboard" }, url: "/clipboard" },
  ]);
});
