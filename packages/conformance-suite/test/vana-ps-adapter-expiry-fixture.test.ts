// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// `VanaPsAdapter.expiredGrantToken` against a real HTTP fixture, not a
// fabricated token.
//
// Protected risk: the AS-8 expired-grant case (grant-lifecycle.ts) trusts
// whatever `TargetAdapter.expiredGrantToken` hands it. If the adapter's
// journey silently returned a token nobody proved worked pre-expiry, or one
// bound to the wrong client, the case's later 403 would not isolate expiry as
// its cause — the same blind spot the revocation case's before/after pair
// exists to close. This file drives the real adapter method against a
// minimal server implementing the actual authorize -> review -> approve ->
// token -> records contract, with three discriminating fixtures:
//
//   - deny-all: refuses every request, including owner bootstrap. The journey
//     itself never produces a grant, so the hook returns null and AS-8
//     reports skip — not a false pass on a token nothing validated.
//   - deny-reads: issues a grant normally but refuses every stream read. The
//     POSITIVE control (the pre-expiry read that must succeed before the hook
//     will return a token) fails here with a non-200, so the hook throws and
//     AS-8 reports fail, naming the broken control rather than skip.
//   - empty-data / wrong-record: the pre-expiry read returns 200 but with no
//     matching seeded record. The positive control's body check must catch
//     this and throw, distinguishing "control never ran" (skip) from
//     "control ran and found nothing to trust" (fail).
//   - expiry-ignored: keeps serving the token as valid after the wait. AS-8's
//     NEGATIVE oracle must fail here: an implementation that (incorrectly)
//     never enforces expiry is exactly the defect AS-8 exists to catch.
//   - correctly-enforces: serves before expiry, refuses with 403
//     grant_expired after. AS-8 passes.
//
// A final case (no expiryFixture configured) proves the adapter returns null
// rather than fabricating a token when the deployment declares none.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { makeContext, runCase } from "../src/harness/runner.ts";
import { VanaPsAdapter } from "../src/targets/vana-ps-adapter.ts";
import { GRANT_LIFECYCLE_CASES } from "../src/tests/grant-lifecycle.ts";

const AS8_EXPIRY_CASE = GRANT_LIFECYCLE_CASES.find((c) => c.caseId === "AS-8/expired-grant-refused");
assert.ok(AS8_EXPIRY_CASE, "AS-8/expired-grant-refused must exist");

const EXPIRED_GRANT_SERVED_RECORDS = /expired grant served records/;
const AUTHORIZATION_FAILED = /could not establish authorization/;
const NO_EXPIRED_GRANT_TOKEN = /no expired-grant token/;
const POSITIVE_CONTROL_NON_200 = /pre-expiry read of stream .* returned \d+, not 200/;
const POSITIVE_CONTROL_NO_MATCH = /did not contain a record matching expectedRecord/;

const OWNER_BOOTSTRAP = "owner-bootstrap-stub";
const OWNER_TOKEN = "owner-session-stub";
const CLIENT_ID = "music_recommendations";
const EXPIRY_CLIENT_ID = "expiring_widget";
const REDIRECT_URI = "https://client.example/callback";
const STREAM_NAME = "top_artists";
// Real, short waits (a couple hundred ms), not a wall-clock monkeypatch —
// small enough to keep this hermetic test fast, large enough that the
// fixture's own setTimeout-based "expiry" reliably elapses before the
// adapter's post-wait read.
const LIFETIME_SECONDS = 0.2;
const EXPECTED_RECORD = { id: "art_1", name: "Artist 1" };

type Mode = "deny-all" | "deny-reads" | "empty-data" | "wrong-record" | "expiry-ignored" | "correctly-enforces";

/**
 * Implements the six routes `VanaPsAdapter.expiredGrantToken` needs: owner
 * bootstrap, authorize, review, approve, token, and the RS records read. Only
 * grants issued to `EXPIRY_CLIENT_ID` carry a lifetime; `CLIENT_ID` is
 * registered but never exercised here, mirroring the real deployment's
 * per-client policy.
 */
class ExpiryFixture {
  private server?: Server;
  private port = 0;
  private sessionId = 0;
  private code: string | undefined;
  private pendingClientId: string | undefined;
  private readonly tokens = new Map<string, { issuedAtMs: number; clientId: string }>();
  private readonly mode: Mode;

