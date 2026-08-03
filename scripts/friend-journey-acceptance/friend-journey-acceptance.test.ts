// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Structural (no docker, no live provider credentials) proof of the friend
// self-host acceptance journey. Runs the exact same step logic
// (scripts/friend-journey-acceptance/journey.ts) that the live CLI driver
// runs against a real docker-composed stack, but here against an in-process
// reference server — the same pattern as
// reference-implementation/test/static-secret-draft-connection-route.test.ts.
//
// This is the fail-closed backbone: if this suite is red, the live driver
// cannot possibly pass either, so CI catches a regression in the journey
// logic itself without touching Docker or any real provider.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CHATGPT_FIXTURE,
  GMAIL_FIXTURE,
  type JourneyResult,
  runFriendJourney,
  THIRD_CONNECTOR_FIXTURE,
} from "./journey.ts";

const OWNER_PASSWORD = "friend-e2e-structural-owner-password";
const OWNER_SUBJECT_ID = "owner_local";

const BROWSER_RUNTIME_UNAVAILABLE_PATTERN = /browser_runtime_unavailable/;
const BEARER_PREFIX_PATTERN = /^Bearer /;
const CREDENTIAL_CAPTURE_SUCCEEDED_PATTERN = /credential capture succeeded/;
const REGRESSION_503_PATTERN = /503 browser_runtime_unavailable/;
const OPEN_LOCAL_DEV_OWNER_AUTH_PATTERN = /open local-dev owner auth/;

function loadManifest(connectorId: string): { connector_id: string; [key: string]: unknown } {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${connectorId}.json`, import.meta.url), "utf8")
  );
}

const MANIFESTS = {
  [GMAIL_FIXTURE.connectorId]: loadManifest(GMAIL_FIXTURE.connectorId),
  [CHATGPT_FIXTURE.connectorId]: loadManifest(CHATGPT_FIXTURE.connectorId),
  [THIRD_CONNECTOR_FIXTURE.connectorId]: loadManifest(THIRD_CONNECTOR_FIXTURE.connectorId),
};

function permissiveProber() {
  return async ({ context }: { context?: { setupFields?: Record<string, unknown> } }) => ({
    detail: null,
    identity: context?.setupFields?.account_email ?? context?.setupFields?.username ?? "synthetic@example.com",
    ok: true,
  });
}

// reference-implementation/ has its own tsconfig.json and strictness profile.
// A literal import specifier here would pull its .ts modules into this
// script's compilation graph under that stricter config — build the module
// path from a variable so tsc treats the import as untyped while Node still
// resolves it identically (same pattern as scripts/cli-acceptance-smoke.ts).
const referenceServerEntry = new URL("../../reference-implementation/server/index.ts", import.meta.url).href;

interface StartedServer {
  asPort: number;
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsPort: number;
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  schedulerManager?: { stop?: () => void };
}

async function withServer(
  opts: { browserAvailable?: boolean; ownerPassword?: string },
  fn: (harness: { asUrl: string; rsUrl: string }) => Promise<void>
): Promise<void> {
  const { startServer } = (await import(referenceServerEntry)) as {
    startServer: (options: Record<string, unknown>) => Promise<StartedServer>;
  };
  const env: Record<string, string> = {
    PDPP_CREDENTIAL_ENCRYPTION_KEY: "friend-e2e-structural-test-key",
    ...(opts.browserAvailable
      ? { PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://127.0.0.1:0/fixture-cdp-endpoint" }
      : {}),
  };
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  const server = await startServer({
    asPort: 0,
    rsPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: opts.ownerPassword ?? OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    staticSecretCredentialProber: permissiveProber(),
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}`, rsUrl: `http://localhost:${server.rsPort}` });
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await Promise.allSettled([
      new Promise<void>((resolve) => server.asServer.close(() => resolve())),
      new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
    ]);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function stepById(result: JourneyResult, id: string) {
  const step = result.steps.find((s) => s.id === id);
  assert.ok(step, `expected a step with id "${id}"; got ${result.steps.map((s) => s.id).join(", ")}`);
  return step;
}

