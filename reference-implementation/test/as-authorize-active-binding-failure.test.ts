// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeHostedMcpSelection,
  encodeHostedMcpStreamSelection,
  hostedMcpSourceKey,
  parseHostedMcpSelections,
  parseHostedMcpStreamSelections,
} from "../server/hosted-mcp-selection.ts";
import { mountAsAuthorize } from "../server/routes/as-authorize.ts";

type CapturedRouteHandler = (...args: unknown[]) => unknown;

interface TestApp {
  get: (path: string, ...handlers: unknown[]) => TestApp;
  post: (path: string, ...handlers: unknown[]) => TestApp;
}

test("POST /oauth/authorize/mcp-package reports an active-binding storage failure as a safe server error", async () => {
  // A store outage used to become an empty binding list and then owner error
  // 400. This route-level harness injects that failed read and verifies the
  // OAuth error writer sees the established 500/server_error contract before
  // any package-creation effect can run.
  const postHandlers = new Map<string, CapturedRouteHandler>();
  let packageCreateCalls = 0;
  const oauthErrors: Array<{ code: string; message: string; status: number }> = [];
  const app: TestApp = {
    get: () => app,
    post: (_path: string, ...handlers: Array<unknown>) => {
      const handler = handlers.findLast((value): value is CapturedRouteHandler => typeof value === "function");
      if (handler) {
        postHandlers.set(_path, handler);
      }
      return app;
    },
  };

  mountAsAuthorize(app, {
    asPublicUrl: null,
    consentPickerCaps: {
      canonicalConnectorKey: () => null,
      encodeHostedMcpSelection,
      encodeHostedMcpStreamSelection,
      getConnectorManifest: async () => ({
        connector_id: "connector_under_test",
        source_declaration: {
          source: { id: "https://example.test/connectors/under-test", kind: "connector" },
        },
        streams: [{ name: "declared_stream" }],
      }),
      hostedMcpSourceKey,
      isInternalConnectorId: () => false,
      listActiveBindingsForGrant: async () => {
        throw new Error("injected storage failure");
      },
      listRegisteredConnectorIds: async () => [],
      listStreamsWithRecords: async () => [],
      projectBindingForWire: () => null,
    },
    consentStore: {} as never,
    consentUi: {} as never,
    createHostedMcpGrantPackage: async () => {
      packageCreateCalls += 1;
      throw new Error("must not create a package after a failed active-binding lookup");
    },
    ensureCsrfToken: () => "csrf_test",
    ensureRequestId: () => "req_test",
    getRegisteredClient: async () => ({ metadata: { redirect_uris: ["https://client.example/callback"] } }),
    ignoreAmbientPublicUrls: true,
    issueOAuthAuthorizationCodeForPackageDeviceCode: async () => null,
    nativeManifest: null,
    oauthError: (_res, status, code, message) => {
      oauthErrors.push({ code, message, status });
    },
    providerName: "PDPP",
    requireCsrf: (() => undefined) as never,
    requireOwnerSession: (() => undefined) as never,
    resolvePublicUrl: () => "http://as.example",
    selectionParsers: {
      parseHostedMcpSelections,
      parseHostedMcpStreamSelections,
    },
    stageOAuthAuthorizationCodeRequest: async () => undefined,
  });

  const postHandler = postHandlers.get("/oauth/authorize/mcp-package");
  assert.ok(postHandler, "mount must register the package POST handler");
  await postHandler(
    {
      body: {
        client_id: "client_test",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
        redirect_uri: "https://client.example/callback",
        response_type: "code",
        selection: encodeHostedMcpSelection({ connectionId: null, connectorId: "connector_under_test" }),
        stream: encodeHostedMcpStreamSelection({
          connectionId: null,
          connectorId: "connector_under_test",
          streamName: "declared_stream",
        }),
      },
      ownerAuth: { subjectId: "owner_test" },
    },
    {}
  );

  assert.deepEqual(oauthErrors, [
    { code: "server_error", message: "Unable to verify active connection state", status: 500 },
  ]);
  assert.equal(packageCreateCalls, 0, "the outage must fail closed before package creation");
});
