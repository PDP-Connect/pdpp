// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavior tests for AS operation modules introduced by
 * openspec/changes/complete-reference-operation-refactor.
 *
 * These pin the pure semantic transforms (envelope shapes, error-code →
 * status mapping, redaction rules) the operations own. Host-mounted parity
 * (Express route emitting equivalent events, owner-session/CSRF gates) is
 * covered by the existing security/conformance/control-actions tests.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type AsAuthorizationServerMetadataBuilderInput,
  executeAsAuthorizationServerMetadata,
} from "../operations/as-authorization-server-metadata/index.ts";
import {
  type AsConsentDecisionDependencies,
  executeAsConsentDecision,
} from "../operations/as-consent-decision/index.ts";
import { executeAsConsentExchange } from "../operations/as-consent-exchange/index.ts";
import { executeAsDcrDelete } from "../operations/as-dcr-delete/index.ts";
import { executeAsDcrRegister, summarizeDcrRegisterRequest } from "../operations/as-dcr-register/index.ts";
import { executeAsDeviceAuthInit } from "../operations/as-device-authorization-init/index.ts";
import { executeAsDeviceDecision } from "../operations/as-device-decision/index.ts";
import { executeAsDeviceTokenExchange } from "../operations/as-device-token-exchange/index.ts";
import { executeAsDiscoveryIndex } from "../operations/as-discovery-index/index.ts";
import { executeAsGrantRevoke } from "../operations/as-grant-revoke/index.ts";
import { executeAsIntrospect } from "../operations/as-introspect/index.ts";
import { executeAsParCreate } from "../operations/as-par-create/index.ts";
import { executeAsPolyfillConnectorDetail } from "../operations/as-polyfill-connector-detail/index.ts";
import { executeAsPolyfillConnectorRegister } from "../operations/as-polyfill-connector-register/index.ts";

// Shared stand-in for the ad hoc `err.code = ...` pattern used throughout this
// file's throwing-dependency stubs: a real Error subclass with the extra
// fields the operations under test read off a thrown error.
class TaggedError extends Error {
  code?: string;
  request_id?: string;
  trace_id?: string;
}

// ─── as.discovery.index ─────────────────────────────────────────────────

test("as.discovery.index emits stable envelope discriminator and links", () => {
  const env = executeAsDiscoveryIndex({
    providerName: "Test Provider",
    referenceRevision: "rev-123",
  });
  assert.deepEqual(env, {
    links: {
      well_known_authorization_server: "/.well-known/oauth-authorization-server",
    },
    object: "pdpp_discovery_index",
    reference_revision: "rev-123",
    resource_name: "Test Provider",
    role: "authorization_server",
  });
});

// ─── as.authorization_server.metadata ───────────────────────────────────

test("as.authorization_server.metadata advertises pre_registered_public when DCR disabled", () => {
  const captured: AsAuthorizationServerMetadataBuilderInput[] = [];
  const result = executeAsAuthorizationServerMetadata(
    { dynamicClientRegistrationEnabled: false, issuer: "https://example.test" },
    {
      buildAuthorizationServerMetadata: (metadataInput) => {
        captured.push(metadataInput);
        return { received: metadataInput };
      },
    }
  );
  assert.equal(captured.length, 1);
  const [input] = captured;
  assert.ok(input, "expected the builder input to have been captured");
  assert.equal(input.issuer, "https://example.test");
  assert.equal(input.introspectionEndpoint, "https://example.test/introspect");
  assert.equal(input.pushedAuthorizationRequestEndpoint, "https://example.test/oauth/par");
  assert.equal(input.tokenEndpoint, "https://example.test/oauth/token");
  assert.equal(input.deviceAuthorizationEndpoint, "https://example.test/oauth/device_authorization");
  assert.equal(input.registrationEndpoint, null);
  assert.deepEqual(input.registrationModesSupported, ["pre_registered_public"]);
  assert.deepEqual(input.providerConnectCapabilities, [
    "owner_self_export",
    "cli_device_connect",
    "third_party_client_connect",
  ]);
  assert.deepEqual(input.tokenEndpointAuthMethodsSupported, ["none"]);
  assert.deepEqual(input.grantTypesSupported, [
    "urn:ietf:params:oauth:grant-type:device_code",
    "authorization_code",
    "refresh_token",
  ]);
  assert.equal(input.authorizationEndpoint, "https://example.test/oauth/authorize");
  assert.deepEqual(input.responseTypesSupported, ["code"]);
  assert.deepEqual(input.codeChallengeMethodsSupported, ["S256"]);
  assert.deepEqual(input.authorizationDetailsTypesSupported, ["https://pdpp.org/data-access"]);
  assert.deepEqual(result, { received: input });
});