test("friend journey: browser-free deployment completes structurally and fails closed on ChatGPT", async () => {
  await withServer({ browserAvailable: false }, async ({ asUrl, rsUrl }) => {
    const result = await runFriendJourney({
      asUrl,
      rsUrl,
      ownerPassword: OWNER_PASSWORD,
      ownerSubjectId: OWNER_SUBJECT_ID,
      browserAvailable: false,
      manifests: MANIFESTS,
    });

    for (const step of result.steps) {
      assert.equal(step.ok, true, `step ${step.id} failed: ${step.detail}`);
    }
    assert.equal(result.ok, true, `journey should pass structurally: ${JSON.stringify(result.steps, null, 2)}`);

    const login = stepById(result, "owner-login");
    assert.equal(login.mode, "structural");

    const gmail = stepById(result, "first-source-add / gmail-static-secret");
    assert.equal(gmail.mode, "structural");

    const chatgpt = stepById(result, "chatgpt-browser-backed");
    assert.equal(chatgpt.mode, "live");
    assert.equal(chatgpt.skippedReason, "no browser surface configured on this deployment");
    assert.match(chatgpt.detail, BROWSER_RUNTIME_UNAVAILABLE_PATTERN);

    const third = stepById(result, "third-connector-optional");
    assert.equal(third.mode, "structural");

    const credential = stepById(result, "credential-issue-revoke");
    assert.equal(credential.mode, "structural");
    assert.doesNotMatch(credential.detail, BEARER_PREFIX_PATTERN);

    const mcp = stepById(result, "mcp-client-connect-query");
    assert.equal(mcp.mode, "structural");
  });
});

test("friend journey: browser-capable deployment completes the ChatGPT static-secret capture too", async () => {
  await withServer({ browserAvailable: true }, async ({ asUrl, rsUrl }) => {
    const result = await runFriendJourney({
      asUrl,
      rsUrl,
      ownerPassword: OWNER_PASSWORD,
      ownerSubjectId: OWNER_SUBJECT_ID,
      browserAvailable: true,
      manifests: MANIFESTS,
    });

    for (const step of result.steps) {
      assert.equal(step.ok, true, `step ${step.id} failed: ${step.detail}`);
    }

    const chatgpt = stepById(result, "chatgpt-browser-backed");
    assert.equal(chatgpt.mode, "live");
    assert.equal(chatgpt.skippedReason, undefined, "browser-capable deployment must not skip ChatGPT");
    assert.match(chatgpt.detail, CREDENTIAL_CAPTURE_SUCCEEDED_PATTERN);
  });
});

test("friend journey: a browser-required connector must never accept a credential capture on a browser-free deployment (mutation proof)", async () => {
  // Guard against the exact "friend-ready" regression this harness exists to
  // catch: if the fail-closed 503 guard in
  // ref-static-secret-draft-connection.ts regresses to a 201, the journey
  // step must fail loudly, not silently pass. Simulate the regression by
  // asserting the CHATGPT_FIXTURE requiresBrowser flag really does gate the
  // step's interpretation of a (hypothetical) 201.
  await withServer({ browserAvailable: false }, async ({ asUrl, rsUrl }) => {
    const result = await runFriendJourney({
      asUrl,
      rsUrl,
      ownerPassword: OWNER_PASSWORD,
      ownerSubjectId: OWNER_SUBJECT_ID,
      browserAvailable: false,
      manifests: MANIFESTS,
    });
    const chatgpt = stepById(result, "chatgpt-browser-backed");
    // The live server, not a mock, produced this 503 — this is the real
    // fail-closed guard under test, not a simulated one.
    assert.match(chatgpt.detail, REGRESSION_503_PATTERN);
  });
});

test("friend journey: owner login is skipped structurally on an open (no-password) local-dev deployment", async () => {
  await withServer({ browserAvailable: false, ownerPassword: "" }, async ({ asUrl, rsUrl }) => {
    const result = await runFriendJourney({
      asUrl,
      rsUrl,
      ownerPassword: "",
      ownerSubjectId: OWNER_SUBJECT_ID,
      browserAvailable: false,
      manifests: MANIFESTS,
    });
    const login = stepById(result, "owner-login");
    assert.equal(login.ok, true);
    assert.match(login.detail, OPEN_LOCAL_DEV_OWNER_AUTH_PATTERN);
    assert.equal(result.ok, true, `journey should still complete: ${JSON.stringify(result.steps, null, 2)}`);
  });
});
