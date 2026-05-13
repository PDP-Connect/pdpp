import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeRemoteSurfaceSessionBroker, TEST_REMOTE_SURFACE_CAPABILITIES } from "./index.ts";

describe("FakeRemoteSurfaceSessionBroker", () => {
  it("creates, attaches, authorizes, and revokes sessions", async () => {
    const broker = new FakeRemoteSurfaceSessionBroker();
    const created = await broker.createSession({ capabilities: TEST_REMOTE_SURFACE_CAPABILITIES });

    assert.equal(created.session.sessionId, "session_1");
    assert.notEqual(created.tokenDescriptor.tokenId, created.token);

    const attached = await broker.attachSession({ token: created.token });
    assert.equal(attached.session.sessionId, created.session.sessionId);
    assert.equal(typeof attached.session.attachedAt, "number");

    const authorized = await broker.authorizeSession({ token: created.token }, "input");
    assert.equal(authorized.sessionId, created.session.sessionId);

    const revoked = await broker.revokeSession({ sessionId: created.session.sessionId }, "resolved");
    assert.equal(revoked?.revocationReason, "resolved");
    await assert.rejects(() => broker.authorizeSession({ token: created.token }, "input"), /revoked/);
  });

  it("redacts diagnostics captured by fake channels", async () => {
    const broker = new FakeRemoteSurfaceSessionBroker();
    const created = await broker.createSession({ capabilities: TEST_REMOTE_SURFACE_CAPABILITIES });
    await broker.dispatchClipboard(
      { sessionId: created.session.sessionId },
      { type: "clipboard", action: "local_to_remote", text: "secret" },
    );

    const diagnostics = await broker.readDiagnostics({ sessionId: created.session.sessionId });
    const payload = diagnostics.events[0]?.payload;
    assert.equal(payload && typeof payload === "object" && "text" in payload ? payload.text : null, "[redacted]");
  });
});
