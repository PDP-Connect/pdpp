import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDiagnosticsBuffer, redactDiagnosticsEvent } from "./index.ts";

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

    assert.equal(event.payload?.text, "[redacted]");
    assert.deepEqual(event.payload?.nested, {
      Authorization: "[redacted]",
      accessToken: "[redacted]",
      url: "[redacted]",
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
});
