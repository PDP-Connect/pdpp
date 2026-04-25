import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { isAuthorized, parseArgs } from "./host-browser-bridge.ts";

// `isAuthorized` only reads `headers`. Narrowing the test fixture to that
// surface keeps us out of a double-cast through unknown that the project's
// pre-commit hook (correctly) rejects.
type AuthorizableRequest = Pick<IncomingMessage, "headers">;

function fakeRequest(headers: Record<string, string | undefined>): AuthorizableRequest {
  return { headers };
}

test("isAuthorized accepts the right token from a loopback host header", () => {
  assert.equal(isAuthorized(fakeRequest({ "x-pdpp-bridge-token": "secret", host: "127.0.0.1:7670" }), "secret"), true);
  assert.equal(isAuthorized(fakeRequest({ "x-pdpp-bridge-token": "secret", host: "localhost:7670" }), "secret"), true);
  assert.equal(
    isAuthorized(fakeRequest({ "x-pdpp-bridge-token": "secret", host: "host.docker.internal:7670" }), "secret"),
    true
  );
});

test("isAuthorized rejects requests with no token", () => {
  assert.equal(isAuthorized(fakeRequest({ host: "127.0.0.1:7670" }), "secret"), false);
});

test("isAuthorized rejects requests with the wrong token", () => {
  assert.equal(isAuthorized(fakeRequest({ "x-pdpp-bridge-token": "wrong", host: "127.0.0.1:7670" }), "secret"), false);
});

test("isAuthorized rejects requests with a non-loopback Host header", () => {
  for (const host of ["10.0.0.5:7670", "evil.example.com:7670", "0.0.0.0:7670", undefined]) {
    assert.equal(
      isAuthorized(fakeRequest({ "x-pdpp-bridge-token": "secret", host }), "secret"),
      false,
      `host=${String(host)}`
    );
  }
});

test("parseArgs requires --profile", () => {
  // Spy on process.exit so we can assert without actually exiting.
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error("exit-called");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  const originalEnv = process.env.PDPP_HOST_BRIDGE_PORT;
  delete process.env.PDPP_HOST_BRIDGE_PORT;
  try {
    assert.throws(() => parseArgs([]), /exit-called/);
    assert.equal(exitCode, 2);
  } finally {
    process.exit = originalExit;
    if (originalEnv !== undefined) {
      process.env.PDPP_HOST_BRIDGE_PORT = originalEnv;
    }
  }
});

test("parseArgs reads --profile, --port, --token", () => {
  const previousToken = process.env.PDPP_HOST_BRIDGE_TOKEN;
  const previousPort = process.env.PDPP_HOST_BRIDGE_PORT;
  delete process.env.PDPP_HOST_BRIDGE_TOKEN;
  delete process.env.PDPP_HOST_BRIDGE_PORT;
  try {
    const opts = parseArgs(["--profile", "chatgpt", "--port", "1234", "--token", "abc"]);
    assert.equal(opts.profile, "chatgpt");
    assert.equal(opts.port, 1234);
    assert.equal(opts.token, "abc");
    assert.equal(opts.generatedToken, false);
  } finally {
    if (previousToken !== undefined) {
      process.env.PDPP_HOST_BRIDGE_TOKEN = previousToken;
    }
    if (previousPort !== undefined) {
      process.env.PDPP_HOST_BRIDGE_PORT = previousPort;
    }
  }
});

test("parseArgs generates a random token when none is provided", () => {
  const previousToken = process.env.PDPP_HOST_BRIDGE_TOKEN;
  delete process.env.PDPP_HOST_BRIDGE_TOKEN;
  try {
    const opts = parseArgs(["--profile", "chatgpt"]);
    assert.equal(opts.generatedToken, true);
    assert.match(opts.token, /^[a-f0-9]{32}$/);
  } finally {
    if (previousToken !== undefined) {
      process.env.PDPP_HOST_BRIDGE_TOKEN = previousToken;
    }
  }
});

test("parseArgs prefers env-supplied token over generation", () => {
  process.env.PDPP_HOST_BRIDGE_TOKEN = "from-env";
  try {
    const opts = parseArgs(["--profile", "chatgpt"]);
    assert.equal(opts.token, "from-env");
    assert.equal(opts.generatedToken, false);
  } finally {
    delete process.env.PDPP_HOST_BRIDGE_TOKEN;
  }
});

test("parseArgs default port is 7670 when PDPP_HOST_BRIDGE_PORT is unset", () => {
  const previousPort = process.env.PDPP_HOST_BRIDGE_PORT;
  delete process.env.PDPP_HOST_BRIDGE_PORT;
  try {
    const opts = parseArgs(["--profile", "chatgpt"]);
    assert.equal(opts.port, 7670);
  } finally {
    if (previousPort !== undefined) {
      process.env.PDPP_HOST_BRIDGE_PORT = previousPort;
    }
  }
});
