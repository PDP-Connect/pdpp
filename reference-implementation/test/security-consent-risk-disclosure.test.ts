// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression tests for the harden-reference-auth-surfaces P1 follow-up
// "consent-risk disclosure invariants" (§8). Pins:
//
//   1. A wildcard stream request (`streams: [{ name: '*' }]`) is rendered as
//      an explicit "all streams" disclosure on the hosted consent page, not
//      as a bare `*`. When the source manifest is known, the resolved stream
//      count and stream names appear in the rendered HTML.
//   2. A request with `access_mode: "continuous"` and no explicit retention
//      bound surfaces a distinct continuous-access risk affordance and an
//      explicit "no expiry" disclosure.
//   3. An `ai_training` request submitted without affirmative consent is
//      rejected with a typed PDPP error envelope (`error.code` set, status
//      4xx), not as a generic 500.
//
// Spec: openspec/changes/harden-reference-auth-surfaces/specs/
//       reference-implementation-architecture/spec.md
//       (Requirement: "Hosted consent UI SHALL disclose effective access risk")

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-31T00:00:00.000Z";
const AI_TRAINING_ERROR_RE = /ai_training/i;
const AI_TRAINING_FIELD_RE = /name="ai_training_consented"/;
const APPROVE_ACTION_RE = /action="\/consent\/approve"/;
const APPROVAL_REVIEW_REVISION_FIELD_RE = /name="approval_review_revision"/;
const REVIEW_ACTION_RE = /action="\/consent\/review"/;
const REVIEW_ERROR_RE = /review|ai_training|consent/i;
const REVIEW_REVISION_FIELD_RE = /name="approval_review_revision" value="([^"]+)"/;

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http/https servers, so `closeAllConnections`
// (added Node 18.2+) and the single-error-arg `close` callback genuinely
// exist and are safe to declare here. Established pattern, see
// connector-instance-admission-routes.test.ts.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

interface SpotifyManifest {
  connector_id: string;
  streams: { name: string }[];
}

