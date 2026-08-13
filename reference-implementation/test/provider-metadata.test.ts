// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createPdppCliCommand, getPdppCliPackageInfo } from "../../packages/cli/src/package-info.ts";
import { createCimdDocument } from "../server/auth.ts";
import { startServer } from "../server/index.ts";
import { resolvePublicUrl, resolveSiblingPublicUrl } from "../server/metadata.ts";
import { PDPP_REFERENCE_REVISION_HEADER } from "../server/reference-revision.ts";

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
interface JsonObject {
  [key: string]: any;
}

interface CloseableServer {
  close: (callback: (err?: Error) => void) => void;
  closeAllConnections: () => void;
}

function isCloseableServer(value: unknown): value is CloseableServer {
  return (
    typeof value === "object" &&
    value !== null &&
    "close" in value &&
    typeof value.close === "function" &&
    "closeAllConnections" in value &&
    typeof value.closeAllConnections === "function"
  );
}

function requireCloseableServer(value: unknown, description: string): CloseableServer {
  if (!isCloseableServer(value)) {
    throw new TypeError(`${description} must be closeable`);
  }
  return value;
}

type TestServer = Awaited<ReturnType<typeof startServer>>;

async function closeServer(server: TestServer): Promise<void> {
  // Force-close keep-alive connections to prevent hanging.
  // Clear fallback timers when close callbacks win so the harness does not
  // retain stray timer handles after an otherwise clean shutdown.
  const asServer = requireCloseableServer(server.asServer, "authorization server");
  const rsServer = requireCloseableServer(server.rsServer, "resource server");
  asServer.closeAllConnections();
  rsServer.closeAllConnections();

  const closeWithTimeout = (srv: CloseableServer): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);

      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });

  await Promise.allSettled([closeWithTimeout(asServer), closeWithTimeout(rsServer)]);
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ status: number; body: JsonObject }> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as JsonObject;
  return { body, status: resp.status };
}

function expectReferenceRevisionHeader(resp: Response, expectedRevision: string): void {
  assert.equal(resp.headers.get(PDPP_REFERENCE_REVISION_HEADER), expectedRevision);
}

function assertPublicClientAdvertised(metadata: JsonObject, clientId: string, clientName: string): void {
  const clients = metadata.pdpp_pre_registered_public_clients;
  assert.ok(Array.isArray(clients), "expected pdpp_pre_registered_public_clients array");
  const client = clients.find((entry) => entry.client_id === clientId);
  assert.ok(client, `expected public client ${clientId} to be advertised`);
  assert.deepEqual(client, {
    client_id: clientId,
    client_name: clientName,
    token_endpoint_auth_method: "none",
  });
}

function assertCimdRegistrationModes(
  metadata: JsonObject,
  baseModes: string[] = ["dynamic", "pre_registered_public"]
): void {
  assert.deepEqual(metadata.pdpp_registration_modes_supported, [...baseModes, "client_id_metadata_document"]);
  assert.equal(metadata.client_id_metadata_document_supported, true);
}

function expectedDeviceAuthorizationProfiles() {
  return [
    {
      authorization_details_type: "https://pdpp.dev/data-access",
      normal_mcp_setup: true,
      pdpp_token_kind: "client",
      profile: "grant_scoped_mcp",
      required_parameters: ["client_id", "resource", "authorization_details"],
    },
    {
      advertised_in: "pdpp_owner_agent_onboarding",
      mcp_owner_bearer_rejected: true,
      normal_mcp_setup: false,
      pdpp_token_kind: "owner",
      profile: "trusted_owner_agent",
    },
  ];
}

function assertDeviceAuthorizationProfiles(metadata: JsonObject): void {
  assert.deepEqual(metadata.pdpp_device_authorization_profiles_supported, expectedDeviceAuthorizationProfiles());
}

function expectedMcpAuthorization({ resource, issuer }: { resource: string; issuer: string }): JsonObject {
  return {
    authorization_code_pkce: {
      authorization_endpoint: `${issuer}/oauth/authorize`,
      flow: "authorization_code_pkce",
      pdpp_token_kind: "client",
      resource,
      resource_parameter: "required",
    },
    device_code: {
      authorization_details_type: "https://pdpp.dev/data-access",
      device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
      flow: "device_code",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      owner_bearer_accepted: false,
      pdpp_token_kind: "client",
      required_parameters: ["client_id", "resource", "authorization_details"],
      resource,
      token_endpoint: `${issuer}/oauth/token`,
    },
    owner_agent_device_code: {
      advertised_in: "pdpp_owner_agent_onboarding",
      flow: "device_code",
      mcp_owner_bearer_rejected: true,
      normal_mcp_setup: false,
      pdpp_token_kind: "owner",
    },
  };
}

