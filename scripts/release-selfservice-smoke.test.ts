// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { PACKAGE_NAMES } from "./release-package-matrix.ts";
import {
  assertComposeMetadata,
  assertImageProvenance,
  assertLiveBoundaryEvidence,
  assertNodeVersion,
  assertPinnedImageReferences,
  assertReceiptIntegrity,
  assertReceiptSecretFree,
  composeCleanupCommands,
  composeReadinessFindings,
  imageProvenanceFindings,
  inspectLandingArtifact,
  installSignalHandlers,
  isNodeVersionAtLeast,
  isPinnedImageReference,
  liveBoundaryFindings,
  makeComposeProjectName,
  metadataFindings,
  ownerLoginBoundaryFinding,
  parseComposePsJson,
  parseDockerImageInspection,
  receiptDigest,
  receiptOutcomeDigest,
  type SelfServiceReceipt,
  signalExitCode,
} from "./release-selfservice-smoke.ts";

const IMAGES = {
  postgres: "pgvector/pgvector:pg16@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  reference:
    "ghcr.io/pdp-connect/pdpp/reference:0.4.0@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  web: "ghcr.io/pdp-connect/pdpp/web:0.4.0@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
};
const HEAD_SHA = "e".repeat(40);
const METADATA_FAILURE_PATTERN = /metadata boundary failed/;
const BOUNDARY_FAILURE_PATTERN = /boundary failed/;
const NODE_VERSION_FAILURE_PATTERN = /22\.14/;
const IMMUTABLE_IMAGE_PATTERN = /immutable/;
const REDIRECT_PATTERN = /redirect/;
const OWNER_ROUTE_PATTERN = /owner\/login/;
const ESCAPED_ORIGIN_PATTERN = /escaped/;
const INVALID_LOCATION_PATTERN = /invalid Location/;
const AUTH_QUERY_FAILURE_PATTERN = /auth\/query boundary failed/;
const BOUNDED_NONCE_PATTERN = /bounded/;
const STABLE_OUTCOME_MUTATION_PATTERN = /stable outcome fields mutated/;
const RESOLVED_DIGEST_MUTATION_PATTERN = /resolved digest drifted/;
const SECRET_RECEIPT_PATTERN = /credential material|owner credentials/;

const IMAGE_PROVENANCE = Object.fromEntries(
  Object.entries(IMAGES).map(([name, requested]) => [
    name,
    {
      requested,
      resolvedDigest: requested.slice(requested.lastIndexOf("@") + 1),
      sourceRepository: null,
      sourceRevision: null,
      sourceRevisionBinding: "not-advertised",
    },
  ])
) as SelfServiceReceipt["artifacts"]["imageProvenance"];

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
      token_endpoint: `${origin}/oauth/token`,
    },
    protectedResource: {
      resource: origin,
      authorization_servers: [origin],
    },
  };
  assert.deepEqual(metadataFindings(origin, documents), []);
  assertComposeMetadata(origin, documents);

  const drifted = {
    ...documents,
    authorizationServer: { ...documents.authorizationServer, issuer: "http://reference:7662" },
  };
  assert.equal(metadataFindings(origin, drifted).length > 0, true);
  assert.throws(() => assertComposeMetadata(origin, drifted), METADATA_FAILURE_PATTERN);
});

test("auth and query boundary mutations cannot pass", () => {
  const evidence = {
    anonymousMcpStatus: 401,
    clientRefreshAfterRevokeStatus: 400,
    clientRevokedMcpStatus: 403,
    ownerBearerMcpStatus: 403,
    queryReturnedKeys: ["railway-seed-artist-1", "railway-seed-artist-2"],
    expectedRecordKeys: ["railway-seed-artist-1", "railway-seed-artist-2"],
  } as const;
  assert.deepEqual(liveBoundaryFindings(evidence), []);
  assertLiveBoundaryEvidence(evidence);

  for (const mutation of [
    { ...evidence, anonymousMcpStatus: 200 },
    { ...evidence, ownerBearerMcpStatus: 200 },
    { ...evidence, clientRevokedMcpStatus: 200 },
    { ...evidence, clientRefreshAfterRevokeStatus: 200 },
    { ...evidence, queryReturnedKeys: ["railway-seed-artist-1"] },
  ]) {
    assert.throws(() => assertLiveBoundaryEvidence(mutation), BOUNDARY_FAILURE_PATTERN);
  }
});

