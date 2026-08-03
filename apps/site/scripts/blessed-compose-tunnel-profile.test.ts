// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ChatGPT and Claude.ai fetch the MCP URL from their own infrastructure, so a
 * loopback-only node can never serve them. The blessed stack's answer is an
 * opt-in `cloudflared` profile: outbound-only, no host port, gated behind
 * `--profile tunnel` so a plain `docker compose up -d` stays exactly as
 * private as before this profile existed.
 *
 * These assertions read the compose file directly rather than shelling out to
 * `docker compose config`, so they run anywhere.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BLESSED_COMPOSE = new URL("../../../deploy/docker/docker-compose.yml", import.meta.url);
const DOCKER_README = new URL("../../../deploy/docker/README.md", import.meta.url);
const MCP_SERVER = new URL("../../../packages/mcp-server/src/server.ts", import.meta.url);
const TUNNEL_SERVICE_RE = /^ {2}cloudflared:$/m;
const TUNNEL_PROFILE_RE = /profiles: \["tunnel"\]/;
const TOKEN_REQUIRED_RE = /CLOUDFLARE_TUNNEL_TOKEN:\?/;
const TOKEN_DEFAULT_EMPTY_RE = /TUNNEL_TOKEN: \$\{CLOUDFLARE_TUNNEL_TOKEN:-\}/;
const HOST_PORT_RE = /^\s+ports:/m;
const TOP_LEVEL_SERVICE_RE = /^ {2}\S/m;
const QUICK_TUNNEL_FLAG_RE = /tunnel\s+--url/;

// Cloudflare's own docs state a domain on Cloudflare is REQUIRED to publish a
// named tunnel's public hostname (developers.cloudflare.com/tunnel/setup:
// "A domain on Cloudflare (required to publish applications)"). No PDPP
// surface may claim otherwise — that claim shipped once and was false.
const FALSE_NO_DOMAIN_CLAIM_RES = [
  /Cloudflare can issue (?:you |a )?(?:a )?subdomain/i,
  /no domain purchase is (?:still )?not required/i,
  /named tunnel needs (?:a free Cloudflare account )?(?:but )?no domain/i,
];
const DOMAIN_REQUIRED_CLAIM_RE = /domain on Cloudflare[\s\S]*?required to publish/i;
const ENABLE_JSON_RESPONSE_RE = /enableJsonResponse:\s*true/;

function compose(): Promise<string> {
  return readFile(fileURLToPath(BLESSED_COMPOSE), "utf8");
}

function readmeText(): Promise<string> {
  return readFile(fileURLToPath(DOCKER_README), "utf8");
}