async function fetchJsonResponse(url: string, opts: RequestInit = {}): Promise<{ resp: Response; body: JsonObject }> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as JsonObject;
  return { body, resp };
}

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
async function httpRequestJson(
  url: string,
  { headers = {} }: { headers?: Record<string, string> } = {}
): Promise<{ status?: number; headers: IncomingHttpHeaders; body: JsonObject }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        headers,
        hostname: target.hostname,
        method: "GET",
        path: `${target.pathname}${target.search}`,
        port: target.port,
      },
      (resp) => {
        const chunks: Buffer[] = [];
        resp.on("data", (chunk) => chunks.push(chunk));
        resp.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve({
              ...(resp.statusCode === undefined ? {} : { status: resp.statusCode }),
              body: body as JsonObject,
              headers: resp.headers,
            });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("ephemeral local servers ignore leaked public-url env when computing metadata", async () => {
  const previous = {
    AS_ISSUER: process.env.AS_ISSUER,
    AS_PUBLIC_URL: process.env.AS_PUBLIC_URL,
    PDPP_REFERENCE_MODE: process.env.PDPP_REFERENCE_MODE,
    PDPP_REFERENCE_ORIGIN: process.env.PDPP_REFERENCE_ORIGIN,
    RS_PUBLIC_URL: process.env.RS_PUBLIC_URL,
  };
  process.env.AS_PUBLIC_URL = "https://wrong-as.example";
  process.env.AS_ISSUER = "https://wrong-issuer.example";
  process.env.RS_PUBLIC_URL = "https://wrong-rs.example";
  process.env.PDPP_REFERENCE_MODE = "composed";
  process.env.PDPP_REFERENCE_ORIGIN = "https://wrong-web.example";

  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, rsUrl);
    assert.deepEqual(protectedResource.body.authorization_servers, [asUrl]);
    assert.equal(
      Object.hasOwn(protectedResource.body, "pdpp_agent_discovery"),
      false,
      "direct ephemeral RS must not advertise browser-hosted agent discovery URLs"
    );

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, asUrl);
    assert.equal(authorizationServer.body.device_authorization_endpoint, `${asUrl}/oauth/device_authorization`);
  } finally {
    await closeServer(server);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("composed mode env drives browser-facing metadata when explicit public urls are unset", async () => {
  const previous = {
    AS_PUBLIC_URL: process.env.AS_PUBLIC_URL,
    PDPP_REFERENCE_MODE: process.env.PDPP_REFERENCE_MODE,
    PDPP_REFERENCE_ORIGIN: process.env.PDPP_REFERENCE_ORIGIN,
    RS_PUBLIC_URL: process.env.RS_PUBLIC_URL,
  };
  process.env.PDPP_REFERENCE_MODE = "composed";
  process.env.PDPP_REFERENCE_ORIGIN = "http://localhost:3200";
  delete process.env.AS_PUBLIC_URL;
  delete process.env.RS_PUBLIC_URL;

  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ignoreAmbientPublicUrls: false,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const expectedCli = getPdppCliPackageInfo("http://localhost:3200");

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, "http://localhost:3200");
    assert.deepEqual(protectedResource.body.authorization_servers, ["http://localhost:3200"]);
    assert.equal(protectedResource.body.pdpp_core_query_base, "http://localhost:3200/v1");
    assert.deepEqual(protectedResource.body.pdpp_agent_discovery, {
      advisory: true,
      cli: {
        bin_name: expectedCli.binName,
        connect_command: createPdppCliCommand("<provider-url>"),
        install_command: `npx -y ${expectedCli.packageSpecifier} --help`,
        no_owner_token: false,
        no_owner_token_policy: "requires_native_reference_provider_for_one_command_connect",
        package: expectedCli.packageName,
        package_specifier: expectedCli.packageSpecifier,
        run_command: expectedCli.runCommand,
        version_policy: expectedCli.versionPolicy,
      },
      llms_full_txt: "http://localhost:3200/llms-full.txt",
      llms_txt: "http://localhost:3200/llms.txt",
      mcp: {
        authorization: expectedMcpAuthorization({
          issuer: "http://localhost:3200",
          resource: "http://localhost:3200/mcp",
        }),
        endpoint: "http://localhost:3200/mcp",
        no_owner_token: true,
        setup_intent: "grant_scoped_read",
        tool_surface: "profile_free_normal_read",
        transport: "streamable_http",
      },
      recommended_flow: "pdpp connect",
      skill: "http://localhost:3200/.well-known/skills/pdpp-data-access/SKILL.md",
      skill_catalog: "http://localhost:3200/.well-known/skills/index.json",
      skill_name: "pdpp-data-access",
    });

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, "http://localhost:3200");
    assert.equal(
      authorizationServer.body.device_authorization_endpoint,
      "http://localhost:3200/oauth/device_authorization"
    );
    assertDeviceAuthorizationProfiles(authorizationServer.body);
    assert.equal(authorizationServer.body.pushed_authorization_request_endpoint, "http://localhost:3200/oauth/par");
  } finally {
    await closeServer(server);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

// ─── Discovery round-trip: advertised agent URLs must not 404 ───────────────
// Regression for the Simon/agent discoverability defect: the RS metadata can
// advertise agent-facing docs/skill pointers (`skill`, `skill_catalog`,
// `llms_txt`, `llms_full_txt`, `mcp.endpoint`). Those routes are served by the
// console/site Next.js origin, NOT the RS origin. In direct/ephemeral topology
// the `/mcp` protected-resource metadata used to rebase those pointers onto the
// RS origin itself, so an agent that followed them hit a 404 at the very origin
// where `/v1/streams` lives. This gate asserts that whatever URL the RS
// metadata advertises, if it names the RS's own origin a GET returns < 400 —
// i.e. the RS never advertises an RS-origin URL it does not serve.

// The docs/skill pointers the RS origin does NOT serve. Only the
// console/site Next.js origin serves these routes; the RS serves none of
// them, so advertising any of them rebased onto the RS origin produces a 404.
const RS_UNSERVED_DOCS_KEYS = ["skill", "skill_catalog", "llms_txt", "llms_full_txt"];

// Assert that every docs/skill pointer in a `pdpp_agent_discovery` block names
// some origin OTHER than the RS, and that any pointer which does name the RS
// origin actually round-trips (GET < 400). This is the discovery round-trip
// gate: whatever the RS advertises to agents, an RS-origin URL it does not
// serve must never appear.
async function assertAgentDiscoveryHonest(
  agentDiscovery: JsonObject | null | undefined,
  { rsOrigin, label }: { rsOrigin: string; label: string }
): Promise<void> {
  if (!agentDiscovery) {
    return;
  }
  for (const key of RS_UNSERVED_DOCS_KEYS) {
    const url = agentDiscovery[key];
    if (typeof url !== "string") {
      continue;
    }
    // The RS does not serve these docs routes, so it must never advertise them
    // under its own origin — that is exactly the 404 seam agents hit.
    assert.notEqual(
      new URL(url).origin,
      rsOrigin,
      `${label}: pdpp_agent_discovery.${key} = ${url} names the RS origin, which does not serve it (would 404)`
    );
  }
  // The MCP endpoint IS an RS-origin route. If advertised under the RS origin,
  // prove it resolves rather than 404s (a bare GET to the streamable-HTTP MCP
  // endpoint must not be Not Found).
  const mcpEndpoint = agentDiscovery.mcp?.endpoint;
  if (typeof mcpEndpoint === "string" && new URL(mcpEndpoint).origin === rsOrigin) {
    const resp = await fetch(mcpEndpoint);
    assert.notEqual(resp.status, 404, `${label}: advertised RS-origin mcp.endpoint ${mcpEndpoint} returned 404`);
  }
}

test("RS never advertises RS-origin docs/skill URLs it does not serve (direct/ephemeral)", async () => {
  // Direct/ephemeral topology (no PDPP_REFERENCE_ORIGIN) — the case where the
  // `/mcp` metadata previously rebased docs/skill pointers onto the RS origin
  // (root-and-discovery.ts), so an agent following them hit a 404 at the RS.
  const previous = {
    AS_PUBLIC_URL: process.env.AS_PUBLIC_URL,
    PDPP_REFERENCE_MODE: process.env.PDPP_REFERENCE_MODE,
    PDPP_REFERENCE_ORIGIN: process.env.PDPP_REFERENCE_ORIGIN,
    RS_PUBLIC_URL: process.env.RS_PUBLIC_URL,
  };
  delete process.env.PDPP_REFERENCE_MODE;
  delete process.env.PDPP_REFERENCE_ORIGIN;
  delete process.env.AS_PUBLIC_URL;
  delete process.env.RS_PUBLIC_URL;

  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;
  const rsOrigin = new URL(rsUrl).origin;

  try {
    for (const metadataPath of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const metadata = await fetchJson(`${rsUrl}${metadataPath}`);
      assert.equal(metadata.status, 200, `${metadataPath} must return 200`);
      await assertAgentDiscoveryHonest(metadata.body.pdpp_agent_discovery, {
        label: metadataPath,
        rsOrigin,
      });
    }
  } finally {
    await closeServer(server);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("composed mode advertises docs/skill URLs on the docs origin, never the RS origin", async () => {
  // Composed topology: the configured browser origin (console/site) serves the
  // docs/skill routes. The RS must point agents at THAT origin — and must not
  // point them at itself — on both the plain and `/mcp` protected-resource
  // metadata documents.
  const previous = {
    AS_PUBLIC_URL: process.env.AS_PUBLIC_URL,
    PDPP_REFERENCE_MODE: process.env.PDPP_REFERENCE_MODE,
    PDPP_REFERENCE_ORIGIN: process.env.PDPP_REFERENCE_ORIGIN,
    RS_PUBLIC_URL: process.env.RS_PUBLIC_URL,
  };
  process.env.PDPP_REFERENCE_MODE = "composed";
  process.env.PDPP_REFERENCE_ORIGIN = "http://localhost:3200";
  delete process.env.AS_PUBLIC_URL;
  delete process.env.RS_PUBLIC_URL;

  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ignoreAmbientPublicUrls: false,
    quiet: true,
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;
  const rsOrigin = new URL(rsUrl).origin;
  const docsOrigin = "http://localhost:3200";

  try {
    for (const metadataPath of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const metadata = await fetchJson(`${rsUrl}${metadataPath}`);
      assert.equal(metadata.status, 200, `${metadataPath} must return 200`);
      const agentDiscovery = metadata.body.pdpp_agent_discovery;
      assert.ok(agentDiscovery, `${metadataPath} must advertise pdpp_agent_discovery in composed mode`);
      // Every docs/skill pointer must name the configured docs origin.
      for (const key of RS_UNSERVED_DOCS_KEYS) {
        assert.equal(
          new URL(agentDiscovery[key]).origin,
          docsOrigin,
          `${metadataPath}: ${key} must point at the docs origin, got ${agentDiscovery[key]}`
        );
      }
      // And none of them may name the RS origin (the 404 seam).
      await assertAgentDiscoveryHonest(agentDiscovery, { label: metadataPath, rsOrigin });
    }
  } finally {
    await closeServer(server);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

// ─── Trusted owner-agent onboarding advisory block ──────────────────────────
// openspec/changes/add-trusted-owner-agent-onboarding (tasks 2.1–2.4): the
// advisory `pdpp_owner_agent_onboarding` block is emitted on `GET /` and
// `GET /.well-known/oauth-protected-resource` ONLY when owner-agent onboarding
// is safely configured (a resolved composed-mode public/browser origin), uses
// the caller-visible trusted public origin for every URL, and is omitted (not
// pointed at an untrusted host) otherwise.

function assertOwnerAgentOnboardingBlock(block: JsonObject, { origin }: { origin: string }): void {
  assert.ok(block, "expected pdpp_owner_agent_onboarding block");
  assert.equal(block.advisory, true);
  assert.equal(block.profile, "trusted_owner_agent");
  assert.equal(typeof block.warning, "string");
  assert.ok(block.warning.length > 0, "warning must be non-empty");
  assert.equal(block.authorization_server, origin);
  assert.equal(block.resource, origin);
  assert.equal(block.owner_approval_url, origin);
  assert.equal(block.device_authorization_endpoint, `${origin}/oauth/device_authorization`);
  assert.equal(block.token_endpoint, `${origin}/oauth/token`);
  assert.equal(block.introspection_endpoint, `${origin}/introspect`);
  assert.equal(block.registration_endpoint, `${origin}/oauth/register`);
  assert.equal(block.revocation_path_template, `${origin}/oauth/register/{client_id}`);
  assert.equal(block.schema_endpoint, `${origin}/v1/schema`);
  assert.equal(block.schema_compact_endpoint, `${origin}/v1/schema?view=compact`);
  assert.equal(block.streams_endpoint, `${origin}/v1/streams`);
  assert.equal(block.query_base, `${origin}/v1`);
  assert.equal(block.event_subscriptions_endpoint, `${origin}/v1/event-subscriptions`);
  assert.equal(block.mcp_owner_bearer_rejected, true);
  assert.equal(block.pdpp_token_kind, "owner");
}

test("composed mode advertises the trusted owner-agent onboarding block on metadata and root", async () => {
  const publicOrigin = "http://localhost:3200";
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    referenceMode: "composed",
    referenceOrigin: publicOrigin,
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assertOwnerAgentOnboardingBlock(protectedResource.body.pdpp_owner_agent_onboarding, { origin: publicOrigin });

    const root = await fetchJson(`${rsUrl}/`);
    assert.equal(root.status, 200);
    assert.equal(root.body.object, "pdpp_discovery_index");
    assertOwnerAgentOnboardingBlock(root.body.pdpp_owner_agent_onboarding, { origin: publicOrigin });
  } finally {
    await closeServer(server);
  }
});

test("direct ephemeral servers omit owner-agent onboarding even when public-url env leaks in", async () => {
  const previous = {
    AS_ISSUER: process.env.AS_ISSUER,
    AS_PUBLIC_URL: process.env.AS_PUBLIC_URL,
    PDPP_REFERENCE_MODE: process.env.PDPP_REFERENCE_MODE,
    PDPP_REFERENCE_ORIGIN: process.env.PDPP_REFERENCE_ORIGIN,
    RS_PUBLIC_URL: process.env.RS_PUBLIC_URL,
  };
  // Leak hostile/public env exactly as a CI host might. The ephemeral
  // (asPort:0/rsPort:0, no explicit public urls) server resolves to DIRECT
  // mode and must NOT advertise owner-agent onboarding.
  process.env.AS_PUBLIC_URL = "https://wrong-as.example";
  process.env.AS_ISSUER = "https://wrong-issuer.example";
  process.env.RS_PUBLIC_URL = "https://wrong-rs.example";
  process.env.PDPP_REFERENCE_ORIGIN = "https://wrong-web.example";
  delete process.env.PDPP_REFERENCE_MODE;

  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(
      Object.hasOwn(protectedResource.body, "pdpp_owner_agent_onboarding"),
      false,
      "direct ephemeral RS must not advertise owner-agent onboarding"
    );

    const root = await fetchJson(`${rsUrl}/`);
    assert.equal(root.status, 200);
    assert.equal(
      Object.hasOwn(root.body, "pdpp_owner_agent_onboarding"),
      false,
      "direct ephemeral RS root must not advertise owner-agent onboarding"
    );
  } finally {
    await closeServer(server);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("owner-agent onboarding rebases to the forwarded public origin and never names an untrusted host", async () => {
  const trustedOrigin = "https://laptop-dev.example";
  const localOrigin = "http://localhost:3000";
  const server = await startServer({
    asPort: 0,
    asPublicUrl: localOrigin,
    dbPath: ":memory:",
    quiet: true,
    referenceMode: "composed",
    referenceOrigin: localOrigin,
    rsPort: 0,
    rsPublicUrl: localOrigin,
    trustedMetadataHosts: "laptop-dev.example",
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    // Trusted forwarded host: block is present and scoped to the trusted host.
    const trusted = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: { "x-forwarded-host": "laptop-dev.example", "x-forwarded-proto": "https" },
    });
    assert.equal(trusted.status, 200);
    assertOwnerAgentOnboardingBlock(trusted.body.pdpp_owner_agent_onboarding, { origin: trustedOrigin });

    const trustedRoot = await fetchJson(`${rsUrl}/`, {
      headers: { "x-forwarded-host": "laptop-dev.example", "x-forwarded-proto": "https" },
    });
    assert.equal(trustedRoot.status, 200);
    assertOwnerAgentOnboardingBlock(trustedRoot.body.pdpp_owner_agent_onboarding, { origin: trustedOrigin });

    // Hostile forwarded host: the metadata route rejects rather than emitting a
    // block that advertises the untrusted host.
    const hostile = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    });
    assert.equal(hostile.status, 421);
    assert.equal(hostile.body.error.code, "misdirected_request");

    const hostileRoot = await fetchJson(`${rsUrl}/`, {
      headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    });
    assert.equal(hostileRoot.status, 421);
    assert.equal(hostileRoot.body.error.code, "misdirected_request");
  } finally {
    await closeServer(server);
  }
});

test("proxied composed metadata rebases localhost defaults to the forwarded public origin", async () => {
  const publicOrigin = "https://laptop-dev.example";
  const localOrigin = "http://localhost:3000";
  const server = await startServer({
    asPort: 0,
    asPublicUrl: localOrigin,
    dbPath: ":memory:",
    quiet: true,
    referenceMode: "composed",
    referenceOrigin: localOrigin,
    rsPort: 0,
    rsPublicUrl: localOrigin,
    trustedMetadataHosts: "laptop-dev.example",
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const forwardedHeaders = {
    "x-forwarded-host": "laptop-dev.example",
    "x-forwarded-proto": "https",
  };

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: forwardedHeaders,
    });
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, publicOrigin);
    assert.deepEqual(protectedResource.body.authorization_servers, [publicOrigin]);
    assert.equal(protectedResource.body.pdpp_core_query_base, `${publicOrigin}/v1`);
    assert.equal(
      protectedResource.body.pdpp_agent_discovery.skill,
      `${publicOrigin}/.well-known/skills/pdpp-data-access/SKILL.md`
    );

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: forwardedHeaders,
    });
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, publicOrigin);
    assert.equal(authorizationServer.body.registration_endpoint, `${publicOrigin}/oauth/register`);
    assertCimdRegistrationModes(authorizationServer.body);
    assertPublicClientAdvertised(authorizationServer.body, "pdpp_cli", "PDPP CLI");
    assert.equal(authorizationServer.body.device_authorization_endpoint, `${publicOrigin}/oauth/device_authorization`);
    assertDeviceAuthorizationProfiles(authorizationServer.body);
  } finally {
    await closeServer(server);
  }
});

