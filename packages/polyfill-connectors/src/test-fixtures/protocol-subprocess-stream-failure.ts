// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runConnector } from "../connector-runtime.ts";

runConnector({
  name: "protocol-subprocess-stream-failure",
  async collect({ emit, emitRecord, reportStreamFailure }) {
    await emitRecord("healthy", { id: "healthy-1" });
    await emit({ type: "STATE", stream: "healthy", cursor: { last_id: "healthy-1" } });
    // Keep this fixture on the natural-exit path: the terminal helper's
    // explicit callback is intentionally neutralized below.
    process.exit = (() => undefined) as never;
    await reportStreamFailure?.("failed", "HTTP 500 from synthetic upstream", { retryable: true });
    // Model a long-lived connector whose remaining handles no longer keep the
    // process alive while the terminal handshake waits for runtime EOF.
    process.stdin.unref?.();
  },
});