function serviceBody(src: string, header: string): string {
  const lines = src.split("\n");
  const start = lines.indexOf(header);
  assert.ok(start >= 0, `${header} must be declared`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => TOP_LEVEL_SERVICE_RE.test(line) && line.trimEnd().endsWith(":") && !line.startsWith("    ")
  );
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

test("the tunnel service is an opt-in profile on the same canonical stack", async () => {
  const src = await compose();
  assert.match(src, TUNNEL_SERVICE_RE, "the blessed stack must define the cloudflared service itself");
  assert.match(src, TUNNEL_PROFILE_RE, "cloudflared must be profile-gated so the default stack stays untouched");
});

test("the tunnel service runs a named tunnel, not a Quick Tunnel", async () => {
  const src = await compose();
  const body = serviceBody(src, "  cloudflared:");
  assert.doesNotMatch(
    body,
    QUICK_TUNNEL_FLAG_RE,
    "the blessed stack must run a named tunnel (`tunnel run`), not a Quick Tunnel (`tunnel --url`), which Cloudflare documents as testing-only with no SSE support"
  );
});

// Regression guard: compose interpolates every service's environment even
// when its profile is inactive (this is the exact trap PDPP_NEKO_IMAGE's `:?`
// avoids below). A required (`:?`) CLOUDFLARE_TUNNEL_TOKEN would break
// `docker compose up -d` for every owner who never enables `--profile
// tunnel`, which was true here until caught by actually running `docker
// compose config` with no profile active.
test("the tunnel token does not use a required (:?) guard, so it cannot break the default stack", async () => {
  const src = await compose();
  const body = serviceBody(src, "  cloudflared:");
  assert.doesNotMatch(
    body,
    TOKEN_REQUIRED_RE,
    "CLOUDFLARE_TUNNEL_TOKEN must not use :? — compose interpolates this service's environment even when the tunnel profile is inactive, so a required variable would break the default network-only stack"
  );
  assert.match(
    body,
    TOKEN_DEFAULT_EMPTY_RE,
    "CLOUDFLARE_TUNNEL_TOKEN must default to empty (:-) so an inactive tunnel profile never blocks the default stack"
  );
});

test("the tunnel service publishes no host port", async () => {
  const src = await compose();
  const body = serviceBody(src, "  cloudflared:");
  assert.doesNotMatch(
    body,
    HOST_PORT_RE,
    "cloudflared must not publish a host port — it is an outbound-only client to Cloudflare's edge"
  );
});

test("enabling the tunnel profile does not change the published web port", async () => {
  const src = await compose();
  const webPortLines = src.split("\n").filter((line) => /^\s*-\s*"\$\{PDPP_WEB_PORT/.test(line));
  assert.equal(webPortLines.length, 1, "exactly one published port mapping (web) must exist in the blessed stack");
});

// Regression guard: this claim shipped once (compose comment and README) and
// was false — Cloudflare's own docs require a domain on Cloudflare to publish
// a named tunnel's hostname. No PDPP surface may resurrect it.
test("no PDPP surface claims a named Cloudflare tunnel needs no domain", async () => {
  const [composeSrc, readme] = await Promise.all([compose(), readmeText()]);
  for (const [label, src] of [
    ["docker-compose.yml", composeSrc],
    ["deploy/docker/README.md", readme],
  ] as const) {
    for (const claimRe of FALSE_NO_DOMAIN_CLAIM_RES) {
      assert.doesNotMatch(
        src,
        claimRe,
        `${label} must not claim a named Cloudflare tunnel needs no domain — Cloudflare's own docs require one`
      );
    }
  }
});

test("the Docker README states the domain requirement for a named tunnel, sourced from Cloudflare's own docs", async () => {
  const readme = await readmeText();
  assert.match(
    readme,
    DOMAIN_REQUIRED_CLAIM_RE,
    "the README must state Cloudflare's own documented prerequisite: a domain on Cloudflare is required to publish a named tunnel's hostname"
  );
  assert.match(readme, /developers\.cloudflare\.com\/tunnel\/setup/, "the domain-requirement claim must cite its primary source");
});

test("the Docker README documents a genuinely no-domain stable alternative", async () => {
  const readme = await readmeText();
  assert.match(readme, /ngrok/i, "the README must offer a no-domain stable path (ngrok's free static domain) alongside the domain-owning Cloudflare path");
  assert.match(readme, /ngrok-free\.app/, "the ngrok path must document the actual free static-domain shape");
});

// The whole reason Quick Tunnel is offered at all (rather than rejected
// outright for lacking SSE) is that PDPP's /mcp transport was verified NOT to
// need SSE for initialize/tools/list/tools/call. That verification rests on
// this one static server config; if it regresses to streaming mode, the
// Quick Tunnel recommendation silently becomes false, so pin the config.
test("PDPP's MCP transport stays in JSON-response mode, which is why Quick Tunnel's SSE gap does not block it", async () => {
  const server = await readFile(fileURLToPath(MCP_SERVER), "utf8");
  assert.match(
    server,
    ENABLE_JSON_RESPONSE_RE,
    "packages/mcp-server/src/server.ts must keep enableJsonResponse: true — the Quick Tunnel recommendation in deploy/docker/README.md depends on /mcp never requiring an SSE response for normal tool calls"
  );
});