test("provider metadata pins explicit public origins despite hostile forwarded hosts", async () => {
  const asOrigin = "https://as.example.test";
  const rsOrigin = "https://rs.example.test";
  const server = await startServer({
    asPort: 0,
    asPublicUrl: asOrigin,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    rsPublicUrl: rsOrigin,
    trustedMetadataHosts: "",
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const hostileHeaders = {
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "https",
  };

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: hostileHeaders,
    });
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, asOrigin);
    assert.equal(authorizationServer.body.registration_endpoint, `${asOrigin}/oauth/register`);
    assertCimdRegistrationModes(authorizationServer.body);
    assertPublicClientAdvertised(authorizationServer.body, "pdpp_cli", "PDPP CLI");

    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: hostileHeaders,
    });
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, rsOrigin);
    assert.deepEqual(protectedResource.body.authorization_servers, [asOrigin]);
    assert.equal(protectedResource.body.pdpp_core_query_base, `${rsOrigin}/v1`);
  } finally {
    await closeServer(server);
  }
});

test("operator-created CIMD documents are served as stable client metadata documents", async () => {
  const publicOrigin = "https://pdpp.example.test";
  const server = await startServer({
    asPort: 0,
    asPublicUrl: publicOrigin,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const documentId = await createCimdDocument({
      clientName: "Claude Code",
      logoUri: null,
      redirectUris: ["http://localhost:1455/callback"],
    });

    const resp = await fetch(`${asUrl}/oauth/client-metadata/${encodeURIComponent(documentId)}`);
    assert.equal(resp.status, 200);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(resp.headers.get("content-type") || "", /application\/json/);
    assert.equal(resp.headers.get("cache-control"), "max-age=3600");
    const body = (await resp.json()) as JsonObject;
    assert.deepEqual(body, {
      client_id: `${publicOrigin}/oauth/client-metadata/${documentId}`,
      client_name: "Claude Code",
      grant_types: ["authorization_code"],
      redirect_uris: ["http://localhost:1455/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    assert.equal(
      Object.values(body).some((value) => value === null),
      false
    );

    const missing = await fetchJson(`${asUrl}/oauth/client-metadata/cimd_missing`);
    assert.equal(missing.status, 404);
  } finally {
    await closeServer(server);
  }
});

test("_ref CIMD document management creates, lists, rejects secrets, and deletes stable identities", async () => {
  const publicOrigin = "https://pdpp.example.test";
  const server = await startServer({
    asPort: 0,
    asPublicUrl: publicOrigin,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const create = await fetchJson(`${asUrl}/_ref/cimd-client-documents`, {
      body: JSON.stringify({
        client_name: "Codex",
        redirect_uris: ["http://localhost:1455/callback"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.object, "cimd_client_metadata_document");
    assert.equal(create.body.client_name, "Codex");
    assert.equal(create.body.client_id, `${publicOrigin}/oauth/client-metadata/${create.body.document_id}`);
    assert.deepEqual(create.body.redirect_uris, ["http://localhost:1455/callback"]);
    assert.equal(create.body.token_endpoint_auth_method, "none");

    const list = await fetchJson(`${asUrl}/_ref/cimd-client-documents`);
    assert.equal(list.status, 200);
    assert.equal(list.body.object, "list");
    assert.equal(list.body.has_more, false);
    assert.ok(list.body.data.some((doc: JsonObject) => doc.document_id === create.body.document_id));

    const publicDoc = await fetchJson(`${asUrl}/oauth/client-metadata/${encodeURIComponent(create.body.document_id)}`);
    assert.equal(publicDoc.status, 200);
    assert.equal(publicDoc.body.client_id, create.body.client_id);
    assert.equal(
      Object.values(publicDoc.body).some((value) => value === null),
      false
    );

    const secret = await fetchJson(`${asUrl}/_ref/cimd-client-documents`, {
      body: JSON.stringify({
        client_name: "Secret client",
        client_secret: "not-allowed",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(secret.status, 400);
    assert.equal(secret.body.error.code, "invalid_client_metadata");

    const deleted = await fetchJson(
      `${asUrl}/_ref/cimd-client-documents/${encodeURIComponent(create.body.document_id)}`,
      {
        method: "DELETE",
      }
    );
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.equal(deleted.body.client_id, create.body.client_id);

    const missing = await fetchJson(`${asUrl}/oauth/client-metadata/${encodeURIComponent(create.body.document_id)}`);
    assert.equal(missing.status, 404);
  } finally {
    await closeServer(server);
  }
});

test("operator-supplied DCR token remains advertised for public metadata", async () => {
  const publicHost = "laptop-dev.example";
  const publicOrigin = `https://${publicHost}`;
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
    trustedMetadataHosts: publicHost,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const publicHeaders = {
    "x-forwarded-host": publicHost,
    "x-forwarded-proto": "https",
  };

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: publicHeaders,
    });
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, publicOrigin);
    assert.equal(authorizationServer.body.registration_endpoint, `${publicOrigin}/oauth/register`);
    assertCimdRegistrationModes(authorizationServer.body);
    assertPublicClientAdvertised(authorizationServer.body, "pdpp_cli", "PDPP CLI");

    const registerPublic = await fetch(`${asUrl}/oauth/register`, {
      body: JSON.stringify({ client_name: "Public DCR Client", token_endpoint_auth_method: "none" }),
      headers: {
        ...publicHeaders,
        Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    assert.ok(
      registerPublic.status === 200 || registerPublic.status === 201,
      `unexpected status ${registerPublic.status}`
    );
  } finally {
    await closeServer(server);
  }
});

test("provider metadata permits unconfigured local and private-LAN host discovery", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    trustedMetadataHosts: "",
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const lanAsHost = `192.168.50.10:${server.asPort}`;
  const lanRsHost = `192.168.50.10:${server.rsPort}`;

  try {
    const authorizationServer = await httpRequestJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: { host: lanAsHost },
    });
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, `http://${lanAsHost}`);

    const protectedResource = await httpRequestJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: { host: lanRsHost },
    });
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, `http://${lanRsHost}`);
    assert.deepEqual(protectedResource.body.authorization_servers, [`http://192.168.50.10:${server.asPort}`]);
  } finally {
    await closeServer(server);
  }
});

test("provider metadata rejects unconfigured public Host and X-Forwarded-Host values", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    trustedMetadataHosts: "",
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const authorizationServer = await httpRequestJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: { host: "evil.example" },
    });
    assert.equal(authorizationServer.status, 421);
    assert.equal(authorizationServer.body.error.code, "misdirected_request");

    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: {
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(protectedResource.status, 421);
    assert.equal(protectedResource.body.error.code, "misdirected_request");
  } finally {
    await closeServer(server);
  }
});

test("PDPP_TRUSTED_HOSTS permits explicit public host-derived metadata allowlisting", async () => {
  const previousTrustedHosts = process.env.PDPP_TRUSTED_HOSTS;
  process.env.PDPP_TRUSTED_HOSTS = "pdpp.example.com, *.trusted.example";
  // biome-ignore lint/suspicious/noEvolvingTypes: localized test assertion preserves its explicit contract.
  // biome-ignore lint/suspicious/noImplicitAnyLet: localized test assertion preserves its explicit contract.
  let server;

  try {
    server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: {
        "x-forwarded-host": "tenant.trusted.example",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, "https://tenant.trusted.example");

    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: {
        "x-forwarded-host": "pdpp.example.com",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, "https://pdpp.example.com");
    assert.deepEqual(protectedResource.body.authorization_servers, ["https://pdpp.example.com"]);
  } finally {
    if (server) {
      await closeServer(server);
    }
    if (previousTrustedHosts === undefined) {
      delete process.env.PDPP_TRUSTED_HOSTS;
    } else {
      process.env.PDPP_TRUSTED_HOSTS = previousTrustedHosts;
    }
  }
});

test("public URL helpers rebase loopback defaults for direct LAN callers without losing sibling web links", () => {
  const req = {
    get(name: string): string | undefined {
      return name.toLowerCase() === "host" ? "192.0.2.10:7663" : undefined;
    },
    protocol: "http",
  };

  assert.equal(resolvePublicUrl(req, "http://localhost:3000"), "http://192.0.2.10:7663");
  assert.equal(resolveSiblingPublicUrl(req, "http://localhost:3000"), "http://192.0.2.10:3000");
});

test("provider metadata routes expose current honest capability set", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, rsUrl);
    assert.equal(protectedResource.body.resource_name, "PDPP Reference Provider Resource Server");
    assert.deepEqual(protectedResource.body.authorization_servers, [asUrl]);
    assert.deepEqual(protectedResource.body.bearer_methods_supported, ["header"]);
    assert.equal(protectedResource.body.pdpp_provider_connect_version, "draft-2026-04-16");
    assert.equal(protectedResource.body.pdpp_self_export_supported, true);
    assert.deepEqual(protectedResource.body.pdpp_token_kinds_supported, ["owner", "client"]);
    assert.equal(protectedResource.body.pdpp_core_query_base, `${rsUrl}/v1`);

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, asUrl);
    assert.equal(authorizationServer.body.introspection_endpoint, `${asUrl}/introspect`);
    assert.equal(authorizationServer.body.pushed_authorization_request_endpoint, `${asUrl}/oauth/par`);
    assert.equal(authorizationServer.body.registration_endpoint, `${asUrl}/oauth/register`);
    assert.equal(authorizationServer.body.authorization_endpoint, `${asUrl}/oauth/authorize`);
    assert.deepEqual(authorizationServer.body.response_types_supported, ["code"]);
    assert.deepEqual(authorizationServer.body.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(authorizationServer.body.pdpp_provider_connect_capabilities, [
      "owner_self_export",
      "cli_device_connect",
      "third_party_client_connect",
    ]);
    assertCimdRegistrationModes(authorizationServer.body);
    assertPublicClientAdvertised(authorizationServer.body, "pdpp_cli", "PDPP CLI");
    assert.deepEqual(authorizationServer.body.pdpp_authorization_details_types_supported, [
      "https://pdpp.dev/data-access",
    ]);
    assert.equal(authorizationServer.body.token_endpoint, `${asUrl}/oauth/token`);
    assert.deepEqual(authorizationServer.body.token_endpoint_auth_methods_supported, ["none"]);
    assert.equal(authorizationServer.body.device_authorization_endpoint, `${asUrl}/oauth/device_authorization`);
    assertDeviceAuthorizationProfiles(authorizationServer.body);
    assert.equal(authorizationServer.body.agent_connect_endpoint, `${asUrl}/agent-connect`);
    assert.deepEqual(authorizationServer.body.grant_types_supported, [
      "urn:ietf:params:oauth:grant-type:device_code",
      "authorization_code",
      "refresh_token",
    ]);
  } finally {
    await closeServer(server);
  }
});