test("Node and image release floors fail closed under mutation", () => {
  assert.equal(isNodeVersionAtLeast("22.14.0"), true);
  assert.equal(isNodeVersionAtLeast("22.13.9"), false);
  assert.equal(isNodeVersionAtLeast("21.99.99"), false);
  assertNodeVersion("25.8.2");
  assert.throws(() => assertNodeVersion("22.13.9"), NODE_VERSION_FAILURE_PATTERN);

  for (const image of Object.values(IMAGES)) {
    assert.equal(isPinnedImageReference(image), true);
  }
  assert.equal(isPinnedImageReference("ghcr.io/pdp-connect/pdpp/web:main"), false);
  assertPinnedImageReferences(IMAGES);
  assert.throws(
    () => assertPinnedImageReferences({ ...IMAGES, web: "ghcr.io/pdp-connect/pdpp/web:main" }),
    IMMUTABLE_IMAGE_PATTERN
  );
});

test("Compose readiness mutation identifies missing or unhealthy services", () => {
  const output = [
    JSON.stringify({ Service: "postgres", State: "running", Health: "healthy" }),
    JSON.stringify({ Service: "reference", State: "running", Health: "healthy" }),
    JSON.stringify({ Service: "web", State: "running", Health: "" }),
  ].join("\n");
  assert.deepEqual(composeReadinessFindings(parseComposePsJson(output)), []);
  const drifted = output.replace('"Health":"healthy"', '"Health":"unhealthy"');
  assert.ok(composeReadinessFindings(parseComposePsJson(drifted)).length > 0);
});

test("owner login boundary rejects a non-owner route mutation", () => {
  assert.equal(ownerLoginBoundaryFinding({ status: 303, location: "/owner/login" }), null);
  assert.match(ownerLoginBoundaryFinding({ status: 200, location: "/" }) ?? "", REDIRECT_PATTERN);
  assert.match(ownerLoginBoundaryFinding({ status: 303, location: "/dashboard" }) ?? "", OWNER_ROUTE_PATTERN);
  assert.match(
    ownerLoginBoundaryFinding({
      origin: "http://127.0.0.1:3030",
      status: 303,
      location: "https://evil.example/owner/login",
    }) ?? "",
    ESCAPED_ORIGIN_PATTERN
  );
  assert.match(ownerLoginBoundaryFinding({ status: 303, location: "http://[" }) ?? "", INVALID_LOCATION_PATTERN);
});

test("Compose project identity and cleanup stay invocation-scoped", () => {
  const first = makeComposeProjectName(HEAD_SHA, "0123456789ab");
  const second = makeComposeProjectName(HEAD_SHA, "0123456789ac");
  assert.notEqual(first, second);
  assert.equal(first, `pdpp-release-smoke-${HEAD_SHA.slice(0, 12)}-0123456789ab`);
  assert.throws(() => makeComposeProjectName(HEAD_SHA, "too-short"), BOUNDED_NONCE_PATTERN);

  const composeArgs = ["docker", "compose", "--project-name", first, "--env-file", "<env>", "-f", "compose.yml"];
  const cleanup = composeCleanupCommands(composeArgs, first);
  assert.ok(cleanup.down.includes(first));
  assert.ok(cleanup.containers.includes(first));
  assert.equal(cleanup.volumes.at(-1), `label=com.docker.compose.project=${first}`);
  assert.equal(cleanup.down.includes(second), false);
});

test("signal cleanup is installed for interruptible Compose runs", () => {
  const signals: NodeJS.Signals[] = [];
  const removeHandlers = installSignalHandlers((signal) => signals.push(signal));
  process.emit("SIGINT");
  removeHandlers();
  assert.deepEqual(signals, ["SIGINT"]);
  assert.equal(signalExitCode("SIGINT"), 130);
  assert.equal(signalExitCode("SIGTERM"), 143);
});