test("as.authorization_server.metadata adds dynamic mode + registration endpoint when DCR enabled", () => {
  let captured: AsAuthorizationServerMetadataBuilderInput | undefined;
  executeAsAuthorizationServerMetadata(
    { dynamicClientRegistrationEnabled: true, issuer: "https://example.test" },
    {
      buildAuthorizationServerMetadata: (input) => {
        captured = input;
        return null;
      },
    }
  );
  assert.ok(captured, "expected the builder input to have been captured");
  assert.equal(captured.registrationEndpoint, "https://example.test/oauth/register");
  assert.deepEqual(captured.registrationModesSupported, ["dynamic", "pre_registered_public"]);
});

// ─── as.dcr.register ────────────────────────────────────────────────────

test("summarizeDcrRegisterRequest gathers known + sorted requested fields", () => {
  const summary = summarizeDcrRegisterRequest({
    client_name: "cli",
    extra: 1,
    redirect_uris: ["https://a", "https://b"],
    token_endpoint_auth_method: "none",
  });
  assert.equal(summary.requested_client_name, "cli");
  assert.equal(summary.requested_token_endpoint_auth_method, "none");
  assert.equal(summary.requested_redirect_uri_count, 2);
  assert.deepEqual(summary.requested_metadata_fields, [
    "client_name",
    "extra",
    "redirect_uris",
    "token_endpoint_auth_method",
  ]);
});

test("as.dcr.register rejects with invalid_request when DCR is disabled", async () => {
  const outcome = await executeAsDcrRegister(
    {
      authorizationHeader: "Bearer t",
      body: { client_name: "cli" },
      dcrEnabled: false,
      initialAccessTokens: ["t"],
      ownerSessionSubjectId: null,
    },
    {
      registerDynamicClient: () => {
        throw new Error("should not be called");
      },
    }
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 404);
  assert.equal(outcome.errorCode, "invalid_request");
  assert.equal(outcome.spineData.error.code, "invalid_request");
});

test("as.dcr.register allows public self-registration without Bearer authorization", async () => {
  let capturedSanitized: unknown;
  let capturedExtra: unknown;
  const outcome = await executeAsDcrRegister(
    {
      authorizationHeader: null,
      body: { client_name: "public cli", token_endpoint_auth_method: "none" },
      dcrEnabled: true,
      initialAccessTokens: ["t"],
      ownerSessionSubjectId: null,
    },
    {
      registerDynamicClient: (input, extra) => {
        capturedSanitized = input;
        capturedExtra = extra;
        return {
          client_id: "c_public",
          client_name: "public cli",
          redirect_uris: [],
          token_endpoint_auth_method: "none",
        };
      },
    }
  );
  assert.equal(outcome.outcome, "success");
  assert.equal(outcome.status, 201);
  assert.deepEqual(capturedSanitized, {
    client_name: "public cli",
    token_endpoint_auth_method: "none",
  });
  assert.deepEqual(capturedExtra, {});
  assert.equal(outcome.spineData.registration_access, "public");
});

test("as.dcr.register rejects unknown initial access token with 401 invalid_client", async () => {
  const outcome = await executeAsDcrRegister(
    {
      authorizationHeader: "Bearer wrong",
      body: {},
      dcrEnabled: true,
      initialAccessTokens: ["t"],
      ownerSessionSubjectId: null,
    },
    { registerDynamicClient: () => assert.fail("not reached") }
  );
  assert.equal(outcome.status, 401);
  assert.equal(outcome.errorCode, "invalid_client");
});