test("reference revision header is distinct reference metadata across AS, RS, and _ref surfaces", async () => {
  const referenceRevision = "pdpp-reference@test-revision";
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    referenceRevision,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const { resp: asMetadata } = await fetchJsonResponse(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(asMetadata.status, 200);
    expectReferenceRevisionHeader(asMetadata, referenceRevision);
    assert.equal(asMetadata.headers.get("PDPP-Version"), null);

    const { resp: rsMetadata } = await fetchJsonResponse(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(rsMetadata.status, 200);
    expectReferenceRevisionHeader(rsMetadata, referenceRevision);
    assert.equal(rsMetadata.headers.get("PDPP-Version"), "2026-04-06");

    const refSurface = await fetch(`${asUrl}/_ref/connectors?limit=1`);
    assert.equal(refSurface.status, 200);
    expectReferenceRevisionHeader(refSurface, referenceRevision);
    assert.equal(refSurface.headers.get("PDPP-Version"), null);

    const hostedAsset = await fetch(`${asUrl}/__pdpp/hosted-ui.css`);
    assert.equal(hostedAsset.status, 200);
    expectReferenceRevisionHeader(hostedAsset, referenceRevision);
    assert.equal(hostedAsset.headers.get("PDPP-Version"), null);
  } finally {
    await closeServer(server);
  }
});

test("explicit browser-facing public urls drive metadata, device verification, and PAR links", async () => {
  const publicOrigin = "http://localhost:3000";
  const server = await startServer({
    asPort: 0,
    asPublicUrl: publicOrigin,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    rsPublicUrl: publicOrigin,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, publicOrigin);
    assert.deepEqual(protectedResource.body.authorization_servers, [publicOrigin]);
    assert.equal(protectedResource.body.pdpp_core_query_base, `${publicOrigin}/v1`);

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, publicOrigin);
    assert.equal(authorizationServer.body.device_authorization_endpoint, `${publicOrigin}/oauth/device_authorization`);
    assertDeviceAuthorizationProfiles(authorizationServer.body);
    assert.equal(authorizationServer.body.pushed_authorization_request_endpoint, `${publicOrigin}/oauth/par`);

    const device = await fetch(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: "pdpp-web-dashboard" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(device.status, 200);
    const deviceBody = (await device.json()) as JsonObject;
    assert.equal(deviceBody.verification_uri, `${publicOrigin}/device`);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(deviceBody.verification_uri_complete, /^http:\/\/localhost:3000\/device\?user_code=/);

    const spotifyManifest = JSON.parse(await readFile(new URL("../manifests/spotify.json", import.meta.url), "utf8"));
    const registerConnector = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerConnector.status, 201);

    const par = await fetch(`${asUrl}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "single_use",
            purpose_code: "https://pdpp.dev/purpose/recommendation",
            purpose_description: "Review top artists",
            retention: "P30D",
            source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
            streams: [{ name: "top_artists" }],
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_display: { name: "Longview" },
        client_id: "cli_longview",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(par.status, 201);
    const parBody = (await par.json()) as JsonObject;
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(parBody.authorization_url, /^http:\/\/localhost:3000\/consent\?request_uri=/);
  } finally {
    await closeServer(server);
  }
});

test("provider metadata advertises public registration when initial access tokens are explicitly empty", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [],
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.registration_endpoint, `${asUrl}/oauth/register`);
    assertCimdRegistrationModes(authorizationServer.body);
    assertPublicClientAdvertised(authorizationServer.body, "pdpp_cli", "PDPP CLI");
  } finally {
    await closeServer(server);
  }
});

test("pre-registered public metadata publishes configured client identifiers", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [],
    preRegisteredPublicClients: [
      {
        client_id: "agent_demo",
        metadata: {
          client_name: "Agent Demo",
          token_endpoint_auth_method: "none",
        },
      },
    ],
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.registration_endpoint, `${asUrl}/oauth/register`);
    assertCimdRegistrationModes(authorizationServer.body);
    assert.deepEqual(authorizationServer.body.pdpp_pre_registered_public_clients, [
      {
        client_id: "agent_demo",
        client_name: "Agent Demo",
        token_endpoint_auth_method: "none",
      },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("default local reference startup advertises public self-registration", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.registration_endpoint, `${asUrl}/oauth/register`);
    assertCimdRegistrationModes(authorizationServer.body);
    assertPublicClientAdvertised(authorizationServer.body, "pdpp_cli", "PDPP CLI");

    // No bearer token is required for public-client identity registration; a
    // bogus token must still be rejected rather than silently downgraded.
    const registerOk = await fetch(`${asUrl}/oauth/register`, {
      body: JSON.stringify({ client_name: "Default Public Client", token_endpoint_auth_method: "none" }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    assert.ok(registerOk.status === 200 || registerOk.status === 201, `unexpected status ${registerOk.status}`);
    const registered = (await registerOk.json()) as JsonObject;
    assert.equal(typeof registered.client_id, "string");

    const registerNope = await fetch(`${asUrl}/oauth/register`, {
      body: JSON.stringify({ client_name: "Bogus", token_endpoint_auth_method: "none" }),
      headers: {
        Authorization: "Bearer nope",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    assert.ok(
      registerNope.status === 400 || registerNope.status === 401,
      `expected 4xx rejection, got ${registerNope.status}`
    );
  } finally {
    await closeServer(server);
  }
});

test("public forwarded host advertises self-registration and rejects bogus bearer tokens", async () => {
  const publicHost = "pdpp.example.com";
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    trustedMetadataHosts: publicHost,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const publicHeaders = {
    "X-Forwarded-Host": publicHost,
    "X-Forwarded-Proto": "https",
  };

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: publicHeaders,
    });
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.registration_endpoint, `https://${publicHost}/oauth/register`);
    assertCimdRegistrationModes(authorizationServer.body);

    const registerPublic = await fetch(`${asUrl}/oauth/register`, {
      body: JSON.stringify({ client_name: "Public Default Client", token_endpoint_auth_method: "none" }),
      headers: {
        ...publicHeaders,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    assert.ok(
      registerPublic.status === 200 || registerPublic.status === 201,
      `unexpected status ${registerPublic.status}`
    );
    const registered = (await registerPublic.json()) as JsonObject;
    assert.equal(typeof registered.client_id, "string");

    const registerNope = await fetch(`${asUrl}/oauth/register`, {
      body: JSON.stringify({ client_name: "Bogus Public Client", token_endpoint_auth_method: "none" }),
      headers: {
        ...publicHeaders,
        Authorization: "Bearer nope",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    assert.equal(registerNope.status, 401);
    const body = (await registerNope.json()) as JsonObject;
    assert.equal(body.error, "invalid_client");
  } finally {
    await closeServer(server);
  }
});

test("public self-registration is rate limited without blocking authenticated bootstrap tokens", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    publicDynamicClientRegistrationRateLimit: { max: 1, windowMs: 60_000 },
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const firstPublic = await fetch(`${asUrl}/oauth/register`, {
      body: JSON.stringify({ client_name: "First Public Client", token_endpoint_auth_method: "none" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(firstPublic.status, 201);

    const secondPublic = await fetch(`${asUrl}/oauth/register`, {
      body: JSON.stringify({ client_name: "Second Public Client", token_endpoint_auth_method: "none" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(secondPublic.status, 429);
    assert.equal(secondPublic.headers.has("Retry-After"), true);
    const rateLimited = (await secondPublic.json()) as JsonObject;
    assert.equal(rateLimited.error, "slow_down");

    const bootstrap = await fetch(`${asUrl}/oauth/register`, {
      body: JSON.stringify({ client_name: "Bootstrap Client", token_endpoint_auth_method: "none" }),
      headers: {
        Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    assert.equal(bootstrap.status, 201);
  } finally {
    await closeServer(server);
  }
});

test("explicit PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION=0 env still disables registration", async () => {
  // Simulate: operator sets the off switch and no explicit opts override it.
  const previous = process.env.PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION;
  process.env.PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION = "0";
  // The server/index.ts module reads the env once at import time, so we can't
  // retroactively flip the module constant. Instead we pass the explicit opts
  // equivalent that `PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION=0` would have set
  // on a fresh process. This matches how the reference docs describe the env.
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    enableDynamicClientRegistration: false,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal("registration_endpoint" in authorizationServer.body, false);
    assertCimdRegistrationModes(authorizationServer.body, ["pre_registered_public"]);
  } finally {
    await closeServer(server);
    if (previous === undefined) {
      delete process.env.PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION;
    } else {
      process.env.PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION = previous;
    }
  }
});

test("default local reference startup seeds pdpp-web-dashboard so dashboard bootstrap device_authorization works", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const deviceRes = await fetch(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: "pdpp-web-dashboard" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(deviceRes.status, 200);
    const payload = (await deviceRes.json()) as JsonObject;
    assert.equal(typeof payload.device_code, "string");
    assert.equal(typeof payload.user_code, "string");
  } finally {
    await closeServer(server);
  }
});

test("provider metadata omits registration endpoint when dynamic registration is disabled", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    enableDynamicClientRegistration: false,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal("registration_endpoint" in authorizationServer.body, false);
    assertCimdRegistrationModes(authorizationServer.body, ["pre_registered_public"]);
  } finally {
    await closeServer(server);
  }
});

test("native provider metadata surfaces the native provider name", async () => {
  const nativeManifest = {
    name: "Northstar HR",
    provider_id: "northstar_hr",
    storage_binding: { connector_id: "northstar_hr_native" },
    streams: [],
  };
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    nativeManifest,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource_name, "Northstar HR Resource Server");
    assert.deepEqual(protectedResource.body.authorization_servers, [asUrl]);

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, asUrl);
  } finally {
    await closeServer(server);
  }
});

test("native startup rejects manifests missing provider_id", async () => {
  await assert.rejects(
    startServer({
      asPort: 0,
      dbPath: ":memory:",
      nativeManifest: {
        name: "Northstar HR",
        storage_binding: { connector_id: "northstar_hr_native" },
        streams: [],
      },
      quiet: true,
      rsPort: 0,
    }),
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /Native manifest must include provider_id/
  );
});

test("native startup rejects manifests missing storage_binding.connector_id", async () => {
  await assert.rejects(
    startServer({
      asPort: 0,
      dbPath: ":memory:",
      nativeManifest: {
        name: "Northstar HR",
        provider_id: "northstar_hr",
        streams: [],
      },
      quiet: true,
      rsPort: 0,
    }),
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /Native manifest must include storage_binding\.connector_id/
  );
});

test("native startup rejects manifests that include connector_id", async () => {
  await assert.rejects(
    startServer({
      asPort: 0,
      dbPath: ":memory:",
      nativeManifest: {
        connector_id: "https://registry.pdpp.dev/connectors/not-actually-native",
        name: "Northstar HR",
        provider_id: "northstar_hr",
        storage_binding: { connector_id: "northstar_hr_native" },
        streams: [],
      },
      quiet: true,
      rsPort: 0,
    }),
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /Native manifest must not include connector_id/
  );
});

test("native startup rejects manifests whose storage_binding includes unsupported fields", async () => {
  await assert.rejects(
    startServer({
      asPort: 0,
      dbPath: ":memory:",
      nativeManifest: {
        name: "Northstar HR",
        provider_id: "northstar_hr",
        storage_binding: {
          connector_id: "northstar_hr_native",
          debug_context: "should_not_be_accepted",
        },
        streams: [],
      },
      quiet: true,
      rsPort: 0,
    }),
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /Native manifest storage_binding must include only connector_id/
  );
});

test("AS root exposes an unauthenticated discovery index pointing at the well-known endpoint", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    referenceRevision: "pdpp-reference@test+sentinel",
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const { resp, body } = await fetchJsonResponse(`${asUrl}/`);
    assert.equal(resp.status, 200);
    assert.equal(body.object, "pdpp_discovery_index");
    assert.equal(body.role, "authorization_server");
    assert.equal(body.links.well_known_authorization_server, "/.well-known/oauth-authorization-server");
    assert.equal(body.reference_revision, "pdpp-reference@test+sentinel");
    expectReferenceRevisionHeader(resp, "pdpp-reference@test+sentinel");
    assert.equal(body.links.well_known, undefined);
    assert.equal(body.links.schema, undefined);
  } finally {
    await closeServer(server);
  }
});

test("RS root exposes an unauthenticated discovery index pointing at well-known, schema, and the core query base", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    referenceRevision: "pdpp-reference@test+sentinel",
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const { resp, body } = await fetchJsonResponse(`${rsUrl}/`);
    assert.equal(resp.status, 200);
    assert.equal(body.object, "pdpp_discovery_index");
    assert.equal(body.role, "resource_server");
    assert.equal(body.links.well_known, "/.well-known/oauth-protected-resource");
    assert.equal(body.links.schema, "/v1/schema");
    assert.equal(body.links.core_query_base, "/v1");
    // The connector listing is a primary cold-start landing surface — owner
    // tokens need a connector_id for polyfill reads, and exposing the link
    // here closes the discovery loop without forcing a well-known round-trip.
    assert.equal(body.links.connectors, "/v1/connectors");
    assert.equal(body.reference_revision, "pdpp-reference@test+sentinel");
    expectReferenceRevisionHeader(resp, "pdpp-reference@test+sentinel");
  } finally {
    await closeServer(server);
  }
});

test("discovery index does not require authentication", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    // Calling with a deliberately bogus token should still succeed since the
    // route is unauthenticated and routes registered before the requireToken
    // middleware. The body shape must still be a discovery index.
    const { resp, body } = await fetchJsonResponse(`${rsUrl}/`, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    assert.equal(resp.status, 200);
    assert.equal(body.object, "pdpp_discovery_index");
  } finally {
    await closeServer(server);
  }
});

test("RS 401 responses advertise protected-resource metadata in header and body", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;
  const metadataUrl = `${rsUrl}/.well-known/oauth-protected-resource`;
  const expectedChallenge = `Bearer resource_metadata="${metadataUrl}"`;

  try {
    const missingResp = await fetch(`${rsUrl}/v1/schema`);
    const missingBody = (await missingResp.json()) as JsonObject;
    assert.equal(missingResp.status, 401);
    assert.equal(missingResp.headers.get("www-authenticate"), expectedChallenge);
    assert.equal(missingBody.error.code, "authentication_error");
    assert.equal(missingBody.error.resource_metadata, metadataUrl);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(missingBody.error.next_step, /pdpp_agent_discovery\.cli/);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.doesNotMatch(missingBody.error.next_step, /npx -y @pdpp\/cli connect/);

    const invalidResp = await fetch(`${rsUrl}/v1/schema`, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    const invalidBody = (await invalidResp.json()) as JsonObject;
    assert.equal(invalidResp.status, 401);
    assert.equal(invalidResp.headers.get("www-authenticate"), expectedChallenge);
    assert.equal(invalidBody.error.resource_metadata, metadataUrl);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(invalidBody.error.next_step, /pdpp_agent_discovery\.cli/);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.doesNotMatch(invalidBody.error.next_step, /npx -y @pdpp\/cli connect/);
  } finally {
    await closeServer(server);
  }
});

test("RS 401 metadata challenge uses configured public resource origin", async () => {
  const publicResource = "https://resource.example";
  const server = await startServer({
    asIssuer: "https://as.example",
    asPort: 0,
    asPublicUrl: "https://as.example",
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    rsPublicUrl: publicResource,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;
  const metadataUrl = `${publicResource}/.well-known/oauth-protected-resource`;

  try {
    const resp = await fetch(`${rsUrl}/v1/schema`);
    const body = (await resp.json()) as JsonObject;
    assert.equal(resp.status, 401);
    assert.equal(resp.headers.get("www-authenticate"), `Bearer resource_metadata="${metadataUrl}"`);
    assert.equal(body.error.resource_metadata, metadataUrl);
  } finally {
    await closeServer(server);
  }
});

test("RS 401 metadata challenge omits untrusted public host-derived origin", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    trustedMetadataHosts: "",
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const resp = await httpRequestJson(`${rsUrl}/v1/schema`, {
      headers: { host: "attacker.example" },
    });
    assert.equal(resp.status, 401);
    assert.equal(resp.headers["www-authenticate"], undefined);
    assert.equal(resp.body.error.code, "authentication_error");
    assert.equal(resp.body.error.resource_metadata, undefined);
    assert.equal(resp.body.error.next_step, undefined);
  } finally {
    await closeServer(server);
  }
});

test("protected-resource metadata names canonical first-call shapes via pdpp_discovery_hints", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    const hints = protectedResource.body.pdpp_discovery_hints;
    assert.ok(hints, "pdpp_discovery_hints should be present");
    assert.equal(hints.schema_endpoint, "/v1/schema");
    assert.equal(hints.query_base, "/v1");
    assert.equal(hints.aggregate.endpoint_template, "/v1/streams/{stream}/aggregate");
    assert.equal(hints.changes_since_bootstrap, "beginning");
    assert.equal(hints.blob_indirection, "data.blob_ref.fetch_url");
    // Connector and stream metadata locations a cold caller would otherwise
    // have to guess. /v1/connectors is the canonical connector listing;
    // /v1/streams/{stream} returns per-stream metadata and schema.
    assert.equal(hints.connectors_endpoint, "/v1/connectors");
    assert.equal(hints.streams_endpoint_template, "/v1/streams/{stream}");
    // Default reference startup is polyfill-mode (no native manifest), so
    // owner-token reads must use source.kind = "connector". The hint surfaces that
    // requirement without making the caller hit a route and parse a 400.
    assert.equal(hints.owner_polyfill_requires_source_kind_connector, true);

    // Lexical retrieval is advertised by default; the search hints should
    // mirror the canonical streams[] scope and the v1 single-stream filter
    // constraint.
    assert.ok(hints.search, "search hints should be present when lexical retrieval is advertised");
    assert.equal(hints.search.endpoint, "/v1/search");
    assert.equal(hints.search.scope_param, "streams[]");
    assert.equal(hints.search.filter_requires_single_stream, true);
  } finally {
    await closeServer(server);
  }
});

test("pdpp_discovery_hints omits owner_polyfill_requires_source_kind_connector when a native manifest is configured", async () => {
  // Native single-source mode resolves the connector implicitly from the
  // manifest, so the polyfill source-kind requirement does not apply. The
  // hint should be absent rather than emitted as `false`, matching the
  // truthful-omission convention used elsewhere in this block (see
  // hybrid_pagination_supported).
  const nativeManifest = {
    name: "Northstar HR",
    provider_id: "northstar_hr",
    storage_binding: { connector_id: "northstar_hr_native" },
    streams: [],
  };
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    nativeManifest,
    quiet: true,
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const { body } = await fetchJsonResponse(`${rsUrl}/.well-known/oauth-protected-resource`);
    const hints = body.pdpp_discovery_hints;
    assert.ok(hints);
    assert.equal(hints.connectors_endpoint, "/v1/connectors");
    assert.equal(hints.streams_endpoint_template, "/v1/streams/{stream}");
    assert.equal(
      Object.hasOwn(hints, "owner_polyfill_requires_source_kind_connector"),
      false,
      "owner_polyfill_requires_source_kind_connector should be omitted in native single-source mode"
    );
  } finally {
    await closeServer(server);
  }
});

test("pdpp_discovery_hints omits hybrid pagination when hybrid is not advertised", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    // Disable semantic so hybrid is not advertised. Lexical stays on.
    semanticRetrievalSupported: false,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const { body } = await fetchJsonResponse(`${rsUrl}/.well-known/oauth-protected-resource`);
    const hints = body.pdpp_discovery_hints;
    assert.ok(hints);
    assert.equal(
      Object.hasOwn(hints, "hybrid_pagination_supported"),
      false,
      "hybrid_pagination_supported should be omitted when hybrid retrieval is not advertised"
    );
    // Lexical search hints remain present.
    assert.ok(hints.search);
  } finally {
    await closeServer(server);
  }
});