test("Docker image evidence distinguishes digest binding from optional source labels", () => {
  const inspection = parseDockerImageInspection(
    JSON.stringify([
      {
        RepoDigests: [`ghcr.io/pdp-connect/pdpp/reference@sha256:${"b".repeat(64)}`],
        Config: {
          Labels: {
            "org.opencontainers.image.revision": HEAD_SHA,
            "org.opencontainers.image.source": "https://github.com/PDP-Connect/pdpp",
          },
        },
      },
    ])
  );
  assert.deepEqual(imageProvenanceFindings("reference", IMAGES.reference, HEAD_SHA, inspection), []);
  assert.ok(
    imageProvenanceFindings(
      "reference",
      IMAGES.reference.replace(`sha256:${"b".repeat(64)}`, `sha256:${"a".repeat(64)}`),
      HEAD_SHA,
      inspection
    ).length > 0
  );
  assert.ok(
    imageProvenanceFindings("reference", IMAGES.reference, HEAD_SHA, {
      ...inspection,
      labels: { ...inspection.labels, "org.opencontainers.image.revision": "f".repeat(40) },
    }).length > 0
  );
  assertImageProvenance(HEAD_SHA, IMAGES, IMAGE_PROVENANCE);
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
        version: "0.4.0",
      })),
      imageProvenance: IMAGE_PROVENANCE,
      releaseMatrixReceiptSha256: "c".repeat(64),
      releaseVersion: "0.4.0",
    },
    checks: [],
    commands: [],
    compose: { fileSha256: "d".repeat(64), projectName: makeComposeProjectName(HEAD_SHA, "0123456789ab") },
    observedAt: "2026-08-01T00:00:00.000Z",
    failure: null,
    headSha: HEAD_SHA,
    live: {
      anonymousMcpStatus: 401,
      clientRefreshAfterRevokeStatus: 400,
      clientRevokedMcpStatus: 403,
      expectedRecordKeys: ["railway-seed-artist-1", "railway-seed-artist-2"],
      ownerBearerMcpStatus: 403,
      queryReturnedKeys: ["railway-seed-artist-1", "railway-seed-artist-2"],
      seedConnectorId: "https://registry.pdpp.org/connectors/spotify",
      seedStream: "top_artists",
    },
    outcomeSha256: "",
    receiptSha256: "",
    replayCommand: "pnpm release:selfservice-smoke -- --version 0.4.0",
    schema: "pdpp.release-selfservice-smoke/v2",
    sourceClosureSha256: "f".repeat(64),
    status: "passed",
  };
  receipt.outcomeSha256 = receiptOutcomeDigest(receipt);
  receipt.receiptSha256 = receiptDigest(receipt);
  assertReceiptIntegrity(receipt);

  const perRunMetadataMutation: SelfServiceReceipt = {
    ...receipt,
    compose: { ...receipt.compose, projectName: makeComposeProjectName(HEAD_SHA, "0123456789ac") },
    observedAt: "2026-08-02T00:00:00.000Z",
  };
  assert.equal(receiptOutcomeDigest(perRunMetadataMutation), receipt.outcomeSha256);

  assert.ok(receipt.live);
  const mutated: SelfServiceReceipt = {
    ...receipt,
    live: { ...receipt.live, queryReturnedKeys: ["railway-seed-artist-1"] },
    receiptSha256: "",
  };
  mutated.receiptSha256 = receiptDigest(mutated);
  assert.throws(() => assertReceiptIntegrity(mutated), STABLE_OUTCOME_MUTATION_PATTERN);

  mutated.outcomeSha256 = receiptOutcomeDigest(mutated);
  mutated.receiptSha256 = receiptDigest(mutated);
  assert.throws(() => assertReceiptIntegrity(mutated), AUTH_QUERY_FAILURE_PATTERN);

  const referenceProvenance = receipt.artifacts.imageProvenance.reference;
  assert.ok(referenceProvenance);
  const provenanceMutation: SelfServiceReceipt = {
    ...receipt,
    artifacts: {
      ...receipt.artifacts,
      imageProvenance: {
        ...receipt.artifacts.imageProvenance,
        reference: {
          ...referenceProvenance,
          resolvedDigest: `sha256:${"a".repeat(64)}`,
        },
      },
    },
    outcomeSha256: "",
    receiptSha256: "",
  };
  provenanceMutation.outcomeSha256 = receiptOutcomeDigest(provenanceMutation);
  provenanceMutation.receiptSha256 = receiptDigest(provenanceMutation);
  assert.throws(() => assertReceiptIntegrity(provenanceMutation), RESOLVED_DIGEST_MUTATION_PATTERN);

  const secretMutation: SelfServiceReceipt = {
    ...receipt,
    replayCommand: `${receipt.replayCommand} --owner-password leaked`,
  };
  assert.throws(() => assertReceiptSecretFree(secretMutation), SECRET_RECEIPT_PATTERN);
});
