// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { CredentialError, OptionParseError, parseOptions, runMcpServerCli } from "../src/index.ts";

const REFUSING_TO_START = /Refusing to start/;
const NO_SCOPED_PDPP_CREDENTIAL = /No scoped PDPP credential/;
const PDPP_CONNECT = /pdpp connect/;
const CONNECTED_TO_HTTPS_EXAMPLE_COM = /connected to https:\/\/example.com/;

function stderrSink() {
  const chunks: string[] = [];
  return { chunks, stderr: { write: (chunk: unknown) => chunks.push(String(chunk)) } };
}

test("parseOptions reads --provider-url and defaults", () => {
  const options = parseOptions(["--provider-url", "https://pdpp.example.com"], {});
  assert.equal(options.providerUrl, "https://pdpp.example.com");
  assert.equal(options.cacheRoot, ".pdpp");
  assert.equal(options.serverName, "pdpp-mcp-server");
});

test("parseOptions reads env defaults", () => {
  const options = parseOptions([], {
    PDPP_PROVIDER_URL: "https://env.example.com",
    PDPP_CACHE_ROOT: "/custom/.pdpp",
    PDPP_MCP_SERVER_NAME: "env-server",
  });
  assert.equal(options.providerUrl, "https://env.example.com");
  assert.equal(options.cacheRoot, "/custom/.pdpp");
  assert.equal(options.serverName, "env-server");
});

test("parseOptions throws when provider URL is missing", () => {
  assert.throws(
    () => parseOptions([], {}),
    (error) => error instanceof OptionParseError && error.exitCode === 64
  );
});

test("parseOptions refuses owner credentials in environment", () => {
  assert.throws(
    () => parseOptions(["--provider-url", "https://x"], { PDPP_OWNER_TOKEN: "secret" }),
    (error) => error instanceof OptionParseError && error.exitCode === 77
  );

  assert.throws(
    () =>
      parseOptions(["--provider-url", "https://x"], {
        PDPP_OWNER_SESSION_COOKIE: "session=...",
      }),
    (error) => error instanceof OptionParseError && error.exitCode === 77
  );
});

test("runMcpServerCli refuses to start when PDPP_OWNER_TOKEN is set", async () => {
  const { chunks: stderrChunks, stderr } = stderrSink();
  let loadCalled = false;
  let startCalled = false;

  const exit = await runMcpServerCli(["--provider-url", "https://x"], {
    stderr,
    env: { PDPP_OWNER_TOKEN: "secret" },
    // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
    loadScopedCredential: async () => {
      loadCalled = true;
      return {
        providerUrl: "https://x",
        accessToken: "t",
        cacheFile: "/tmp/x",
        grantId: null,
        scope: null,
        tokenType: "Bearer",
      };
    },
    // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
    startStdioServer: async () => {
      startCalled = true;
    },
  });

  assert.equal(exit, 77);
  assert.equal(loadCalled, false, "credential loader must not be invoked");
  assert.equal(startCalled, false, "stdio server must not start");
  assert.match(stderrChunks.join(""), REFUSING_TO_START);
});

test("runMcpServerCli surfaces missing-credential guidance and exits non-zero", async () => {
  const { chunks: stderrChunks, stderr } = stderrSink();
  let startCalled = false;

  const exit = await runMcpServerCli(["--provider-url", "https://x"], {
    stderr,
    env: {},
    // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
    loadScopedCredential: async () => {
      throw new CredentialError(
        "not_connected",
        "No scoped PDPP credential cached for https://x. Run `pdpp connect https://x` and try again.",
        78
      );
    },
    // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
    startStdioServer: async () => {
      startCalled = true;
    },
  });

  assert.equal(exit, 78);
  assert.equal(startCalled, false);
  assert.match(stderrChunks.join(""), NO_SCOPED_PDPP_CREDENTIAL);
  assert.match(stderrChunks.join(""), PDPP_CONNECT);
});

test("runMcpServerCli boots stdio server when scoped credential resolves", async () => {
  const { chunks: stderrChunks, stderr } = stderrSink();
  let startedWith: unknown;

  const exit = await runMcpServerCli(["--provider-url", "https://example.com"], {
    stderr,
    env: {},
    // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
    loadScopedCredential: async (providerUrl, options) => {
      assert.equal(providerUrl, "https://example.com");
      assert.equal(options?.cacheRoot, ".pdpp");
      return {
        providerUrl: "https://example.com",
        accessToken: "scoped-token",
        cacheFile: "/tmp/.pdpp/clients/example.com.json",
        grantId: null,
        scope: null,
        tokenType: "Bearer",
      };
    },
    // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
    startStdioServer: async (opts) => {
      startedWith = opts;
    },
  });

  assert.equal(exit, 0);
  assert.deepEqual(startedWith, {
    providerUrl: "https://example.com",
    accessToken: "scoped-token",
    serverName: "pdpp-mcp-server",
  });
  const stderrText = stderrChunks.join("");
  assert.match(stderrText, CONNECTED_TO_HTTPS_EXAMPLE_COM);
  assert.ok(!stderrText.includes("scoped-token"), "access token must not be logged");
});