  constructor(mode: Mode) {
    this.mode = mode;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.handle(req.method ?? "GET", req.url ?? "/", Buffer.concat(chunks).toString("utf8"), res);
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  private handle(method: string, url: string, body: string, res: import("node:http").ServerResponse): void {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (this.mode === "deny-all") {
      // Refuses everything, including owner bootstrap: the adapter's journey
      // cannot even obtain a token to prove the positive control with.
      send(403, { error: "access_denied" });
      return;
    }

    if (method === "POST" && url === "/pdpp/v1/owner/token") {
      send(200, { access_token: OWNER_TOKEN });
      return;
    }

    if (method === "POST" && url === "/pdpp/v1/authorize") {
      const parsed = JSON.parse(body) as { client_id?: string };
      this.pendingClientId = parsed.client_id;
      this.sessionId += 1;
      send(201, { session_id: String(this.sessionId) });
      return;
    }

    if (method === "GET" && url === `/pdpp/v1/authorize/${this.sessionId}/review`) {
      send(200, { review: { review_digest: "digest-1" } });
      return;
    }

    if (method === "POST" && url === `/pdpp/v1/authorize/${this.sessionId}/approve`) {
      this.code = `code-${this.sessionId}`;
      const redirect = new URL(REDIRECT_URI);
      redirect.searchParams.set("code", this.code);
      send(200, { redirect_uri: redirect.toString(), grant_id: `grant-${this.sessionId}` });
      return;
    }

    if (method === "POST" && url === "/pdpp/v1/token") {
      const form = new URLSearchParams(body);
      const submittedCode = form.get("code");
      if (!this.code || submittedCode !== this.code) {
        send(400, { error: "invalid_grant" });
        return;
      }
      const accessToken = `access-${this.sessionId}`;
      this.tokens.set(accessToken, { issuedAtMs: Date.now(), clientId: this.pendingClientId ?? "" });
      send(200, { access_token: accessToken });
      return;
    }

    if (method === "GET" && url === `/v1/streams/${STREAM_NAME}/records`) {
      const auth = res.req.headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
      const entry = token ? this.tokens.get(token) : undefined;
      if (!entry) {
        send(401, { error: { code: "invalid_token" } });
        return;
      }
      if (this.mode === "deny-reads") {
        send(403, { error: { code: "access_denied" } });
        return;
      }
      const elapsedSeconds = (Date.now() - entry.issuedAtMs) / 1000;
      const expired = entry.clientId === EXPIRY_CLIENT_ID && elapsedSeconds >= LIFETIME_SECONDS;
      if (expired && this.mode === "correctly-enforces") {
        send(403, { error: { code: "grant_expired" } });
        return;
      }
      if (this.mode === "empty-data") {
        send(200, { data: [] });
        return;
      }
      if (this.mode === "wrong-record") {
        send(200, { data: [{ object: "record", id: "art_9", stream: STREAM_NAME, data: { name: "Someone Else" } }] });
        return;
      }
      // "expiry-ignored" always falls through here, even once expired — the
      // defect AS-8 must catch. Envelope matches the real RS's toRecordJson:
      // record key at top-level `id`, remaining seeded fields nested under
      // `data`.
      send(200, {
        data: [{ object: "record", id: EXPECTED_RECORD.id, stream: STREAM_NAME, data: { name: EXPECTED_RECORD.name } }],
      });
      return;
    }

    send(404, { error: "not_found" });
  }
}

function makeAdapter(fixture: ExpiryFixture, options?: { readonly expiryFixture?: false }): VanaPsAdapter {
  return new VanaPsAdapter({
    baseUrl: fixture.baseUrl,
    capabilities: {
      blobs: false,
      incrementalSync: false,
      ownerTokens: true,
      refreshTokens: false,
      selfExport: false,
      separatedDeployment: false,
      singleUseGrants: false,
      views: false,
    },
    clientId: CLIENT_ID,
    ...(options?.expiryFixture === false
      ? {}
      : {
          expiryFixture: {
            clientId: EXPIRY_CLIENT_ID,
            redirectUri: REDIRECT_URI,
            grantLifetimeSeconds: LIFETIME_SECONDS,
            expectedRecord: EXPECTED_RECORD,
          },
        }),
    ownerBootstrapToken: OWNER_BOOTSTRAP,
    redirectUri: REDIRECT_URI,
    roles: ["authorization-server", "resource-server"],
    sourceId: "test-source",
    streams: [
      { name: STREAM_NAME, fields: ["id", "name"], primaryKey: ["id"], recordCount: 1, semantics: "mutable_state" },
    ],
    targetId: "vana-ps-expiry-fixture",
    targetVersion: "0.0.0-test",
  });
}

describe("VanaPsAdapter.expiredGrantToken drives a real operator-policy journey", () => {
  it("fails when a configured fixture cannot establish authorization (deny-all)", async () => {
    const fixture = new ExpiryFixture("deny-all");
    await fixture.start();
    const adapter = makeAdapter(fixture);
    try {
      await assert.rejects(() => adapter.expiredGrantToken(), AUTHORIZATION_FAILED);
    } finally {
      await fixture.stop();
    }
  });

  it("AS-8/expired-grant-refused fails when configured authorization fails (deny-all)", async () => {
    const fixture = new ExpiryFixture("deny-all");
    await fixture.start();
    const adapter = makeAdapter(fixture);
    try {
      const { streams } = await adapter.setup();
      const result = await runCase(AS8_EXPIRY_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "fail");
    } finally {
      await fixture.stop();
    }
  });

  it("throws when the positive control's read is denied after a grant was issued (deny-reads)", async () => {
    const fixture = new ExpiryFixture("deny-reads");
    await fixture.start();
    const adapter = makeAdapter(fixture);
    try {
      await assert.rejects(() => adapter.expiredGrantToken(), POSITIVE_CONTROL_NON_200);
    } finally {
      await fixture.stop();
    }
  });

  it("AS-8/expired-grant-refused fails (not skip) when the positive control's read is denied (deny-reads)", async () => {
    const fixture = new ExpiryFixture("deny-reads");
    await fixture.start();
    const adapter = makeAdapter(fixture);
    try {
      const { streams } = await adapter.setup();
      const result = await runCase(AS8_EXPIRY_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "fail", "a broken positive control must not read as absence of evidence");
      assert.match(result.outcome === "fail" ? (result.detail ?? "") : "", POSITIVE_CONTROL_NON_200);
    } finally {
      await fixture.stop();
    }
  });

  it("throws when the positive control's read returns 200 with no records (empty-data)", async () => {
    const fixture = new ExpiryFixture("empty-data");
    await fixture.start();
    const adapter = makeAdapter(fixture);
    try {
      await assert.rejects(() => adapter.expiredGrantToken(), POSITIVE_CONTROL_NO_MATCH);
    } finally {
      await fixture.stop();
    }
  });

  it("throws when the positive control's read returns a record that does not match expectedRecord (wrong-record)", async () => {
    const fixture = new ExpiryFixture("wrong-record");
    await fixture.start();
    const adapter = makeAdapter(fixture);
    try {
      await assert.rejects(() => adapter.expiredGrantToken(), POSITIVE_CONTROL_NO_MATCH);
    } finally {
      await fixture.stop();
    }
  });

  it("AS-8/expired-grant-refused fails against a target that ignores expiry (negative oracle)", async () => {
    const fixture = new ExpiryFixture("expiry-ignored");
    await fixture.start();
    const adapter = makeAdapter(fixture);
    try {
      const { streams } = await adapter.setup();
      const result = await runCase(AS8_EXPIRY_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "fail", "a target that serves an expired grant must not pass AS-8");
      assert.match(result.outcome === "fail" ? (result.detail ?? "") : "", EXPIRED_GRANT_SERVED_RECORDS);
    } finally {
      await fixture.stop();
    }
  });

  it("AS-8/expired-grant-refused passes against a target that correctly enforces the configured lifetime", async () => {
    const fixture = new ExpiryFixture("correctly-enforces");
    await fixture.start();
    const adapter = makeAdapter(fixture);
    try {
      const { streams } = await adapter.setup();
      const result = await runCase(AS8_EXPIRY_CASE, makeContext(adapter, streams));
      assert.equal(
        result.outcome,
        "pass",
        result.outcome === "fail" || result.outcome === "skip" ? (result.detail ?? "") : "expected pass"
      );
    } finally {
      await fixture.stop();
    }
  });

  it("AS-8/expired-grant-refused reports skip when the deployment configures no expiryFixture", async () => {
    const fixture = new ExpiryFixture("correctly-enforces");
    await fixture.start();
    const adapter = makeAdapter(fixture, { expiryFixture: false });
    try {
      const { streams } = await adapter.setup();
      const result = await runCase(AS8_EXPIRY_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "skip");
      assert.match(result.detail ?? "", NO_EXPIRED_GRANT_TOKEN);
    } finally {
      await fixture.stop();
    }
  });
});