test("as.dcr.register strips body issuer_subject_id and stamps owner session subject", async () => {
  let capturedSanitized: Record<string, unknown> | undefined;
  let capturedExtra: Record<string, unknown> | undefined;
  const outcome = await executeAsDcrRegister(
    {
      authorizationHeader: "Bearer t",
      body: {
        client_name: "cli",
        issuer_subject_id: "attacker_attempt",
      },
      dcrEnabled: true,
      initialAccessTokens: ["t"],
      ownerSessionSubjectId: "owner_alice",
    },
    {
      registerDynamicClient: (input, extra) => {
        capturedSanitized = input;
        capturedExtra = extra;
        return {
          client_id: "c1",
          client_name: "cli",
          redirect_uris: ["https://a"],
          token_endpoint_auth_method: "none",
        };
      },
    }
  );
  assert.ok(outcome.outcome === "success");
  assert.ok(capturedSanitized, "expected sanitizedInput to have been captured");
  assert.equal(outcome.status, 201);
  assert.equal(capturedSanitized.client_name, "cli");
  assert.equal(capturedSanitized.issuer_subject_id, undefined, "body issuer_subject_id must be stripped");
  assert.deepEqual(capturedExtra, { issuer_subject_id: "owner_alice" });
  assert.deepEqual(outcome.spineData, {
    client_name: "cli",
    redirect_uri_count: 1,
    registration_access: "initial_access_token",
    registration_mode: "dynamic",
    token_endpoint_auth_method: "none",
  });
});

test("as.dcr.register builds failure spineData around the request summary", async () => {
  const outcome = await executeAsDcrRegister(
    {
      authorizationHeader: "Bearer t",
      body: { client_name: "cli", redirect_uris: ["x"] },
      dcrEnabled: true,
      initialAccessTokens: ["t"],
      ownerSessionSubjectId: null,
    },
    {
      registerDynamicClient: () => {
        const e = new TaggedError("bad redirect");
        e.code = "invalid_redirect_uri";
        throw e;
      },
    }
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.errorCode, "invalid_redirect_uri");
  assert.equal(outcome.spineData.requested_client_name, "cli");
  assert.equal(outcome.spineData.requested_redirect_uri_count, 1);
  assert.deepEqual(outcome.spineData.error, {
    code: "invalid_redirect_uri",
    message: "bad redirect",
  });
});

// ─── as.dcr.delete ──────────────────────────────────────────────────────

test("as.dcr.delete returns 204 on success", async () => {
  let captured: unknown;
  const outcome = await executeAsDcrDelete(
    {
      actingSubjectId: "owner_alice",
      clientId: "c1",
      requestId: "req_1",
      traceId: "trace_1",
    },
    {
      deleteRegisteredClient: (clientId, ctx) => {
        captured = { clientId, ctx };
      },
    }
  );
  assert.deepEqual(captured, {
    clientId: "c1",
    ctx: {
      actingSubjectId: "owner_alice",
      requestId: "req_1",
      traceId: "trace_1",
    },
  });
  assert.equal(outcome.outcome, "success");
  assert.equal(outcome.status, 204);
});

test("as.dcr.delete maps not_found → 404, forbidden → 403, others → 400", async () => {
  const cases: [string, number][] = [
    ["not_found", 404],
    ["forbidden", 403],
    ["invalid_request", 400],
    ["unspecified", 400],
  ];
  for await (const [code, status] of cases) {
    const outcome = await executeAsDcrDelete(
      {
        actingSubjectId: "s",
        clientId: "c",
        requestId: "r",
        traceId: "t",
      },
      {
        deleteRegisteredClient: () => {
          const e = new TaggedError(`x: ${code}`);
          e.code = code;
          throw e;
        },
      }
    );
    assert.equal(outcome.outcome, "failure");
    assert.equal(outcome.status, status, `code=${code}`);
    assert.equal(outcome.errorCode, code);
  }
});

// ─── as.device.authorization.init ───────────────────────────────────────

test("as.device.authorization.init rejects missing client_id", async () => {
  const outcome = await executeAsDeviceAuthInit(
    { baseUrl: "http://x", clientId: "" },
    { initiate: () => assert.fail("not reached") }
  );
  assert.equal(outcome.status, 400);
  assert.equal(outcome.errorCode, "invalid_request");
  assert.equal(outcome.errorMessage, "client_id is required");
});

