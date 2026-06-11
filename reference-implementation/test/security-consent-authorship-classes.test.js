// Regression tests for the three-class trust model on the hosted consent HTML
// (the AS `GET /consent` surface). Pins that the rendered consent presentation
// keeps the three authorship classes visually and semantically distinct, and
// that client-authored claims are rendered AS claims, never as protocol facts:
//
//   • PROTOCOL — facts the owner's server enforces/verifies (access mode,
//     retention, source binding, resolved client-identity origin).
//   • MANIFEST — owner-trusted human descriptions of the requested streams.
//   • CLIENT   — the client's own claims (self-described app name, the stated
//     purpose, and per-stream `client_claims`), each disclaimed as not enforced.
//
// Before this fix, the renderer flattened `purpose_code` / `purpose_description`
// into the same undifferentiated key/value list as the protocol facts, and
// dropped per-stream `client_claims` entirely — so the rendered HTML did not
// present the three classes as distinct, violating the normative MUST and the
// steering principle "keep protocol facts, manifest-authored descriptions, and
// client-authored claims visually and semantically distinct."
//
// Spec: openspec/specs/reference-implementation-architecture/spec.md
//       (Requirement: "Hosted consent UI SHALL disclose effective access risk"
//        — scenario: "Hosted consent distinguishes the three authorship classes")

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv) => new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 2000);
    srv.close(() => { if (!settled) { settled = true; clearTimeout(t); resolve(); } });
  });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function withHarness(fn) {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);
    await fn({ asUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

// Client-authored values we expect to be rendered AS claims, distinct from
// protocol facts. Deliberately chosen to be unambiguous string needles.
const CLIENT_PURPOSE = 'Recommend concerts based on your listening history';
const CLIENT_CLAIM_PURPOSE = 'We only read your top artists to find nearby shows';
const CLIENT_CLAIM_COMMITMENT_A = 'We never sell your data';
const CLIENT_CLAIM_COMMITMENT_B = 'We delete reads after 30 days';

async function initiate(asUrl, spotifyManifest, overrides = {}) {
  const body = {
    client_id: 'concert_recommendation_app',
    client_display: { name: 'Concert Recommender' },
    authorization_details: [
      {
        type: 'https://pdpp.org/data-access',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: CLIENT_PURPOSE,
        access_mode: 'continuous',
        streams: [
          {
            name: 'top_artists',
            view: 'basic',
            client_claims: {
              purpose: CLIENT_CLAIM_PURPOSE,
              commitments: [CLIENT_CLAIM_COMMITMENT_A, CLIENT_CLAIM_COMMITMENT_B],
            },
          },
        ],
        ...overrides,
      },
    ],
  };
  const resp = await fetch(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.status !== 201) {
    throw new Error(`PAR failed (${resp.status}): ${await resp.text()}`);
  }
  return resp.json();
}

// Extract the concatenation of EVERY authorship block of the given class. The
// renderer marks each block with `data-authorship="<class>"` on a
// `class="hosted-ui-authorship"` div, and there can legitimately be more than
// one block of a class (e.g. the client-display block and the separate
// client_claims block are both `client`). Returns "" when none exist.
function authorshipBlock(html, authorship) {
  const markerRe = new RegExp(`<div[^>]*data-authorship="${authorship}"`, 'g');
  const blocks = [];
  let marker;
  while ((marker = markerRe.exec(html)) !== null) {
    const openStart = marker.index;
    // Walk forward, balancing <div>/</div> so we capture the whole block.
    let depth = 0;
    let end = openStart;
    const tagRe = /<\/?div\b[^>]*>/g;
    tagRe.lastIndex = openStart;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
      depth += m[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    blocks.push(html.slice(openStart, end));
  }
  return blocks.join('\n');
}

test('security: hosted consent renders the three authorship classes distinctly', async (t) => {
  await t.test('client_claims + purpose render as client-authored claims, distinct from protocol facts and manifest streams', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const par = await initiate(asUrl, spotifyManifest);
      const consentResp = await fetch(
        `${asUrl}/consent?request_uri=${encodeURIComponent(par.request_uri)}`,
      );
      assert.equal(consentResp.status, 200);
      const html = await consentResp.text();

      // ── All three authorship classes are present and marked distinctly ──
      for (const authorship of ['protocol', 'manifest', 'client']) {
        assert.ok(
          html.includes(`data-authorship="${authorship}"`),
          `consent HTML SHALL mark a ${authorship}-authored block with data-authorship="${authorship}"`,
        );
      }

      const clientBlock = authorshipBlock(html, 'client');
      const protocolBlock = authorshipBlock(html, 'protocol');
      const manifestBlock = authorshipBlock(html, 'manifest');
      assert.ok(clientBlock, 'client authorship block SHALL be present');
      assert.ok(protocolBlock, 'protocol authorship block SHALL be present');
      assert.ok(manifestBlock, 'manifest authorship block SHALL be present');

      // ── client_claims (previously DROPPED) are now rendered ──
      assert.ok(
        html.includes(CLIENT_CLAIM_PURPOSE),
        'consent HTML SHALL render the per-stream client_claims purpose',
      );
      assert.ok(
        html.includes(CLIENT_CLAIM_COMMITMENT_A) && html.includes(CLIENT_CLAIM_COMMITMENT_B),
        'consent HTML SHALL render the per-stream client_claims commitments',
      );

      // ── client-authored values appear ONLY inside the client block, never
      //    inside the protocol block (they must not be presented as facts) ──
      for (const claim of [
        CLIENT_PURPOSE,
        CLIENT_CLAIM_PURPOSE,
        CLIENT_CLAIM_COMMITMENT_A,
        CLIENT_CLAIM_COMMITMENT_B,
      ]) {
        assert.ok(
          clientBlock.includes(claim),
          `client-authored value "${claim}" SHALL be rendered inside the client authorship block`,
        );
        assert.ok(
          !protocolBlock.includes(claim),
          `client-authored value "${claim}" SHALL NOT be presented as a protocol fact`,
        );
      }

      // ── client claims carry an explicit "not enforced" disclaimer ──
      assert.ok(
        clientBlock.toLowerCase().includes('not enforced by your server'),
        'the client_claims block SHALL disclaim that the claims are not enforced by the server',
      );

      // ── protocol facts (access mode is server-enforced) live in the
      //    protocol block, not the client block ──
      assert.ok(
        protocolBlock.toLowerCase().includes('continuous'),
        'the enforced access mode SHALL be rendered as a protocol fact',
      );

      // ── manifest-authored stream names live in the manifest block ──
      assert.ok(
        manifestBlock.includes('<span class="hosted-ui-stream-name">top_artists</span>'),
        'the requested stream name SHALL be rendered in the manifest authorship block',
      );
    });
  });

  await t.test('a request with no client_claims still renders the three classes and omits an empty claims body', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const par = await initiate(asUrl, spotifyManifest, {
        // No client_claims on the stream this time.
        streams: [{ name: 'top_artists', view: 'basic' }],
      });
      const consentResp = await fetch(
        `${asUrl}/consent?request_uri=${encodeURIComponent(par.request_uri)}`,
      );
      assert.equal(consentResp.status, 200);
      const html = await consentResp.text();

      // The stated purpose is still client-authored even without client_claims.
      const clientBlock = authorshipBlock(html, 'client');
      assert.ok(clientBlock, 'client authorship block SHALL be present for the stated purpose');
      assert.ok(
        clientBlock.includes(CLIENT_PURPOSE),
        'the stated purpose SHALL be rendered as a client-authored claim',
      );

      // The protocol and manifest classes remain distinct.
      assert.ok(html.includes('data-authorship="protocol"'));
      assert.ok(html.includes('data-authorship="manifest"'));

      // No empty client_claims commitments scaffold leaks when there are none.
      assert.ok(
        !html.includes('What this app says it will do'),
        'consent HTML SHALL NOT render an empty client_claims block when no claims are present',
      );
    });
  });
});
