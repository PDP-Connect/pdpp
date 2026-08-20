// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { registerConnector } from "../../../reference-implementation/server/auth.ts";
import { startServer } from "../../../reference-implementation/server/index.ts";
import { ingestRecord } from "../../../reference-implementation/server/records.ts";
import { createRequestConnectorInstanceStore } from "../../../reference-implementation/server/request-store-factories.ts";
import { runOwnerAgent } from "../src/owner-agent/command.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..", "..", "..", "reference-implementation");
const TEST_PASSWORD = "owner-agent-reference-smoke-password";
const TEST_SUBJECT = "owner_agent_reference_smoke_owner";

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: {
        write: (chunk) => {
          out += chunk;
        },
      },
      stderr: {
        write: (chunk) => {
          err += chunk;
        },
      },
    },
    get stderr() {
      return err;
    },
    get stdout() {
      return out;
    },
  };
}

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv) =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function withTmpHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "pdpp-owner-agent-reference-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, resp, status: resp.status };
}

function getRawSetCookieList(resp) {
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies, name) {
  for (const header of setCookies) {
    const [firstPair] = header.split(";");
    if (firstPair.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html) {
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  const match = html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/);
  return match ? match[1] : null;
}

async function fetchCsrfFromForm(asUrl, path, sessionCookie = "") {
  const resp = await fetch(`${asUrl}${path}`, {
    headers: { Accept: "text/html", Cookie: sessionCookie },
    redirect: "manual",
  });
  const setCookies = getRawSetCookieList(resp);
  const html = await resp.text();
  return {
    csrfCookie: findSetCookiePair(setCookies, "pdpp_owner_csrf"),
    csrfField: extractCsrfFieldValue(html),
  };
}

async function login(asUrl) {
  const csrf = await fetchCsrfFromForm(asUrl, "/owner/login");
  const resp = await fetch(`${asUrl}/owner/login`, {
    method: "POST",
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrf.csrfCookie,
    },
    body: new URLSearchParams({
      password: TEST_PASSWORD,
      return_to: "/deployment/tokens",
      _csrf: csrf.csrfField,
    }).toString(),
    redirect: "manual",
  });
  assert.equal(resp.status, 302);
  const sessionCookie = findSetCookiePair(getRawSetCookieList(resp), "pdpp_owner_session");
  assert.ok(sessionCookie, "login should issue owner session cookie");
  return sessionCookie;
}

function loadNorthstarManifest() {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests", "northstar-hr.json"), "utf8"));
}

async function seedNorthstar(nativeManifest) {
  await registerConnector({
    connector_key: nativeManifest.storage_binding.connector_id,
    declaration_version: nativeManifest.source_declaration.declaration_version,
    name: nativeManifest.name,
    source_declaration: nativeManifest.source_declaration,
    streams: nativeManifest.streams,
    version: nativeManifest.version,
  });
  const instance = await createRequestConnectorInstanceStore().ensureDefaultAccountConnection({
    connectorId: nativeManifest.storage_binding.connector_id,
    displayName: "Northstar HR",
    now: "2026-05-31T00:00:00Z",
    ownerSubjectId: TEST_SUBJECT,
  });
  await ingestRecord(
    {
      connector_id: nativeManifest.storage_binding.connector_id,
      connector_instance_id: instance.connectorInstanceId,
    },
    {
      stream: "pay_statements",
      key: "ps_owner_agent_cli_smoke_1",
      data: {
        statement_id: "ps_owner_agent_cli_smoke_1",
        employer: "Northstar HR",
        gross_pay: 5400,
        net_pay: 3912,
        currency: "USD",
        employee_id: "emp_cli_smoke",
      },
      emitted_at: "2026-05-31T00:00:00Z",
    }
  );
}

