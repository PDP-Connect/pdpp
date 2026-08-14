// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { type MountAsTokenContext, mountAsToken } from "../server/routes/as-oauth.ts";

interface TokenRequest {
  grant_type: string;
  [key: string]: unknown;
}

class ResponseProbe {
  readonly headers = new Map<string, string>();
  body: unknown;
  statusCode = 200;

  setHeader(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }
}

function contextFor(options: {
  exchangeAuthorizationCode?: MountAsTokenContext["exchangeOAuthAuthorizationCode"];
  exchangeDeviceCode?: MountAsTokenContext["exchangeDeviceCode"];
  exchangeRefreshToken?: MountAsTokenContext["exchangeOAuthRefreshToken"];
}): MountAsTokenContext {
  return {
    exchangeDeviceCode: options.exchangeDeviceCode ?? (() => ({ access_token: "device-access", token_type: "Bearer" })),
    exchangeOAuthAuthorizationCode:
      options.exchangeAuthorizationCode ??
      (() => Promise.resolve({ access_token: "code-access", token_type: "Bearer" })),
    exchangeOAuthRefreshToken:
      options.exchangeRefreshToken ??
      (() => Promise.resolve({ access_token: "refresh-access", refresh_token: "refresh-next", token_type: "Bearer" })),
    oauthError: (_res, status, errorCode, errorMessage) => ({ errorCode, errorMessage, status }),
    resolveBaseUrl: () => "https://as.example",
    setReferenceTraceId: () => undefined,
  };
}

async function invokeTokenRoute(body: TokenRequest, ctx: MountAsTokenContext): Promise<ResponseProbe> {
  let handler:
    | ((
        req: { body: TokenRequest; get: (name: string) => string | undefined; protocol: string },
        res: ResponseProbe
      ) => Promise<unknown>)
    | undefined;
  const app = {
    post: (_path: string, ...args: unknown[]) => {
      handler = args.at(-1) as typeof handler;
      return app;
    },
  };
  mountAsToken(app as Parameters<typeof mountAsToken>[0], ctx);
  assert.ok(handler, "token route handler should be registered");
  const response = new ResponseProbe();
  await handler({ body, get: () => undefined, protocol: "https" }, response);
  return response;
}

const CACHE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
};

test("every successful token response branch sets OAuth cache-prevention headers", async () => {
  const cases: Array<{
    name: string;
    body: TokenRequest;
    context: MountAsTokenContext;
    expectedToken: string;
  }> = [
    {
      body: { client_id: "client", code: "code", grant_type: "authorization_code" },
      context: contextFor({
        exchangeAuthorizationCode: async () => ({
          access_token: "code-access",
          grant_id: "grant-1",
          token_type: "Bearer",
        }),
      }),
      expectedToken: "code-access",
      name: "authorization code grant",
    },
    {
      body: { client_id: "client", code: "code", grant_type: "authorization_code" },
      context: contextFor({
        exchangeAuthorizationCode: async () => ({
          access_token: "package-code-access",
          grant_package_id: "package-1",
          token_type: "Bearer",
        }),
      }),
      expectedToken: "package-code-access",
      name: "authorization code package",
    },
    {
      body: { client_id: "client", grant_type: "refresh_token", refresh_token: "refresh" },
      context: contextFor({
        exchangeRefreshToken: async () => ({
          access_token: "refresh-access",
          grant_id: "grant-1",
          refresh_token: "refresh-next",
          token_type: "Bearer",
        }),
      }),
      expectedToken: "refresh-access",
      name: "refresh grant",
    },
    {
      body: { client_id: "client", grant_type: "refresh_token", refresh_token: "refresh" },
      context: contextFor({
        exchangeRefreshToken: async () => ({
          access_token: "package-refresh-access",
          grant_package_id: "package-1",
          refresh_token: "package-refresh-next",
          token_type: "Bearer",
        }),
      }),
      expectedToken: "package-refresh-access",
      name: "refresh package",
    },
    {
      body: {
        client_id: "client",
        device_code: "device",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
      context: contextFor({
        exchangeDeviceCode: async () => ({
          access_token: "device-access",
          grant_package_id: "package-1",
          refresh_token: "device-refresh",
          token_type: "Bearer",
          trace_context: { request_id: "request", trace_id: "trace" },
        }),
      }),
      expectedToken: "device-access",
      name: "device code",
    },
  ];

  await Promise.all(
    cases.map(async (scenario) => {
      const response = await invokeTokenRoute(scenario.body, scenario.context);
      assert.equal(response.statusCode, 200, scenario.name);
      for (const [name, value] of Object.entries(CACHE_HEADERS)) {
        assert.equal(response.headers.get(name), value, `${scenario.name} ${name}`);
      }
      assert.equal((response.body as Record<string, unknown>).access_token, scenario.expectedToken, scenario.name);
    })
  );
});

test("token errors and unsupported grants do not receive token-success headers", async () => {
  const errorResponse = await invokeTokenRoute(
    { client_id: "client", code: "reused", grant_type: "authorization_code" },
    contextFor({
      exchangeAuthorizationCode: () => {
        const error = new Error("code already used") as Error & { code: string };
        error.code = "invalid_grant";
        throw error;
      },
    })
  );
  assert.deepEqual(Object.fromEntries(errorResponse.headers), {});
  assert.equal(errorResponse.statusCode, 200, "the stubbed OAuth error does not alter status");

  const unsupportedResponse = await invokeTokenRoute(
    { client_id: "client", grant_type: "client_credentials" },
    contextFor({})
  );
  assert.deepEqual(Object.fromEntries(unsupportedResponse.headers), {});
});
