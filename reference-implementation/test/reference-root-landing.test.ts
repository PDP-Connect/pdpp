// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Content-negotiated AS/RS root landing pages.
 *
 * Spec: openspec/changes/split-public-site-and-operator-console
 *
 * Pins three behaviors:
 *   (a) Accept: application/json returns the existing discovery JSON.
 *   (b) Accept: text/html returns the operator landing page (200, text/html,
 *       contains the configured console origin and the well-known link).
 *   (c) clients with no Accept header keep the legacy JSON default (no
 *       silent UA-sniff redirect to HTML).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";
import {
  __testOnly,
  resolveConsoleOriginForLanding,
  servedRootLandingIfBrowser,
} from "../server/reference-root-landing.ts";

const REGEXP_1 = /<Provider>/;
const REGEXP_2 = /application\/json/;
const REGEXP_3 = /text\/html/;
const REGEXP_4 = /<!DOCTYPE html>/i;
const REGEXP_5 = /\.well-known\/oauth-authorization-server/;
const REGEXP_6 = /application\/json/;
const REGEXP_7 = /application\/json/;
const REGEXP_8 = /text\/html/;
const REGEXP_9 = /<!DOCTYPE html>/i;
const REGEXP_10 = /\.well-known\/oauth-protected-resource/;
const REGEXP_11 = /application\/json/;
const REGEXP_12 = /<!DOCTYPE html>/;
const REGEXP_13 = /Test Provider/;
const REGEXP_14 = /\.well-known\/oauth-authorization-server/;
const REGEXP_15 = /\.well-known\/oauth-protected-resource/;
const REGEXP_16 = /Test &lt;Provider&gt;/;

const CONSOLE_ORIGIN = "http://console.test.local:9999";
type TestServer = Awaited<ReturnType<typeof startServer>>;
interface LandingRequest {
  accepts?: (types: string[]) => string | false;
  headers?: { accept?: unknown };
  query?: { format?: unknown };
}
interface LandingResponse {
  send: (body: string) => void;
  setHeader: (name: string, value: string) => void;
}
interface Sent {
  body: string | null;
  headers: Record<string, string>;
  status: number | null;
}

async function jsonObject(resp: Response): Promise<Record<string, unknown>> {
  const raw: unknown = await resp.json();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("expected JSON object");
  }
  return raw as Record<string, unknown>;
}

async function closeServer(server: TestServer): Promise<void> {
  try {
    server.schedulerManager?.stop?.();
  } catch {
    /* intentionally empty */
  }
  try {
    server.abortStartupBackfill?.("test shutdown");
  } catch {
    /* intentionally empty */
  }
  const backfillDone = server.startupBackfillDone
    ? new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        Promise.resolve(server.startupBackfillDone)
          .catch(() => {
            /* intentionally empty */
          })
          .finally(() => {
            clearTimeout(timer);
            resolve();
          });
      })
    : Promise.resolve();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
    backfillDone,
    server.controller?.drainActiveRuns
      ? server.controller.drainActiveRuns(1000).catch(() => {
          /* intentionally empty */
        })
      : Promise.resolve(),
  ]);
}

async function withServer(fn: (input: { asUrl: string; rsUrl: string }) => Promise<void>): Promise<void> {
  const previousReferenceOrigin = process.env.PDPP_REFERENCE_ORIGIN;
  process.env.PDPP_REFERENCE_ORIGIN = CONSOLE_ORIGIN;
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    awaitStartupBackfill: false,
    dbPath: ":memory:",
    ignoreAmbientPublicUrls: true,
    quiet: true,
    rsPort: 0,
  });
  try {
    const asAddress = server.asServer.address();
    const rsAddress = server.rsServer.address();
    if (!asAddress || typeof asAddress === "string" || !rsAddress || typeof rsAddress === "string") {
      throw new Error("expected TCP server addresses");
    }
    const asUrl = `http://127.0.0.1:${asAddress.port}`;
    const rsUrl = `http://127.0.0.1:${rsAddress.port}`;
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
    if (previousReferenceOrigin === undefined) {
      delete process.env.PDPP_REFERENCE_ORIGIN;
    } else {
      process.env.PDPP_REFERENCE_ORIGIN = previousReferenceOrigin;
    }
  }
}

// ─── unit: negotiation helper ────────────────────────────────────────────

test("servedRootLandingIfBrowser falls through when no Accept header is set", () => {
  const req: LandingRequest = { accepts: () => false, headers: {}, query: {} };
  const sent: Sent = { body: null, headers: {}, status: null };
  const res: LandingResponse = {
    send(b) {
      sent.body = b;
    },
    setHeader(k, v) {
      sent.headers[k] = v;
    },
  };
  const handled = servedRootLandingIfBrowser(req, res, {
    providerName: "Test",
    referenceRevision: "rev",
    role: "authorization_server",
  });
  assert.equal(handled, false);
  assert.equal(sent.body, null);
});

test("servedRootLandingIfBrowser falls through for explicit ?format=json", () => {
  const req = {
    accepts: () => "html",
    headers: { accept: "text/html" },
    query: { format: "json" },
  };
  const sent: Sent = { body: null, headers: {}, status: null };
  const res: LandingResponse = {
    send(b) {
      sent.body = b;
    },
    setHeader() {
      /* intentionally empty */
    },
  };
  const handled = servedRootLandingIfBrowser(req, res, {
    providerName: "Test",
    referenceRevision: "rev",
    role: "authorization_server",
  });
  assert.equal(handled, false);
});