test("as.device.authorization.init strips trace_context from public envelope", async () => {
  const outcome = await executeAsDeviceAuthInit(
    { baseUrl: "http://x", clientId: "c1" },
    {
      initiate: () => ({
        device_code: "dc",
        expires_in: 600,
        interval: 5,
        trace_context: { request_id: "r1", trace_id: "t1" },
        user_code: "UC",
        verification_uri: "http://x/device",
      }),
    }
  );
  assert.equal(outcome.outcome, "success");
  assert.deepEqual(outcome.traceContext, { request_id: "r1", trace_id: "t1" });
  assert.equal(outcome.publicResult.trace_context, undefined);
  assert.equal(outcome.publicResult.user_code, "UC");
});

test("as.device.authorization.init forwards request_id/trace_id from thrown errors", async () => {
  const outcome = await executeAsDeviceAuthInit(
    { baseUrl: "http://x", clientId: "c1" },
    {
      initiate: () => {
        const e = new TaggedError("nope");
        e.code = "invalid_client";
        e.request_id = "r9";
        e.trace_id = "t9";
        throw e;
      },
    }
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.errorCode, "invalid_client");
  assert.equal(outcome.requestId, "r9");
  assert.equal(outcome.traceId, "t9");
});

// ─── as.device.token.exchange ───────────────────────────────────────────

test("as.device.token.exchange rejects unsupported grant_type", async () => {
  const outcome = await executeAsDeviceTokenExchange(
    { clientId: "c", deviceCode: "d", grantType: "authorization_code" },
    { exchangeDeviceCode: () => assert.fail("not reached") }
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.errorCode, "unsupported_grant_type");
});

test("as.device.token.exchange maps RFC 8628 client-fault codes to 400", async () => {
  for await (const code of [
    "authorization_pending",
    "slow_down",
    "access_denied",
    "expired_token",
    "invalid_grant",
    "invalid_client",
  ]) {
    const outcome = await executeAsDeviceTokenExchange(
      {
        clientId: "c",
        deviceCode: "d",
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      },
      {
        exchangeDeviceCode: () => {
          const e = new TaggedError(`x: ${code}`);
          e.code = code;
          throw e;
        },
      }
    );
    assert.equal(outcome.outcome, "failure");
    assert.equal(outcome.status, 400, `code=${code}`);
    assert.equal(outcome.errorCode, code);
  }
});

test("as.device.token.exchange maps unknown codes to 500 server_error", async () => {
  const outcome = await executeAsDeviceTokenExchange(
    {
      clientId: "c",
      deviceCode: "d",
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    },
    {
      exchangeDeviceCode: () => {
        throw new Error("database exploded");
      },
    }
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 500);
  assert.equal(outcome.errorCode, "server_error");
});

test("as.device.token.exchange strips trace_context from public envelope", async () => {
  const outcome = await executeAsDeviceTokenExchange(
    {
      clientId: "c",
      deviceCode: "d",
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    },
    {
      exchangeDeviceCode: () => ({
        access_token: "tok",
        token_type: "Bearer",
        trace_context: { request_id: "r", trace_id: "t" },
      }),
    }
  );
  assert.equal(outcome.outcome, "success");
  assert.equal(outcome.publicResult.trace_context, undefined);
  assert.equal(outcome.publicResult.access_token, "tok");
  assert.deepEqual(outcome.traceContext, { request_id: "r", trace_id: "t" });
});

// ─── as.device.decision (approve / deny) ────────────────────────────────

test("as.device.decision resolves approval_id to user_code via dependency", async () => {
  let approvedWith: unknown;
  const outcome = await executeAsDeviceDecision(
    {
      action: "approve",
      approvalId: "app_1",
      subjectId: "owner",
      userCode: null,
    },
    {
      approve: (uc, sub) => {
        approvedWith = { sub, uc };
      },
      deny: () => assert.fail("not reached"),
      getByApprovalId: (id) => {
        assert.equal(id, "app_1");
        return { status: "pending", user_code: "UC1" };
      },
    }
  );
  assert.equal(outcome.outcome, "success");
  assert.equal(outcome.userCode, "UC1");
  assert.deepEqual(approvedWith, { sub: "owner", uc: "UC1" });
});

