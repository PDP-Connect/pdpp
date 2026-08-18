// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression tests for the three-class trust model on the hosted consent HTML
// (the AS `GET /consent` surface). Pins that the rendered consent presentation
// keeps the three authorship classes visually and semantically distinct, and
// that client-authored claims are rendered AS claims, never as protocol facts:
//
//   - PROTOCOL: facts the owner's server enforces/verifies (access mode,
//     retention, source binding, resolved client-identity origin).
//   - MANIFEST: owner-trusted human descriptions of the requested streams.
//   - CLIENT: the client's own claims (self-described app name, the stated
//     purpose, and top-level `client_claims`), each disclaimed as not enforced.
//
// Before this fix, the renderer flattened `purpose_code` / `purpose_description`
// into the same undifferentiated key/value list as the protocol facts, and
// dropped top-level `client_claims` entirely, so the rendered HTML did not
// present the three classes as distinct, violating the normative MUST and the
// steering principle "keep protocol facts, manifest-authored descriptions, and
// client-authored claims visually and semantically distinct."
//
// Spec: openspec/specs/reference-implementation-architecture/spec.md
//       (Requirement: "Hosted consent UI SHALL disclose effective access risk"
//        - scenario: "Hosted consent distinguishes the three authorship classes")

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

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http/https servers (the framework never
// negotiates ALPN in this reference stack), so `closeAllConnections` (added
// Node 18.2+) and the single-error-arg `close` callback genuinely exist and
// are safe to declare here. Established pattern, see
// connector-failure-diagnostics-control-plane.test.ts / connector-gap-severity.test.ts.
interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
};

interface SpotifyManifest {
  connector_id: string;
  [key: string]: unknown;
}

interface InitiateResult {
  request_uri: string;
  [key: string]: unknown;
}

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv: CloseableServer) =>
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
  const spotifyManifest: SpotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
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
    connectorInstanceId: "cin_security_consent_authorship_spotify",
    createdAt: NOW,
    displayName: "Security Consent Authorship Spotify",
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: "security-consent-authorship@example.com" },
    sourceBindingKey: "security-consent-authorship@example.com",
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

// Client-authored values we expect to be rendered AS claims, distinct from
// protocol facts. Deliberately chosen to be unambiguous string needles.
const CLIENT_PURPOSE = "Recommend concerts based on your listening history";
const CLIENT_CLAIM_COMMITMENT_A = "We never sell your data";
const CLIENT_CLAIM_COMMITMENT_B = "We delete reads after 30 days";
const PER_STREAM_CLIENT_CLAIMS_ERROR_RE = /streams\/0|additional properties|client_claims/i;

async function initiate(
  asUrl: string,
  spotifyManifest: SpotifyManifest,
  overrides: Record<string, unknown> = {}
): Promise<InitiateResult> {
  const body = {
    authorization_details: [
      {
        access_mode: "continuous",
        client_claims: {
          commitments: [CLIENT_CLAIM_COMMITMENT_A, CLIENT_CLAIM_COMMITMENT_B],
        },
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: CLIENT_PURPOSE,
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists" }],
        type: "https://pdpp.dev/data-access",
        ...overrides,
      },
    ],
    client_display: { name: "Concert Recommender" },
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
  const parsed: unknown = await resp.json();
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { request_uri?: unknown }).request_uri !== "string"
  ) {
    throw new Error(`PAR response missing request_uri: ${JSON.stringify(parsed)}`);
  }
  return parsed as InitiateResult;
}

