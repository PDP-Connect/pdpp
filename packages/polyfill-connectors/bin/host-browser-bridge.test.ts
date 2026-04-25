import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { buildBanner, isAllowedHostHeader, isAuthorized, parseArgs } from "./host-browser-bridge.ts";

// `isAuthorized` only reads `headers`. Narrowing the test fixture to that
// surface keeps us out of a double-cast through unknown that the project's
// pre-commit hook (correctly) rejects.
type AuthorizableRequest = Pick<IncomingMessage, "headers">;

function fakeRequest(headers: Record<string, string | undefined>): AuthorizableRequest {
  return { headers };
}

function clearBridgeEnv(): () => void {
  const names = [
    "PDPP_HOST_BRIDGE_PORT",
    "PDPP_HOST_BRIDGE_TOKEN",
    "PDPP_HOST_BRIDGE_BIND_HOST",
    "PDPP_HOST_BRIDGE_ALLOW_PUBLIC_BIND",
  ] as const;
  const previous = new Map<string, string | undefined>();
  for (const n of names) {
    previous.set(n, process.env[n]);
    delete process.env[n];
  }
  return () => {
    for (const [n, v] of previous) {
      if (v === undefined) {
        delete process.env[n];
      } else {
        process.env[n] = v;
      }
    }
  };
}

test("isAuthorized accepts the right token from a loopback host header", () => {
  assert.equal(
    isAuthorized(fakeRequest({ "x-pdpp-bridge-token": "secret", host: "127.0.0.1:7670" }), "secret", "127.0.0.1"),
    true
  );
  assert.equal(
    isAuthorized(fakeRequest({ "x-pdpp-bridge-token": "secret", host: "localhost:7670" }), "secret", "127.0.0.1"),
    true
  );
  assert.equal(
    isAuthorized(
      fakeRequest({ "x-pdpp-bridge-token": "secret", host: "host.docker.internal:7670" }),
      "secret",
      "127.0.0.1"
    ),
    true
  );
});

test("isAuthorized accepts the bound docker-bridge IP as Host", () => {
  assert.equal(
    isAuthorized(fakeRequest({ "x-pdpp-bridge-token": "secret", host: "172.17.0.1:7670" }), "secret", "172.17.0.1"),
    true
  );
  // Also accepts without explicit port.
  assert.equal(
    isAuthorized(fakeRequest({ "x-pdpp-bridge-token": "secret", host: "172.17.0.1" }), "secret", "172.17.0.1"),
    true
  );
});

test("isAuthorized rejects requests with no token", () => {
  assert.equal(isAuthorized(fakeRequest({ host: "127.0.0.1:7670" }), "secret", "127.0.0.1"), false);
});

test("isAuthorized rejects requests with the wrong token", () => {
  assert.equal(
    isAuthorized(fakeRequest({ "x-pdpp-bridge-token": "wrong", host: "127.0.0.1:7670" }), "secret", "127.0.0.1"),
    false
  );
});

test("isAuthorized rejects requests with a non-loopback Host header on a loopback bind", () => {
  for (const host of ["10.0.0.5:7670", "evil.example.com:7670", "172.17.0.1:7670", undefined]) {
    assert.equal(
      isAuthorized(fakeRequest({ "x-pdpp-bridge-token": "secret", host }), "secret", "127.0.0.1"),
      false,
      `host=${String(host)}`
    );
  }
});

test("isAllowedHostHeader never accepts 0.0.0.0 even when bound publicly", () => {
  // Bind-host of 0.0.0.0 must never be reflected back as a valid Host
  // header — clients never legitimately put 0.0.0.0 in Host headers.
  assert.equal(isAllowedHostHeader("0.0.0.0:7670", "0.0.0.0"), false);
  assert.equal(isAllowedHostHeader("0.0.0.0", "0.0.0.0"), false);
});

test("isAllowedHostHeader rejects partial IP prefix matches", () => {
  // A regex bug where dots aren't escaped would accept '172X17X0X1'.
  assert.equal(isAllowedHostHeader("172X17X0X1", "172.17.0.1"), false);
  assert.equal(isAllowedHostHeader("172.17.0.10", "172.17.0.1"), false);
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
  const restore = clearBridgeEnv();
  try {
    assert.throws(() => parseArgs([]), /exit-called/);
    assert.equal(exitCode, 2);
  } finally {
    process.exit = originalExit;
    restore();
  }
});

test("parseArgs reads --profile, --port, --token", () => {
  const restore = clearBridgeEnv();
  try {
    const opts = parseArgs(["--profile", "chatgpt", "--port", "1234", "--token", "abc"]);
    assert.equal(opts.profile, "chatgpt");
    assert.equal(opts.port, 1234);
    assert.equal(opts.token, "abc");
    assert.equal(opts.generatedToken, false);
    assert.equal(opts.bindHost, "127.0.0.1");
  } finally {
    restore();
  }
});

test("parseArgs generates a random token when none is provided", () => {
  const restore = clearBridgeEnv();
  try {
    const opts = parseArgs(["--profile", "chatgpt"]);
    assert.equal(opts.generatedToken, true);
    assert.match(opts.token, /^[a-f0-9]{32}$/);
  } finally {
    restore();
  }
});

test("parseArgs prefers env-supplied token over generation", () => {
  const restore = clearBridgeEnv();
  process.env.PDPP_HOST_BRIDGE_TOKEN = "from-env";
  try {
    const opts = parseArgs(["--profile", "chatgpt"]);
    assert.equal(opts.token, "from-env");
    assert.equal(opts.generatedToken, false);
  } finally {
    restore();
  }
});