interface ParResponse {
  request_uri: string;
}

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv: TestServer["asServer"]) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function withHarness(
  fn: (ctx: { asUrl: string; spotifyManifest: SpotifyManifest }) => Promise<void>
): Promise<void> {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8")
  ) as SpotifyManifest;
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await seedSpotifyInstance(spotifyManifest);
    await fn({ asUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function seedSpotifyInstance(spotifyManifest: SpotifyManifest): Promise<void> {
  const connectorId = canonicalConnectorKey(spotifyManifest.connector_id);
  assert.ok(connectorId, "spotify manifest must resolve to a canonical connector key");
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: "cin_security_consent_risk_spotify",
    createdAt: NOW,
    displayName: "Security Consent Risk Spotify",
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: "security-consent-risk@example.com" },
    sourceBindingKey: "security-consent-risk@example.com",
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

async function initiate(
  asUrl: string,
  spotifyManifest: SpotifyManifest,
  overrides: Record<string, unknown> = {}
): Promise<ParResponse> {
  const body = {
    authorization_details: [
      {
        access_mode: "continuous",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Consent risk disclosure regression",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists" }],
        type: "https://pdpp.dev/data-access",
        ...overrides,
      },
    ],
    client_id: "concert_recommendation_app",
  };
  const resp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (resp.status !== 201) {
    throw new Error(`PAR failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as ParResponse;
}

test("security: consent-risk disclosure invariants", async (t) => {
  await t.test(
    'wildcard stream request renders an explicit "all streams" disclosure with resolved names and count',
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const par = await initiate(asUrl, spotifyManifest, {
          access_mode: "single_use",
          streams: [{ name: "*" }],
        });
        const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(par.request_uri)}`);
        assert.equal(consentResp.status, 200);
        const html = await consentResp.text();

        // The HTML SHALL NOT render a bare `*` as a stream name.
        assert.equal(
          html.includes('<span class="hosted-ui-stream-name">*</span>'),
          false,
          "consent HTML rendered a bare `*` as if it were a precise stream name"
        );

        // The HTML SHALL indicate that all streams for the source are in scope.
        const lower = html.toLowerCase();
        assert.ok(lower.includes("all streams"), 'consent HTML SHALL include an explicit "all streams" disclosure');

        // The resolved stream count and resolved stream names SHALL appear when
        // the source manifest is known.
        assert.ok(
          html.includes(`(${spotifyManifest.streams.length})`),
          `consent HTML SHALL include the resolved stream count (${spotifyManifest.streams.length})`
        );
        for (const stream of spotifyManifest.streams) {
          assert.ok(
            html.includes(`<span class="hosted-ui-stream-name">${stream.name}</span>`),
            `consent HTML SHALL include resolved stream name "${stream.name}"`
          );
        }
      });
    }
  );

  await t.test(
    "continuous-access request renders a distinct long-lived-access warning with no-expiry disclosure",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const par = await initiate(asUrl, spotifyManifest, {
          access_mode: "continuous",
          // No retention block: this is the no-expiry case.
          streams: [{ name: "top_artists" }],
        });
        const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(par.request_uri)}`);
        assert.equal(consentResp.status, 200);
        const html = await consentResp.text();
        const lower = html.toLowerCase();

        assert.ok(
          lower.includes("continuous access"),
          "consent HTML SHALL include a distinct continuous-access affordance"
        );
        assert.ok(
          lower.includes("no explicit expiry"),
          "consent HTML SHALL state that the requested access has no explicit expiry when no retention bound is present"
        );
        // The affordance SHALL be a distinct visual block, not just a key/value row.
        assert.ok(
          html.includes('class="hosted-ui-warning"'),
          "consent HTML SHALL render the continuous-access warning as a distinct affordance"
        );
      });
    }
  );

  await t.test("ai_training review without affirmative consent fails with a typed PDPP error envelope", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const par = await initiate(asUrl, spotifyManifest, {
        access_mode: "continuous",
        purpose_code: "https://pdpp.dev/purpose/ai_training",
        purpose_description: "Training a recommendation model",
        streams: [{ name: "top_artists" }],
      });

      const reviewResp = await fetch(`${asUrl}/consent/review`, {
        body: JSON.stringify({ request_uri: par.request_uri, subject_id: "owner_local" }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      const reviewText = await reviewResp.text();
      const resp = { body: JSON.parse(reviewText), status: reviewResp.status };

      assert.notEqual(resp.status, 500, "response SHALL NOT be a generic 500");
      assert.ok(resp.status >= 400 && resp.status < 500, `expected 4xx, got ${resp.status}`);
      assert.equal(typeof resp.body?.error, "object", "response SHALL be a PDPP error envelope");
      assert.equal(typeof resp.body?.error?.code, "string", "PDPP error envelope SHALL carry an error.code");
      assert.notEqual(
        resp.body?.error?.code,
        "api_error",
        "PDPP error envelope SHALL carry a typed code, not the generic api_error fallback"
      );
      assert.equal(typeof resp.body?.error?.message, "string");
      const errorMessage = resp.body?.error?.message;
      if (!errorMessage) {
        throw new Error("expected resp.body.error.message to be set");
      }
      assert.match(errorMessage, REVIEW_ERROR_RE, "PDPP error message SHALL identify the rejected consent review");
    });
  });

  await t.test("ai_training review with explicit false affirmation fails at policy boundary", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const par = await initiate(asUrl, spotifyManifest, {
        access_mode: "continuous",
        purpose_code: "https://pdpp.dev/purpose/ai_training",
        purpose_description: "Training a recommendation model",
        streams: [{ name: "top_artists" }],
      });

      const reviewResp = await fetch(`${asUrl}/consent/review`, {
        body: JSON.stringify({
          ai_training_consented: false,
          request_uri: par.request_uri,
          subject_id: "owner_local",
        }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      const reviewText = await reviewResp.text();
      const resp = { body: JSON.parse(reviewText), status: reviewResp.status };

      assert.notEqual(resp.status, 500, "response SHALL NOT be a generic 500");
      assert.ok(resp.status >= 400 && resp.status < 500, `expected 4xx, got ${resp.status}`);
      assert.equal(typeof resp.body?.error?.code, "string", "PDPP error envelope SHALL carry an error.code");
      assert.equal(typeof resp.body?.error?.message, "string");
      assert.match(String(resp.body?.error?.message), AI_TRAINING_ERROR_RE);
    });
  });

  await t.test("ai_training HTML flow finalizes affirmation at review and final approve has no AI field", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const par = await initiate(asUrl, spotifyManifest, {
        access_mode: "continuous",
        purpose_code: "https://pdpp.dev/purpose/ai_training",
        purpose_description: "Training a recommendation model",
        streams: [{ name: "top_artists" }],
      });

      const initial = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(par.request_uri)}`);
      const initialHtml = await initial.text();
      assert.equal(initial.status, 200, initialHtml);
      assert.match(initialHtml, AI_TRAINING_FIELD_RE);
      assert.match(initialHtml, REVIEW_ACTION_RE);
      assert.doesNotMatch(initialHtml, APPROVAL_REVIEW_REVISION_FIELD_RE);

      const review = await fetch(`${asUrl}/consent/review`, {
        body: new URLSearchParams({
          ai_training_consented: "1",
          request_uri: par.request_uri,
          subject_id: "owner_local",
        }).toString(),
        headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      const reviewHtml = await review.text();
      assert.equal(review.status, 200, reviewHtml);
      const revisionMatch = REVIEW_REVISION_FIELD_RE.exec(reviewHtml);
      assert.ok(revisionMatch?.[1], "reviewed HTML must carry approval_review_revision");
      assert.doesNotMatch(reviewHtml, AI_TRAINING_FIELD_RE);
      assert.match(reviewHtml, APPROVE_ACTION_RE);

      const approved = await fetch(`${asUrl}/consent/approve`, {
        body: new URLSearchParams({
          approval_review_revision: revisionMatch[1],
          request_uri: par.request_uri,
        }).toString(),
        headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(approved.status, 200, await approved.text());
    });
  });
});