// Extract the concatenation of EVERY authorship block of the given class. The
// renderer marks each block with `data-authorship="<class>"` on a
// `class="hosted-ui-authorship"` div, and there can legitimately be more than
// one block of a class (e.g. the client-display block and the separate
// client_claims block are both `client`). Returns "" when none exist.
function authorshipBlock(html: string, authorship: string): string {
  const markerRe = new RegExp(`<div[^>]*data-authorship="${authorship}"`, "g");
  const blocks: string[] = [];
  let marker: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex walk requires assignment and state progression
  while ((marker = markerRe.exec(html)) !== null) {
    const openStart = marker.index;
    // Walk forward, balancing <div>/</div> so we capture the whole block.
    let depth = 0;
    let end = openStart;
    const tagRe = /<\/?div\b[^>]*>/g;
    tagRe.lastIndex = openStart;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex walk requires assignment and state progression
    while ((m = tagRe.exec(html)) !== null) {
      depth += m[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    blocks.push(html.slice(openStart, end));
  }
  return blocks.join("\n");
}

test("security: hosted consent renders the three authorship classes distinctly", async (t) => {
  await t.test(
    "top-level client_claims + purpose render as client-authored claims, distinct from protocol facts and manifest streams",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }: { asUrl: string; spotifyManifest: SpotifyManifest }) => {
        const par = await initiate(asUrl, spotifyManifest);
        const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(par.request_uri)}`);
        assert.equal(consentResp.status, 200);
        const html = await consentResp.text();

        // All three authorship classes are present and marked distinctly.
        for (const authorship of ["protocol", "manifest", "client"]) {
          assert.ok(
            html.includes(`data-authorship="${authorship}"`),
            `consent HTML SHALL mark a ${authorship}-authored block with data-authorship="${authorship}"`
          );
        }

        const clientBlock = authorshipBlock(html, "client");
        const protocolBlock = authorshipBlock(html, "protocol");
        const manifestBlock = authorshipBlock(html, "manifest");
        assert.ok(clientBlock, "client authorship block SHALL be present");
        assert.ok(protocolBlock, "protocol authorship block SHALL be present");
        assert.ok(manifestBlock, "manifest authorship block SHALL be present");

        // Top-level client_claims are rendered.
        assert.ok(
          html.includes(CLIENT_CLAIM_COMMITMENT_A) && html.includes(CLIENT_CLAIM_COMMITMENT_B),
          "consent HTML SHALL render top-level client_claims commitments"
        );

        // Client-authored values appear ONLY inside the client block, never
        // inside the protocol block (they must not be presented as facts).
        for (const claim of [CLIENT_PURPOSE, CLIENT_CLAIM_COMMITMENT_A, CLIENT_CLAIM_COMMITMENT_B]) {
          assert.ok(
            clientBlock.includes(claim),
            `client-authored value "${claim}" SHALL be rendered inside the client authorship block`
          );
          assert.ok(
            !protocolBlock.includes(claim),
            `client-authored value "${claim}" SHALL NOT be presented as a protocol fact`
          );
        }

        // Client claims carry an explicit "not enforced" disclaimer.
        assert.ok(
          clientBlock.toLowerCase().includes("not enforced by your server"),
          "the client_claims block SHALL disclaim that the claims are not enforced by the server"
        );

        // Protocol facts (access mode is server-enforced) live in the protocol
        // block, not the client block.
        assert.ok(
          protocolBlock.toLowerCase().includes("continuous"),
          "the enforced access mode SHALL be rendered as a protocol fact"
        );

        // Manifest-authored stream names live in the manifest block.
        assert.ok(
          manifestBlock.includes('<span class="hosted-ui-stream-name">top_artists</span>'),
          "the requested stream name SHALL be rendered in the manifest authorship block"
        );
      });
    }
  );

  await t.test(
    "a request with no client_claims still renders the three classes and omits an empty claims body",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }: { asUrl: string; spotifyManifest: SpotifyManifest }) => {
        const par = await initiate(asUrl, spotifyManifest, {
          client_claims: undefined,
          // No client_claims in this request.
          streams: [{ name: "top_artists" }],
        });
        const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(par.request_uri)}`);
        assert.equal(consentResp.status, 200);
        const html = await consentResp.text();

        // The stated purpose is still client-authored even without client_claims.
        const clientBlock = authorshipBlock(html, "client");
        assert.ok(clientBlock, "client authorship block SHALL be present for the stated purpose");
        assert.ok(
          clientBlock.includes(CLIENT_PURPOSE),
          "the stated purpose SHALL be rendered as a client-authored claim"
        );

        // The protocol and manifest classes remain distinct.
        assert.ok(html.includes('data-authorship="protocol"'));
        assert.ok(html.includes('data-authorship="manifest"'));

        // No empty client_claims commitments scaffold leaks when there are none.
        assert.ok(
          !html.includes("What this app says it will do"),
          "consent HTML SHALL NOT render an empty client_claims block when no claims are present"
        );
      });
    }
  );

  await t.test("per-stream client_claims fail closed during request validation", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }: { asUrl: string; spotifyManifest: SpotifyManifest }) => {
      const resp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/personalization",
              purpose_description: CLIENT_PURPOSE,
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [
                {
                  client_claims: {
                    commitments: [CLIENT_CLAIM_COMMITMENT_A],
                  },
                  name: "top_artists",
                },
              ],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_display: { name: "Concert Recommender" },
          client_id: "concert_recommendation_app",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(resp.status, 400);
      const body = (await resp.json()) as { error?: { code?: string; message?: string } };
      assert.equal(body.error?.code, "invalid_authorization_details");
      assert.match(body.error?.message ?? "", PER_STREAM_CLIENT_CLAIMS_ERROR_RE);
    });
  });
});