test("parseArgs default port is 7670 when PDPP_HOST_BRIDGE_PORT is unset", () => {
  const restore = clearBridgeEnv();
  try {
    const opts = parseArgs(["--profile", "chatgpt"]);
    assert.equal(opts.port, 7670);
  } finally {
    restore();
  }
});

test("parseArgs default bind host is 127.0.0.1", () => {
  const restore = clearBridgeEnv();
  try {
    const opts = parseArgs(["--profile", "chatgpt"]);
    assert.equal(opts.bindHost, "127.0.0.1");
  } finally {
    restore();
  }
});

test("parseArgs accepts --bind-host with an IPv4 address", () => {
  const restore = clearBridgeEnv();
  try {
    const opts = parseArgs(["--profile", "chatgpt", "--bind-host", "172.17.0.1"]);
    assert.equal(opts.bindHost, "172.17.0.1");
  } finally {
    restore();
  }
});

test("parseArgs reads bind host from PDPP_HOST_BRIDGE_BIND_HOST", () => {
  const restore = clearBridgeEnv();
  process.env.PDPP_HOST_BRIDGE_BIND_HOST = "172.17.0.1";
  try {
    const opts = parseArgs(["--profile", "chatgpt"]);
    assert.equal(opts.bindHost, "172.17.0.1");
  } finally {
    restore();
  }
});

test("parseArgs CLI --bind-host overrides the env var", () => {
  const restore = clearBridgeEnv();
  process.env.PDPP_HOST_BRIDGE_BIND_HOST = "172.17.0.1";
  try {
    const opts = parseArgs(["--profile", "chatgpt", "--bind-host", "172.18.0.1"]);
    assert.equal(opts.bindHost, "172.18.0.1");
  } finally {
    restore();
  }
});

test("parseArgs rejects malformed bind hosts", () => {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error("exit-called");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  const restore = clearBridgeEnv();
  try {
    for (const bad of ["not-an-ip", "172.17.0", "1.2.3.4.5", "::1"]) {
      exitCode = undefined;
      assert.throws(() => parseArgs(["--profile", "chatgpt", "--bind-host", bad]), /exit-called/, `bind=${bad}`);
      assert.equal(exitCode, 2, `bind=${bad}`);
    }
  } finally {
    process.exit = originalExit;
    restore();
  }
});

test("parseArgs requires explicit ack to bind 0.0.0.0", () => {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error("exit-called");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  const restore = clearBridgeEnv();
  try {
    assert.throws(() => parseArgs(["--profile", "chatgpt", "--bind-host", "0.0.0.0"]), /exit-called/);
    assert.equal(exitCode, 2);
    // With explicit acknowledgement, the same call succeeds.
    const opts = parseArgs(["--profile", "chatgpt", "--bind-host", "0.0.0.0", "--allow-public-bind"]);
    assert.equal(opts.bindHost, "0.0.0.0");
  } finally {
    process.exit = originalExit;
    restore();
  }
});

test("parseArgs accepts PDPP_HOST_BRIDGE_ALLOW_PUBLIC_BIND=1 as the ack", () => {
  const restore = clearBridgeEnv();
  process.env.PDPP_HOST_BRIDGE_ALLOW_PUBLIC_BIND = "1";
  try {
    const opts = parseArgs(["--profile", "chatgpt", "--bind-host", "0.0.0.0"]);
    assert.equal(opts.bindHost, "0.0.0.0");
  } finally {
    restore();
  }
});

test("buildBanner advertises host.docker.internal when bind is loopback", () => {
  const banner = buildBanner(
    {
      bindHost: "127.0.0.1",
      port: 7670,
      profile: "chatgpt",
      token: "tok",
      generatedToken: true,
    },
    "ws://127.0.0.1:9222/devtools/browser/abc"
  );
  assert.match(banner, /PDPP_HOST_BROWSER_BRIDGE_URL=ws:\/\/host\.docker\.internal:7670/);
  assert.match(banner, /PDPP_HOST_BROWSER_BRIDGE_TOKEN=tok\s+# generated/);
  assert.match(banner, /extra_hosts/);
});

test("buildBanner advertises the bind IP directly when bind is non-loopback", () => {
  const banner = buildBanner(
    {
      bindHost: "172.17.0.1",
      port: 7670,
      profile: "chatgpt",
      token: "tok",
      generatedToken: false,
    },
    "ws://127.0.0.1:9222/devtools/browser/abc"
  );
  assert.match(banner, /PDPP_HOST_BROWSER_BRIDGE_URL=ws:\/\/172\.17\.0\.1:7670/);
  // No extra_hosts hint — it's not needed when the operator targets the IP.
  assert.doesNotMatch(banner, /extra_hosts/);
});

test("buildBanner emits a Linux loopback warning only on Linux", () => {
  const banner = buildBanner(
    {
      bindHost: "127.0.0.1",
      port: 7670,
      profile: "chatgpt",
      token: "tok",
      generatedToken: false,
    },
    "ws://127.0.0.1:9222/devtools/browser/abc"
  );
  if (process.platform === "linux") {
    assert.match(banner, /WARNING.*--bind-host is 127\.0\.0\.1 on Linux/);
    assert.match(banner, /docker bridge gateway IP/);
  } else {
    assert.doesNotMatch(banner, /WARNING.*Linux/);
  }
});

test("buildBanner includes a copy-pasteable container reachability check", () => {
  const banner = buildBanner(
    {
      bindHost: "127.0.0.1",
      port: 7670,
      profile: "chatgpt",
      token: "tok",
      generatedToken: false,
    },
    "ws://127.0.0.1:9222/devtools/browser/abc"
  );
  assert.match(banner, /docker run --rm --add-host=host\.docker\.internal:host-gateway/);
  assert.match(banner, /curlimages\/curl/);
});