test("pdpp_discovery_hints omits search when lexical retrieval is suppressed", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    lexicalRetrievalSupported: false,
    quiet: true,
    rsPort: 0,
    semanticRetrievalSupported: false,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const { body } = await fetchJsonResponse(`${rsUrl}/.well-known/oauth-protected-resource`);
    const hints = body.pdpp_discovery_hints;
    assert.ok(hints);
    assert.equal(
      Object.hasOwn(hints, "search"),
      false,
      "search hints should be omitted when lexical retrieval is suppressed"
    );
    // Static hints unrelated to retrieval extensions are still present.
    assert.equal(hints.schema_endpoint, "/v1/schema");
    assert.equal(hints.changes_since_bootstrap, "beginning");
  } finally {
    await closeServer(server);
  }
});

test("HEAD on /v1 RS endpoints mirrors GET status (RFC 7231 §4.3.2)", async () => {
  // Without auto HEAD shadows, an unauthenticated `HEAD /v1/streams` returned
  // 404 while `GET /v1/streams` returned 401. Per RFC 7231 §4.3.2 HEAD must
  // behave like GET minus the message body — the status code (and crucially
  // the auth-gate behavior) must agree.
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const probes = ["/v1/streams", "/v1/schema", "/v1/search", "/v1/search/hybrid"];
    for (const path of probes) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const getResp = await fetch(`${rsUrl}${path}`);
      const headResp = await fetch(`${rsUrl}${path}`, { method: "HEAD" });
      assert.equal(
        headResp.status,
        getResp.status,
        `HEAD ${path} status ${headResp.status} must match GET status ${getResp.status}`
      );
      // HEAD body must be empty per RFC 7231.
      const headBody = await headResp.text();
      assert.equal(headBody, "", `HEAD ${path} body must be empty`);
    }
  } finally {
    await closeServer(server);
  }
});

