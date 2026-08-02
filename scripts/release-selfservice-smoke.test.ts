// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { PACKAGE_NAMES } from "./release-package-matrix.ts";
import {
  assertComposeMetadata,
  assertLiveBoundaryEvidence,
  assertNodeVersion,
  assertPinnedImageReferences,
  assertReceiptIntegrity,
  composeReadinessFindings,
  inspectLandingArtifact,
  isNodeVersionAtLeast,
  isPinnedImageReference,
  liveBoundaryFindings,
  metadataFindings,
  ownerLoginBoundaryFinding,
  parseComposePsJson,
  receiptDigest,
  type SelfServiceReceipt
} from "./release-selfservice-smoke.ts";

const IMAGES = {
  postgres: "pgvector/pgvector:pg16@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  reference:
    "ghcr.io/pdp-connect/pdpp/reference:0.4.0@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  web: "ghcr.io/pdp-connect/pdpp/web:0.4.0@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
};

test("landing artifact passes only when it does not derive a live MCP origin", () => {
  const clean = inspectLandingArtifact('<ConnectAgentCard mode="sandbox" />');
  assert.deepEqual(clean, { findings: [], ok: true });

  const mutated = inspectLandingArtifact(
    '<ConnectAgentCard mode="live" providerUrl={providerUrl} /> function getRequestOrigin() {}'
  );
  assert.equal(mutated.ok, false);
  assert.equal(mutated.findings.length, 3);
});

test("metadata origin mutation is a hard failure", () => {
  const origin = "http://127.0.0.1:3030";
  const documents = {
    authorizationServer: {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`
    },
    protectedResource: {
      resource: origin,
      authorization_servers: [origin]
    }
  };
  assert.deepEqual(metadataFindings(origin, documents), []);
  assertComposeMetadata(origin, documents);

  const drifted = {
    ...documents,
    authorizationServer: { ...documents.authorizationServer, issuer: "http://reference:7662" }
  };
  assert.equal(metadataFindings(origin, drifted).length > 0, true);
  assert.throws(() => assertComposeMetadata(origin, drifted), /metadata boundary failed/);
});

test("auth and query boundary mutations cannot pass", () => {
  const evidence = {
    anonymousMcpStatus: 401,
    clientRefreshAfterRevokeStatus: 400,
    clientRevokedMcpStatus: 403,
    ownerBearerMcpStatus: 403,
    queryReturnedKeys: ["railway-seed-artist-1", "railway-seed-artist-2"],
    expectedRecordKeys: ["railway-seed-artist-1", "railway-seed-artist-2"]
  } as const;
  assert.deepEqual(liveBoundaryFindings(evidence), []);
  assertLiveBoundaryEvidence(evidence);

  for (const mutation of [
    { ...evidence, anonymousMcpStatus: 200 },
    { ...evidence, ownerBearerMcpStatus: 200 },
    { ...evidence, clientRevokedMcpStatus: 200 },
    { ...evidence, clientRefreshAfterRevokeStatus: 200 },
    { ...evidence, queryReturnedKeys: ["railway-seed-artist-1"] }
  ]) {
    assert.throws(() => assertLiveBoundaryEvidence(mutation), /boundary failed/);
  }
});

test("Node and image release floors fail closed under mutation", () => {
  assert.equal(isNodeVersionAtLeast("22.14.0"), true);
  assert.equal(isNodeVersionAtLeast("22.13.9"), false);
  assert.equal(isNodeVersionAtLeast("21.99.99"), false);
  assertNodeVersion("25.8.2");
  assert.throws(() => assertNodeVersion("22.13.9"), /22\.14/);

  for (const image of Object.values(IMAGES)) {
    assert.equal(isPinnedImageReference(image), true);
  }
  assert.equal(isPinnedImageReference("ghcr.io/pdp-connect/pdpp/web:main"), false);
  assertPinnedImageReferences(IMAGES);
  assert.throws(
    () => assertPinnedImageReferences({ ...IMAGES, web: "ghcr.io/pdp-connect/pdpp/web:main" }),
    /immutable/
  );
});

test("Compose readiness mutation identifies missing or unhealthy services", () => {
  const output = [
    JSON.stringify({ Service: "postgres", State: "running", Health: "healthy" }),
    JSON.stringify({ Service: "reference", State: "running", Health: "healthy" }),
    JSON.stringify({ Service: "web", State: "running", Health: "" })
  ].join("\n");
  assert.deepEqual(composeReadinessFindings(parseComposePsJson(output)), []);
  const drifted = output.replace('"Health":"healthy"', '"Health":"unhealthy"');
  assert.ok(composeReadinessFindings(parseComposePsJson(drifted)).length > 0);
});

test("owner login boundary rejects a non-owner route mutation", () => {
  assert.equal(ownerLoginBoundaryFinding({ status: 303, location: "/owner/login" }), null);
  assert.match(ownerLoginBoundaryFinding({ status: 200, location: "/" }) ?? "", /redirect/);
  assert.match(ownerLoginBoundaryFinding({ status: 303, location: "/dashboard" }) ?? "", /owner\/login/);
  assert.match(
    ownerLoginBoundaryFinding({
      origin: "http://127.0.0.1:3030",
      status: 303,
      location: "https://evil.example/owner/login"
    }) ?? "",
    /escaped/
  );
  assert.match(ownerLoginBoundaryFinding({ status: 303, location: "http://[" }) ?? "", /invalid Location/);
});

test("receipt integrity binds live evidence and rejects a resealed query mutation", () => {
  const receipt: SelfServiceReceipt = {
    artifacts: {
      images: IMAGES,
      npm: PACKAGE_NAMES.map((name) => ({
        name,
        sha1: "a".repeat(40),
        sha256: "b".repeat(64),
        tarball: `${name.replace("@pdpp/", "").replace("/", "-")}.tgz`,
        version: "0.4.0"
      })),
      releaseMatrixReceiptSha256: "c".repeat(64),
      releaseVersion: "0.4.0"
    },
    checks: [],
    commands: [],
    compose: { fileSha256: "d".repeat(64), projectName: "pdpp-release-smoke-abc" },
    createdAt: "2026-08-01T00:00:00.000Z",
    failure: null,
    headSha: "e".repeat(40),
    live: {
      anonymousMcpStatus: 401,
      clientRefreshAfterRevokeStatus: 400,
      clientRevokedMcpStatus: 403,
      expectedRecordKeys: ["railway-seed-artist-1", "railway-seed-artist-2"],
      ownerBearerMcpStatus: 403,
      queryReturnedKeys: ["railway-seed-artist-1", "railway-seed-artist-2"],
      seedConnectorId: "https://registry.pdpp.org/connectors/spotify",
      seedStream: "top_artists"
    },
    receiptSha256: "",
    replayCommand: "pnpm release:selfservice-smoke -- --version 0.4.0",
    schema: "pdpp.release-selfservice-smoke/v1",
    sourceClosureSha256: "f".repeat(64),
    status: "passed"
  };
  receipt.receiptSha256 = receiptDigest(receipt);
  assertReceiptIntegrity(receipt);

  assert.ok(receipt.live);
  const mutated: SelfServiceReceipt = {
    ...receipt,
    live: { ...receipt.live, queryReturnedKeys: ["railway-seed-artist-1"] },
    receiptSha256: ""
  };
  mutated.receiptSha256 = receiptDigest(mutated);
  assert.throws(() => assertReceiptIntegrity(mutated), /auth\/query boundary failed/);
});