test("as.device.decision rejects approval_id with non-pending status as 404 not_found", async () => {
  const outcome = await executeAsDeviceDecision(
    {
      action: "deny",
      approvalId: "app_1",
      subjectId: "owner",
      userCode: null,
    },
    {
      approve: () => {
        // no-op
      },
      deny: () => {
        // no-op
      },
      getByApprovalId: () => ({ status: "approved", user_code: "UC" }),
    }
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 404);
  assert.equal(outcome.errorCode, "not_found");
});

test("as.device.decision requires user_code or approval_id", async () => {
  const outcome = await executeAsDeviceDecision(
    { action: "approve", approvalId: null, subjectId: "s", userCode: null },
    {
      approve: () => {
        // no-op
      },
      deny: () => {
        // no-op
      },
      getByApprovalId: () => null,
    }
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.errorCode, "invalid_request");
});

test("as.device.decision deny dispatches to dependency.deny", async () => {
  let denied: unknown;
  await executeAsDeviceDecision(
    { action: "deny", approvalId: null, subjectId: "s", userCode: "UC" },
    {
      approve: () => assert.fail("not reached"),
      deny: (uc, sub) => {
        denied = { sub, uc };
      },
      getByApprovalId: () => null,
    }
  );
  assert.deepEqual(denied, { sub: "s", uc: "UC" });
});

// ─── as.introspect ──────────────────────────────────────────────────────

test("as.introspect rejects missing token with 400 invalid_request", async () => {
  const outcome = await executeAsIntrospect({ token: "" }, { introspect: () => assert.fail("not reached") });
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.errorCode, "invalid_request");
});

test("as.introspect strips grant_storage_binding from public envelope", async () => {
  const outcome = await executeAsIntrospect(
    { token: "t" },
    {
      introspect: () => ({
        active: true,
        client_id: "c",
        grant_storage_binding: { connector_id: "github" },
      }),
    }
  );
  assert.equal(outcome.outcome, "success");
  assert.equal(outcome.publicInfo.active, true);
  assert.equal(outcome.publicInfo.client_id, "c");
  assert.equal(
    Object.hasOwn(outcome.publicInfo, "grant_storage_binding"),
    false,
    "grant_storage_binding must not appear on public envelope"
  );
});

// ─── as.polyfill.connector.register / detail ────────────────────────────

test("as.polyfill.connector.register rejects body without connector_key or connector_id", async () => {
  const outcome = await executeAsPolyfillConnectorRegister(
    { manifest: { name: "x" } },
    { registerConnector: () => assert.fail("not reached") }
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.errorCode, "invalid_request");
});

test("as.polyfill.connector.register echoes registered connector key on 201", async () => {
  let captured: unknown;
  const outcome = await executeAsPolyfillConnectorRegister(
    { manifest: { connector_id: "github", name: "GitHub" } },
    {
      registerConnector: (m) => {
        captured = m;
        return "github";
      },
    }
  );
  assert.deepEqual(captured, { connector_id: "github", name: "GitHub" });
  assert.deepEqual(outcome, {
    envelope: { connector_id: "github", connector_key: "github" },
    outcome: "success",
    status: 201,
  });
});

test("as.polyfill.connector.register accepts connector_key identity", async () => {
  let captured: unknown;
  const outcome = await executeAsPolyfillConnectorRegister(
    {
      manifest: {
        connector_key: "custom-source",
        manifest_uri: "https://example.test/manifests/custom-source",
        name: "Custom Source",
      },
    },
    {
      registerConnector: (m) => {
        captured = m;
        return "custom-source";
      },
    }
  );
  assert.deepEqual(captured, {
    connector_key: "custom-source",
    manifest_uri: "https://example.test/manifests/custom-source",
    name: "Custom Source",
  });
  assert.deepEqual(outcome, {
    envelope: { connector_id: "custom-source", connector_key: "custom-source" },
    outcome: "success",
    status: 201,
  });
});

test("as.polyfill.connector.detail returns 404 for unknown id", async () => {
  const outcome = await executeAsPolyfillConnectorDetail(
    { connectorId: "unknown" },
    { getConnectorManifest: () => null }
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 404);
  assert.equal(outcome.errorCode, "not_found");
});

test("as.polyfill.connector.detail returns manifest as envelope", async () => {
  const manifest = { connector_id: "github", streams: ["issues"] };
  const outcome = await executeAsPolyfillConnectorDetail(
    { connectorId: "github" },
    { getConnectorManifest: () => manifest }
  );
  assert.equal(outcome.outcome, "success");
  assert.equal(outcome.envelope, manifest);
});