test("servedRootLandingIfBrowser falls through for Accept: */* (curl default)", () => {
  const req = {
    accepts: () => "html",
    headers: { accept: "*/*" },
    query: {},
  };
  const sent: Sent = { body: null, headers: {}, status: null };
  const res: LandingResponse = {
    send(b) {
      sent.body = b;
    },
    setHeader() {
      /* intentionally empty */
    },
  };
  const handled = servedRootLandingIfBrowser(req, res, {
    providerName: "Test",
    referenceRevision: "rev",
    role: "authorization_server",
  });
  assert.equal(handled, false);
});

test("servedRootLandingIfBrowser renders HTML for Accept: text/html", () => {
  const req = {
    accepts: (types: string[]) => (types.includes("html") ? "html" : false),
    headers: { accept: "text/html" },
    query: {},
  };
  const sent: Sent = { body: null, headers: {}, status: null };
  const res: LandingResponse = {
    send(b) {
      sent.body = b;
    },
    setHeader(k, v) {
      sent.headers[k] = v;
    },
  };
  const handled = servedRootLandingIfBrowser(req, res, {
    consoleOrigin: CONSOLE_ORIGIN,
    providerName: "Test Provider",
    referenceRevision: "rev-abc",
    role: "authorization_server",
  });
  assert.equal(handled, true);
  assert.equal(sent.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(sent.headers["X-Robots-Tag"], "noindex, nofollow");
  assert.ok(sent.body);
  assert.match(sent.body, REGEXP_12);
  assert.match(sent.body, REGEXP_13);
  assert.match(sent.body, new RegExp(CONSOLE_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sent.body, REGEXP_14);
});

test("servedRootLandingIfBrowser advertises RS well-known on RS landing", () => {
  const req = {
    accepts: (types: string[]) => (types.includes("html") ? "html" : false),
    headers: { accept: "text/html" },
    query: {},
  };
  const sent: Sent = { body: null, headers: {}, status: null };
  const res: LandingResponse = {
    send(b) {
      sent.body = b;
    },
    setHeader() {
      /* intentionally empty */
    },
  };
  servedRootLandingIfBrowser(req, res, {
    consoleOrigin: CONSOLE_ORIGIN,
    providerName: "Test",
    referenceRevision: "rev",
    role: "resource_server",
  });
  assert.ok(sent.body);
  assert.match(sent.body, REGEXP_15);
});

test("resolveConsoleOriginForLanding prefers explicit > env > default", () => {
  assert.equal(
    resolveConsoleOriginForLanding({
      consoleOrigin: "http://explicit.test",
      env: { PDPP_REFERENCE_ORIGIN: "http://from-env.test" },
    }),
    "http://explicit.test"
  );
  assert.equal(
    resolveConsoleOriginForLanding({
      env: { PDPP_REFERENCE_ORIGIN: "http://from-env.test" },
    }),
    "http://from-env.test"
  );
  assert.equal(resolveConsoleOriginForLanding({ env: {} }), "http://localhost:3002");
});

test("renderRootLanding output is escaped HTML containing expected anchors", () => {
  const html = __testOnly.renderRootLanding({
    consoleOrigin: CONSOLE_ORIGIN,
    providerName: "Test <Provider>",
    referenceRevision: "rev-1",
    role: "authorization_server",
  });
  assert.match(html, REGEXP_16);
  assert.doesNotMatch(html, REGEXP_1);
});

// ─── integration: real AS/RS server ──────────────────────────────────────

test("AS root returns JSON for Accept: application/json (byte-identical envelope)", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") || "", REGEXP_2);
    const body = await jsonObject(resp);
    assert.equal(body.object, "pdpp_discovery_index");
    assert.equal(body.role, "authorization_server");
    assert.equal(
      (body.links as Record<string, unknown>).well_known_authorization_server,
      "/.well-known/oauth-authorization-server"
    );
  });
});

test("AS root returns HTML for Accept: text/html and advertises the console origin", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/`, { headers: { Accept: "text/html" } });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") || "", REGEXP_3);
    const body = await resp.text();
    assert.match(body, REGEXP_4);
    assert.ok(body.includes(CONSOLE_ORIGIN), "landing should reference configured console origin");
    assert.match(body, REGEXP_5);
  });
});

test("AS root keeps the legacy JSON default for clients sending no Accept header", async () => {
  await withServer(async ({ asUrl }) => {
    // node:http with no Accept header
    const resp = await fetch(`${asUrl}/`, { headers: { Accept: "" } });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") || "", REGEXP_6);
  });
});

test("RS root returns JSON for Accept: application/json (byte-identical envelope)", async () => {
  await withServer(async ({ rsUrl }) => {
    const resp = await fetch(`${rsUrl}/`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") || "", REGEXP_7);
    const body = await jsonObject(resp);
    assert.equal(body.object, "pdpp_discovery_index");
    assert.equal(body.role, "resource_server");
  });
});

test("RS root returns HTML for Accept: text/html and advertises the console origin", async () => {
  await withServer(async ({ rsUrl }) => {
    const resp = await fetch(`${rsUrl}/`, { headers: { Accept: "text/html" } });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") || "", REGEXP_8);
    const body = await resp.text();
    assert.match(body, REGEXP_9);
    assert.ok(body.includes(CONSOLE_ORIGIN));
    assert.match(body, REGEXP_10);
  });
});

test("AS root explicit ?format=json overrides Accept: text/html and returns JSON", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/?format=json`, {
      headers: { Accept: "text/html" },
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") || "", REGEXP_11);
    const body = await jsonObject(resp);
    assert.equal(body.object, "pdpp_discovery_index");
  });
});