async function approveDeviceCode(asUrl, sessionCookie, userCode) {
  const resp = await fetch(`${asUrl}/device/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ user_code: userCode }),
  });
  assert.equal(resp.status, 200);
}

function buildAutoApprovingFetch({ asUrl, sessionCookie }) {
  let device: { user_code: string } | null = null;
  let approved = false;

  return async (url, opts = {}) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href === `${asUrl}/oauth/token` && device && !approved) {
      await approveDeviceCode(asUrl, sessionCookie, device.user_code);
      approved = true;
    }

    const resp = await fetch(url, opts);
    if (href === `${asUrl}/oauth/device_authorization`) {
      device = await resp.clone().json();
      assert.ok(device.user_code, "device authorization should return a user code");
    }
    return resp;
  };
}

test("owner-agent CLI smoke discovers metadata, writes Daisy credential, reads REST, rejects MCP, and revokes", async () => {
  await withTmpHome(async (home) => {
    const nativeManifest = loadNorthstarManifest();
    const asPort = await freePort();
    const rsPort = await freePort();
    const asUrl = `http://127.0.0.1:${asPort}`;
    const rsUrl = `http://127.0.0.1:${rsPort}`;
    const server = await startServer({
      quiet: true,
      asPort,
      rsPort,
      bindHost: "127.0.0.1",
      dbPath: ":memory:",
      nativeManifest,
      ownerAuthPassword: TEST_PASSWORD,
      ownerAuthSubjectId: TEST_SUBJECT,
      referenceMode: "composed",
      referenceOrigin: rsUrl,
      asPublicUrl: asUrl,
      rsPublicUrl: rsUrl,
      ignoreAmbientPublicUrls: true,
      trustedMetadataHosts: ["127.0.0.1"],
    });

    try {
      await seedNorthstar(nativeManifest);
      const sessionCookie = await login(asUrl);

      const metadata = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
      assert.equal(metadata.status, 200);
      assert.equal(metadata.body.pdpp_owner_agent_onboarding.authorization_server, asUrl);
      assert.equal(metadata.body.pdpp_owner_agent_onboarding.resource, rsUrl);
      assert.equal(metadata.body.pdpp_owner_agent_onboarding.schema_endpoint, `${rsUrl}/v1/schema`);
      assert.equal(
        metadata.body.pdpp_owner_agent_onboarding.schema_compact_endpoint,
        `${rsUrl}/v1/schema?view=compact`
      );

      const credentialPath = join(home, "applications/daisy/.pi/agent/pdpp-owner-agent.json");
      const onboarding = capture();
      const onboardCode = await runOwnerAgent(
        ["onboard", rsUrl, "--credential-file", credentialPath, "--client-name", "Daisy reference smoke"],
        onboarding.io,
        {
          fetch: buildAutoApprovingFetch({ asUrl, sessionCookie }),
          home,
          sleep: () => Promise.resolve(),
          now: () => Date.parse("2026-05-31T00:00:00Z"),
        }
      );
      assert.equal(onboardCode, 0, onboarding.stderr);
      assert.ok(existsSync(credentialPath));
      // biome-ignore lint/suspicious/noBitwiseOperators: genuine POSIX file-mode bitmask, not a style mistake.
      assert.equal(statSync(credentialPath).mode & 0o777, 0o600);

      const credential = JSON.parse(readFileSync(credentialPath, "utf8"));
      assert.equal(credential.profile, "trusted_owner_agent");
      assert.equal(credential.pdpp_token_kind, "owner");
      assert.equal(credential.resource, rsUrl);
      assert.equal(credential.authorization_server, asUrl);
      assert.equal(credential.schema_endpoint, `${rsUrl}/v1/schema`);
      assert.equal(credential.schema_compact_endpoint, `${rsUrl}/v1/schema?view=compact`);
      assert.equal(credential.streams_endpoint, `${rsUrl}/v1/streams`);
      assert.equal(credential.registration_client_uri, `${asUrl}/oauth/register/${credential.client_id}`);
      assert.equal(credential.credential.access_token, credential.access_token);
      assert.ok(credential.access_token, "credential should include the owner access token for the local agent");
      assert.doesNotMatch(onboarding.stdout, new RegExp(credential.access_token));
      assert.doesNotMatch(onboarding.stderr, new RegExp(credential.access_token));

      const status = capture();
      const statusCode = await runOwnerAgent(["status", "--credential-file", credentialPath], status.io, { fetch });
      assert.equal(statusCode, 0);
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      assert.match(status.stdout, /active: true/);
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      assert.match(status.stdout, /token kind: owner/);
      assert.doesNotMatch(status.stdout, new RegExp(credential.access_token));

      // Control discovery: non-secret capability document + connection listing
      // against the live owner-bearer surface. Proves a trusted owner agent can
      // discover capabilities and connections without printing the bearer.
      const control = capture();
      const controlCode = await runOwnerAgent(["control", "--credential-file", credentialPath], control.io, { fetch });
      assert.equal(controlCode, 0);
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      assert.match(control.stdout, /Owner-agent control capabilities/);
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      assert.match(control.stdout, /list_connections \[supported\]/);
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      assert.match(control.stdout, /initiate_connection \[supported\]/);
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      assert.match(control.stdout, /\/mcp owner bearer: rejected/i);
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      assert.match(control.stdout, /Configured connections/);
      assert.doesNotMatch(control.stdout, new RegExp(credential.access_token));
      assert.doesNotMatch(control.stderr, new RegExp(credential.access_token));

      const authHeaders = { Authorization: `Bearer ${credential.access_token}` };
      const schema = await fetchJson(`${rsUrl}/v1/schema?view=compact`, { headers: authHeaders });
      assert.equal(schema.status, 200);
      assert.equal(schema.body.detail, "compact");

      const streams = await fetchJson(`${rsUrl}/v1/streams`, { headers: authHeaders });
      assert.equal(streams.status, 200);
      assert.ok(streams.body.data.some((stream) => stream.name === "pay_statements"));

      const records = await fetchJson(`${rsUrl}/v1/streams/pay_statements/records?limit=1`, {
        headers: authHeaders,
      });
      assert.equal(records.status, 200);
      assert.equal(records.body.data?.[0]?.id, "ps_owner_agent_cli_smoke_1");

      const mcp = await fetchJson(`${rsUrl}/mcp`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      assert.equal(mcp.status, 403);
      assert.equal(mcp.body.error.code, "permission_error");
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      assert.match(mcp.body.error.message, /owner-agent REST onboarding/);

      const revoke = capture();
      const revokeCode = await runOwnerAgent(
        ["revoke", "--credential-file", credentialPath, "--owner-session", sessionCookie],
        revoke.io,
        { fetch }
      );
      assert.equal(revokeCode, 0);
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      assert.match(revoke.stdout, /revoked/i);

      const revokedStatus = capture();
      const revokedStatusCode = await runOwnerAgent(["status", "--credential-file", credentialPath], revokedStatus.io, {
        fetch,
      });
      assert.equal(revokedStatusCode, 1);
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      assert.match(revokedStatus.stdout, /active: false/);
    } finally {
      await closeServer(server);
    }
  });
});