// ─── as.par.create ──────────────────────────────────────────────────────

test("as.par.create returns narrowed envelope and trace_context", async () => {
  let captured: { body: unknown; opts: { baseUrl: string; nativeManifest: unknown } } | undefined;
  const output = await executeAsParCreate(
    {
      baseUrl: "http://x",
      body: { client_id: "c" },
      nativeManifest: { id: "native" },
    },
    {
      initiateGrant: (body, opts) => {
        captured = { body, opts };
        return {
          authorization_url: "http://x/consent?request_uri=urn:par:abc",
          expires_in: 60,
          extra: "should not leak",
          request_uri: "urn:par:abc",
          trace_context: { request_id: "r", trace_id: "t" },
        };
      },
    }
  );
  assert.ok(captured, "expected initiateGrant to have been called");
  assert.deepEqual(captured.opts, {
    baseUrl: "http://x",
    nativeManifest: { id: "native" },
  });
  assert.equal(output.status, 201);
  assert.deepEqual(output.traceContext, { request_id: "r", trace_id: "t" });
  assert.deepEqual(output.envelope, {
    authorization_url: "http://x/consent?request_uri=urn:par:abc",
    expires_in: 60,
    request_uri: "urn:par:abc",
  });
  const envelopeAsRecord: Record<string, unknown> = output.envelope;
  assert.equal(envelopeAsRecord.extra, undefined);
  assert.equal(envelopeAsRecord.trace_context, undefined);
});

// ─── as.consent.decision (approve / deny) ───────────────────────────────

function makeConsentDeps(overrides: Partial<AsConsentDecisionDependencies> = {}): AsConsentDecisionDependencies {
  return {
    approveGrant: () => {
      throw new Error("approveGrant not expected");
    },
    buildPendingConsentRequestUri: (deviceCode) => `urn:par:${deviceCode}`,
    denyGrant: () => {
      throw new Error("denyGrant not expected");
    },
    getPendingConsentByApprovalId: () => null,
    getPendingFromRequestUri: () => ({ deviceCode: null, pending: null }),
    ...overrides,
  };
}

test("as.consent.decision resolves approval_id to request_uri via build helper", async () => {
  let resolvedUri: string | undefined;
  const outcome = await executeAsConsentDecision(
    {
      action: "deny",
      approvalId: "app_1",
      requestUri: null,
      subjectId: "owner",
    },
    makeConsentDeps({
      buildPendingConsentRequestUri: (deviceCode) => `urn:par:${deviceCode}`,
      denyGrant: () => true,
      getPendingConsentByApprovalId: () => ({ device_code: "dev_1", status: "pending" }),
      getPendingFromRequestUri: (uri) => {
        resolvedUri = uri;
        return { deviceCode: "dev_1", pending: { request: { trace_context: null } } };
      },
    })
  );
  assert.ok(outcome.outcome === "success");
  assert.equal(resolvedUri, "urn:par:dev_1");
});

test("as.consent.decision returns 404 for non-pending approval_id", async () => {
  const outcome = await executeAsConsentDecision(
    {
      action: "approve",
      approvalId: "app_1",
      requestUri: null,
      subjectId: "s",
    },
    makeConsentDeps({
      getPendingConsentByApprovalId: () => ({ device_code: "d", status: "approved" }),
    })
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 404);
  assert.equal(outcome.errorCode, "not_found");
});

test("as.consent.decision rejects when neither requestUri nor approvalId is provided", async () => {
  const outcome = await executeAsConsentDecision(
    { action: "approve", approvalId: null, requestUri: null, subjectId: "s" },
    makeConsentDeps()
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.errorCode, "invalid_request");
});

test("as.consent.decision rejects when getPendingFromRequestUri yields no deviceCode", async () => {
  const outcome = await executeAsConsentDecision(
    {
      action: "approve",
      approvalId: null,
      requestUri: "urn:par:bogus",
      subjectId: "s",
    },
    makeConsentDeps({
      getPendingFromRequestUri: () => ({ deviceCode: null, pending: null }),
    })
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.errorCode, "invalid_request");
});