test("HEAD on RS metadata endpoints mirrors GET status", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    for (const url of [
      `${rsUrl}/.well-known/oauth-protected-resource`,
      `${asUrl}/.well-known/oauth-authorization-server`,
      `${rsUrl}/`,
      `${asUrl}/`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const getResp = await fetch(url);
      const headResp = await fetch(url, { method: "HEAD" });
      assert.equal(headResp.status, getResp.status, `HEAD ${url} status mismatch`);
      assert.equal(await headResp.text(), "", `HEAD ${url} body must be empty`);
    }
  } finally {
    await closeServer(server);
  }
});

test("PDPP_REFERENCE_REVISION env override flows into the discovery index and response header", async () => {
  const previous = process.env.PDPP_REFERENCE_REVISION;
  process.env.PDPP_REFERENCE_REVISION = "pdpp-reference@1.2.3+abc123";
  // biome-ignore lint/suspicious/noImplicitAnyLet: localized test assertion preserves its explicit contract.
  // biome-ignore lint/suspicious/noEvolvingTypes: localized test assertion preserves its explicit contract.
  let server;
  try {
    server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      quiet: true,
      rsPort: 0,
    });
    const rsUrl = `http://localhost:${server.rsPort}`;
    const { resp, body } = await fetchJsonResponse(`${rsUrl}/`);
    assert.equal(resp.status, 200);
    assert.equal(body.reference_revision, "pdpp-reference@1.2.3+abc123");
    expectReferenceRevisionHeader(resp, "pdpp-reference@1.2.3+abc123");
  } finally {
    if (server) {
      await closeServer(server);
    }
    if (previous === undefined) {
      delete process.env.PDPP_REFERENCE_REVISION;
    } else {
      process.env.PDPP_REFERENCE_REVISION = previous;
    }
  }
});