test("as.consent.decision approve returns grant + token", async () => {
  let approveArgs: unknown;
  const outcome = await executeAsConsentDecision(
    {
      action: "approve",
      approvalId: null,
      approveOptions: { ai_training_consented: true },
      requestUri: "urn:par:dev_1",
      subjectId: "owner",
    },
    makeConsentDeps({
      approveGrant: (deviceCode, subjectId, opts) => {
        approveArgs = { deviceCode, opts, subjectId };
        return {
          grant: { client_id: "c1", grant_id: "g1" },
          token: "tok",
        };
      },
      getPendingFromRequestUri: () => ({
        deviceCode: "dev_1",
        pending: { request: { trace_context: { request_id: "r", trace_id: "t" } } },
      }),
    })
  );
  assert.equal(outcome.outcome, "success");
  assert.equal(outcome.action, "approve");
  assert.deepEqual(outcome.traceContext, { request_id: "r", trace_id: "t" });
  assert.equal(outcome.token, "tok");
  assert.equal(outcome.grant.grant_id, "g1");
  assert.deepEqual(approveArgs, {
    deviceCode: "dev_1",
    opts: { ai_training_consented: true },
    subjectId: "owner",
  });
});

test("as.consent.decision deny → 404 when nothing was deleted", async () => {
  const outcome = await executeAsConsentDecision(
    {
      action: "deny",
      approvalId: null,
      requestUri: "urn:par:dev_1",
      subjectId: "s",
    },
    makeConsentDeps({
      denyGrant: () => false,
      getPendingFromRequestUri: () => ({
        deviceCode: "dev_1",
        pending: { request: { trace_context: null } },
      }),
    })
  );
  assert.equal(outcome.outcome, "failure");
  assert.equal(outcome.status, 404);
  assert.equal(outcome.errorCode, "not_found");
});

// ─── as.consent.exchange ────────────────────────────────────────────────

test("as.consent.exchange rejects missing code", async () => {
  const outcome = await executeAsConsentExchange(
    { code: null },
    {
      consumeConsentExchangeCode: () => {
        throw new Error("not reached");
      },
    }
  );
  assert.ok(outcome.outcome === "failure");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.errorCode, "invalid_request");
});

test("as.consent.exchange maps expired/consumed/unknown reasons to typed errors", async () => {
  const cases: [string, number, string][] = [
    ["expired", 410, "invalid_grant"],
    ["consumed", 410, "invalid_grant"],
    ["unknown", 404, "not_found"],
  ];
  for await (const [reason, status, code] of cases) {
    const outcome = await executeAsConsentExchange(
      { code: "x" },
      { consumeConsentExchangeCode: () => ({ ok: false, reason }) }
    );
    assert.ok(outcome.outcome === "failure");
    assert.equal(outcome.status, status, `reason=${reason}`);
    assert.equal(outcome.errorCode, code, `reason=${reason}`);
  }
});

test("as.consent.exchange returns canonical envelope on success", async () => {
  const grant = { client_id: "c1", grant_id: "g1" };
  const outcome = await executeAsConsentExchange(
    { code: "x" },
    {
      consumeConsentExchangeCode: () => ({
        grant,
        grantId: "g1",
        ok: true,
        token: "tok",
      }),
    }
  );
  assert.equal(outcome.outcome, "success");
  assert.deepEqual(outcome.envelope, {
    grant,
    grant_id: "g1",
    token: "tok",
  });
});

// ─── as.grant.revoke ────────────────────────────────────────────────────

test("as.grant.revoke forwards request_id as audit context and emits {revoked: true}", async () => {
  let captured: unknown;
  const out = await executeAsGrantRevoke(
    { grantId: "g1", requestId: "r1" },
    {
      revokeGrant: (id, ctx) => {
        captured = { ctx, id };
        return { trace_id: "t1" };
      },
    }
  );
  assert.deepEqual(captured, { ctx: { request_id: "r1" }, id: "g1" });
  assert.equal(out.traceId, "t1");
  assert.deepEqual(out.envelope, { revoked: true });
});

test("as.grant.revoke tolerates revokeGrant returning no trace_id", async () => {
  const out = await executeAsGrantRevoke({ grantId: "g1", requestId: "r1" }, { revokeGrant: () => ({}) });
  assert.equal(out.traceId, null);
  assert.deepEqual(out.envelope, { revoked: true });
});
