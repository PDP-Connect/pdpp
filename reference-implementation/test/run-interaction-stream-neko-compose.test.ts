const TOP_LEVEL_REGEX_1 = /NEKO_USERNAME:\s*\$\{NEKO_USERNAME:-user\}/;
const TOP_LEVEL_REGEX_2 = /network_mode:\s*["']?service:reference/;
const TOP_LEVEL_REGEX_3 = /PDPP_NEKO_BASE_URL:\s*\$\{PDPP_NEKO_BASE_URL-http:\/\/neko:8080\/neko\}/;
const TOP_LEVEL_REGEX_4 = /PDPP_NEKO_PROXY_ALLOWED_HOSTS:\s*\$\{PDPP_NEKO_PROXY_ALLOWED_HOSTS:-neko:8080\}/;
const TOP_LEVEL_REGEX_5 =
  /PDPP_STREAM_PLAYGROUND_NEKO_CDP_HTTP_URL:\s*\$\{PDPP_STREAM_PLAYGROUND_NEKO_CDP_HTTP_URL:-http:\/\/neko:9223\}/;
const TOP_LEVEL_REGEX_6 = /PDPP_NEKO_CDP_HTTP_URL:\s*\$\{PDPP_NEKO_CDP_HTTP_URL-http:\/\/neko:9223\}/;
const TOP_LEVEL_REGEX_7 =
  /PDPP_NEKO_WINDOW_SETTLE_URL:\s*\$\{PDPP_NEKO_WINDOW_SETTLE_URL:-http:\/\/neko:9223\/pdpp\/window-settle\}/;
const TOP_LEVEL_REGEX_8 = /NEKO_CONTROL_USERNAME:\s*\$\{NEKO_CONTROL_USERNAME:-admin\}/;
const TOP_LEVEL_REGEX_9 = /NEKO_CONTROL_PASSWORD:\s*\$\{NEKO_CONTROL_PASSWORD:-\}/;
const TOP_LEVEL_REGEX_10 = /NEKO_MEMBER_PROVIDER:\s*\$\{NEKO_MEMBER_PROVIDER:-multiuser\}/;
const TOP_LEVEL_REGEX_11 = /NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD:\s*\$\{NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD:-\}/;
const TOP_LEVEL_REGEX_12 = /NEKO_MEMBER_MULTIUSER_USER_PASSWORD:\s*\$\{NEKO_MEMBER_MULTIUSER_USER_PASSWORD:-\}/;
const TOP_LEVEL_REGEX_13 = /NEKO_PASSWORD:\s*\$\{NEKO_PASSWORD:-neko\}/;
const TOP_LEVEL_REGEX_14 = /PDPP_NEKO_SURFACE_CAP:\s*\$\{PDPP_NEKO_SURFACE_CAP:-1\}/;
const TOP_LEVEL_REGEX_15 = /PDPP_CHATGPT_REMOTE_CDP_URL:/;
const TOP_LEVEL_REGEX_16 = /web:[\s\S]*depends_on:[\s\S]*neko:[\s\S]*condition:\s*service_healthy/;
const TOP_LEVEL_REGEX_17 = /neko:[\s\S]*ports:[\s\S]*"\$\{NEKO_WEBRTC_PORT:-59000\}:59000\/tcp"/;
const TOP_LEVEL_REGEX_18 = /xwininfo -root -display/;
const TOP_LEVEL_REGEX_19 = /PDPP_NEKO_BASE_URL=http:\/\/neko:8080\/neko/;
const TOP_LEVEL_REGEX_20 = /PDPP_NEKO_PROXY_ALLOWED_HOSTS=neko:8080/;
const TOP_LEVEL_REGEX_21 = /PDPP_STREAM_PLAYGROUND_NEKO_CDP_HTTP_URL=http:\/\/neko:9223/;
const TOP_LEVEL_REGEX_22 = /PDPP_NEKO_CDP_HTTP_URL=http:\/\/neko:9223/;
const TOP_LEVEL_REGEX_23 = /PDPP_NEKO_WINDOW_SETTLE_URL=http:\/\/neko:9223\/pdpp\/window-settle/;
const TOP_LEVEL_REGEX_24 = /NEKO_CONTROL_USERNAME=admin/;
const TOP_LEVEL_REGEX_25 = /NEKO_CONTROL_PASSWORD=\n/;
const TOP_LEVEL_REGEX_26 = /NEKO_USERNAME=user/;
const TOP_LEVEL_REGEX_27 = /NEKO_PASSWORD=neko/;
const TOP_LEVEL_REGEX_28 = /NEKO_MEMBER_PROVIDER=multiuser/;
const TOP_LEVEL_REGEX_29 = /NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=\n/;
const TOP_LEVEL_REGEX_30 = /NEKO_MEMBER_MULTIUSER_USER_PASSWORD=\n/;
const TOP_LEVEL_REGEX_31 = /PDPP_NEKO_SURFACE_MODE=dynamic/;
const TOP_LEVEL_REGEX_32 = /PDPP_NEKO_SURFACE_CAP=3/;
const TOP_LEVEL_REGEX_33 = /PDPP_NEKO_STATIC_PROFILE_KEY=\n/;
const TOP_LEVEL_REGEX_34 = /neko:\s*[\s\S]*image: \$\{NEKO_IMAGE:-pdpp-neko:local\}/;
const TOP_LEVEL_REGEX_35 = /neko-allocator:\s*[\s\S]*NEKO_IMAGE: \$\{NEKO_IMAGE:-pdpp-neko:local\}/;
const TOP_LEVEL_REGEX_36 = /COPY docker\/neko\/xorg\.conf \/etc\/neko\/xorg\.conf/;
const TOP_LEVEL_REGEX_37 = /SCREEN="\$\{NEKO_DESKTOP_SCREEN:-1440x900@30\}"/;
const TOP_LEVEL_REGEX_38 = /WIDTH="\$\{SCREEN_WIDTH\}"/;
const TOP_LEVEL_REGEX_39 = /HEIGHT="\$\{SCREEN_HEIGHT\}"/;
const TOP_LEVEL_REGEX_40 = /xdotool windowsize --sync/;
const TOP_LEVEL_REGEX_41 = /neko:[\s\S]*ports:[\s\S]*"\$\{NEKO_WEBRTC_PORT:-59000\}:59000\/udp"/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NekoSurfaceAllocatorClient } from "../runtime/neko-surface-allocator.ts";
import { resolveNekoBrowserSurfaceControllerOptions } from "../server/index.ts";
import type { BrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";

/**
 * `resolveNekoBrowserSurfaceControllerOptions` only ever calls `listSurfaces`,
 * `listNonTerminalLeases`, and `repairStaleSurfaceActiveLeases` on the lease
 * store during option resolution (verified against server/index.js), and it
 * never calls the allocator's own methods here — it just plumbs the factory's
 * result through opaquely. Every other member below is a real, honestly-typed
 * stub that throws if ever actually invoked, so the fakes fully (not
 * partially) satisfy the real interfaces without a type-system escape hatch.
 */
function unimplemented(name: string): never {
  throw new Error(`test fake: ${name} is not implemented — this path should be unreachable in this test`);
}

function fakeLeaseStore(): BrowserSurfaceLeaseStore {
  return {
    clearSurfaceActiveLease: () => unimplemented("clearSurfaceActiveLease"),
    getLease: () => unimplemented("getLease"),
    getSurface: () => unimplemented("getSurface"),
    listLeases: () => unimplemented("listLeases"),
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async listNonTerminalLeases() {
      return [];
    },
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async listSurfaces() {
      return [];
    },
    readForConnectionIdentities: () => unimplemented("readForConnectionIdentities"),
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
    async repairStaleSurfaceActiveLeases() {},
    updateBrowserGenerationHash: () => unimplemented("updateBrowserGenerationHash"),
    updateLeaseTerminal: () => unimplemented("updateLeaseTerminal"),
    upsertLease: () => unimplemented("upsertLease"),
    upsertSurface: () => unimplemented("upsertSurface"),
    withLeaseTransaction: () => unimplemented("withLeaseTransaction"),
  };
}

/**
 * `NekoSurfaceAllocatorClient` carries a private field, so no object literal
 * can structurally satisfy it (TS requires real class identity). Subclassing
 * gets a real instance while overriding the one method this path touches.
 */
class FakeNekoSurfaceAllocatorClient extends NekoSurfaceAllocatorClient {
  constructor() {
    super({ baseUrl: "http://allocator.test/api" });
  }
  override ensureSurface(): ReturnType<NekoSurfaceAllocatorClient["ensureSurface"]> {
    return unimplemented("ensureSurface");
  }
}

function fakeAllocator(): NekoSurfaceAllocatorClient {
  return new FakeNekoSurfaceAllocatorClient();
}

interface ResolvedNekoBrowserSurfaceOptions {
  browserSurfaceLeaseManager?: {
    isManagedConnector: (connectorId: string) => boolean;
  };
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COMPOSE_FILE = `${REPO_ROOT}docker-compose.yml`;
const OVERLAY_FILE = `${REPO_ROOT}docker-compose.neko.yml`;
const ENV_EXAMPLE_FILE = `${REPO_ROOT}.env.docker.example`;
const NEKO_DOCKERFILE = `${REPO_ROOT}docker/neko/Dockerfile`;
const NEKO_CHROMIUM_START = `${REPO_ROOT}docker/neko/start-chromium.sh`;
const CHATGPT_CONNECTOR_ID = "https://registry.pdpp.dev/connectors/chatgpt";
const CHASE_CONNECTOR_ID = "https://registry.pdpp.dev/connectors/chase";
const USAA_CONNECTOR_ID = "https://registry.pdpp.dev/connectors/usaa";
const AMAZON_CONNECTOR_ID = "https://registry.pdpp.dev/connectors/amazon";
const REDDIT_CONNECTOR_ID = "https://registry.pdpp.dev/connectors/reddit";
const MANAGED_CONNECTOR_IDS = [
  CHATGPT_CONNECTOR_ID,
  CHASE_CONNECTOR_ID,
  USAA_CONNECTOR_ID,
  AMAZON_CONNECTOR_ID,
  REDDIT_CONNECTOR_ID,
];

test("n.eko compose overlay uses service DNS instead of reference network namespace", async () => {
  const [overlay, envExample] = await Promise.all([readFile(OVERLAY_FILE, "utf8"), readFile(ENV_EXAMPLE_FILE, "utf8")]);

  assert.doesNotMatch(overlay, TOP_LEVEL_REGEX_2);
  assert.match(overlay, TOP_LEVEL_REGEX_3);
  assert.match(overlay, TOP_LEVEL_REGEX_4);
  assert.match(overlay, TOP_LEVEL_REGEX_5);
  assert.match(overlay, TOP_LEVEL_REGEX_6);
  assert.match(overlay, TOP_LEVEL_REGEX_7);
  assert.match(overlay, TOP_LEVEL_REGEX_8);
  assert.match(overlay, TOP_LEVEL_REGEX_9);
  assert.match(overlay, TOP_LEVEL_REGEX_10);
  assert.match(overlay, TOP_LEVEL_REGEX_11);
  assert.match(overlay, TOP_LEVEL_REGEX_12);
  assert.match(overlay, TOP_LEVEL_REGEX_1);
  assert.match(overlay, TOP_LEVEL_REGEX_13);
  assert.match(
    overlay,
    new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS:\\s*\\$\\{PDPP_NEKO_MANAGED_CONNECTORS:-${CHATGPT_CONNECTOR_ID}\\}`)
  );
  assert.match(overlay, TOP_LEVEL_REGEX_14);
  assert.match(
    overlay,
    new RegExp(`PDPP_NEKO_STATIC_PROFILE_KEY:\\s*\\$\\{PDPP_NEKO_STATIC_PROFILE_KEY-${CHATGPT_CONNECTOR_ID}\\}`)
  );
  assert.doesNotMatch(overlay, TOP_LEVEL_REGEX_15);
  assert.match(overlay, TOP_LEVEL_REGEX_16);
  assert.match(overlay, TOP_LEVEL_REGEX_17);
  assert.match(overlay, TOP_LEVEL_REGEX_41);

  assert.match(envExample, TOP_LEVEL_REGEX_19);
  assert.match(envExample, TOP_LEVEL_REGEX_20);
  assert.match(envExample, TOP_LEVEL_REGEX_21);
  assert.match(envExample, TOP_LEVEL_REGEX_22);
  assert.match(envExample, TOP_LEVEL_REGEX_23);
  assert.match(envExample, TOP_LEVEL_REGEX_24);
  assert.match(envExample, TOP_LEVEL_REGEX_25);
  assert.match(envExample, TOP_LEVEL_REGEX_26);
  assert.match(envExample, TOP_LEVEL_REGEX_27);
  assert.match(envExample, TOP_LEVEL_REGEX_28);
  assert.match(envExample, TOP_LEVEL_REGEX_29);
  assert.match(envExample, TOP_LEVEL_REGEX_30);
  assert.match(envExample, new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS=${MANAGED_CONNECTOR_IDS.join(",")}`));
  assert.match(envExample, TOP_LEVEL_REGEX_31);
  assert.match(envExample, TOP_LEVEL_REGEX_32);
  assert.match(envExample, TOP_LEVEL_REGEX_33);
});

test("static and dynamic n.eko paths expose DPR-1 portrait and landscape phone modes", async () => {
  const [overlay, dockerfile, xorg] = await Promise.all([
    readFile(OVERLAY_FILE, "utf8"),
    readFile(NEKO_DOCKERFILE, "utf8"),
    readFile(`${REPO_ROOT}docker/neko/xorg.conf`, "utf8"),
  ]);

  assert.match(overlay, TOP_LEVEL_REGEX_34);
  assert.match(overlay, TOP_LEVEL_REGEX_35);
  assert.match(dockerfile, TOP_LEVEL_REGEX_36);
  for (const mode of ["412x915_30.00", "915x412_30.00"]) {
    assert.match(xorg, new RegExp(`Modeline "${mode.replace(".", "\\.")}"`));
    assert.match(xorg, new RegExp(`Modes[\\s\\S]*"${mode.replace(".", "\\.")}"`));
  }
});

test("Chromium defaults its launch size to the active n.eko screen", async () => {
  const startScript = await readFile(NEKO_CHROMIUM_START, "utf8");

  assert.match(startScript, TOP_LEVEL_REGEX_37);
  assert.match(startScript, TOP_LEVEL_REGEX_38);
  assert.match(startScript, TOP_LEVEL_REGEX_39);
  assert.match(startScript, TOP_LEVEL_REGEX_40);
  assert.match(startScript, TOP_LEVEL_REGEX_18);
});

test("ChatGPT large-history guardrails are wired into Docker runtime config", async () => {
  const [compose, envExample] = await Promise.all([readFile(COMPOSE_FILE, "utf8"), readFile(ENV_EXAMPLE_FILE, "utf8")]);

  for (const key of [
    "PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN",
    "PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS",
    "PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER",
  ]) {
    assert.ok(compose.includes(`${key}: ${"${"}${key}:-}`));
    assert.match(envExample, new RegExp(`^${key}=`, "m"));
  }
});

test("USAA remains an owner-present managed n.eko connector in the committed runtime config, not background-safe", async () => {
  const usaaManifest = JSON.parse(
    await readFile(`${REPO_ROOT}packages/polyfill-connectors/manifests/usaa.json`, "utf8")
  );
  const envExample = await readFile(ENV_EXAMPLE_FILE, "utf8");

  assert.equal(usaaManifest.connector_id, USAA_CONNECTOR_ID);
  assert.equal(usaaManifest.runtime_requirements.bindings.browser.required, true);
  assert.deepEqual(usaaManifest.capabilities.human_interaction, ["manual_action"]);
  assert.equal(usaaManifest.capabilities.refresh_policy.recommended_mode, "manual");
  assert.equal(usaaManifest.capabilities.refresh_policy.background_safe, false);
  assert.match(envExample, new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS=.*${USAA_CONNECTOR_ID}`));
});

test("Amazon remains manual-default and owner-present managed on n.eko, with owner opt-in background scheduling declared", async () => {
  const amazonManifest = JSON.parse(
    await readFile(`${REPO_ROOT}packages/polyfill-connectors/manifests/amazon.json`, "utf8")
  );
  const envExample = await readFile(ENV_EXAMPLE_FILE, "utf8");

  assert.equal(amazonManifest.connector_id, AMAZON_CONNECTOR_ID);
  assert.equal(amazonManifest.runtime_requirements.bindings.browser.required, true);
  assert.deepEqual(amazonManifest.capabilities.human_interaction, ["manual_action", "otp"]);
  assert.equal(amazonManifest.capabilities.refresh_policy.recommended_mode, "manual");
  // background_safe:true only permits an explicit owner-created schedule; it
  // does not auto-enroll (recommended_mode stays "manual"), so Amazon stays
  // an owner-present managed n.eko connector by default.
  assert.equal(amazonManifest.capabilities.refresh_policy.background_safe, true);
  assert.equal(amazonManifest.capabilities.refresh_policy.assisted_after_owner_auth, true);
  assert.match(envExample, new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS=.*${AMAZON_CONNECTOR_ID}`));
});

test("Reddit remains manual-default and owner-present managed on n.eko, with owner opt-in background scheduling declared", async () => {
  const redditManifest = JSON.parse(
    await readFile(`${REPO_ROOT}packages/polyfill-connectors/manifests/reddit.json`, "utf8")
  );
  const envExample = await readFile(ENV_EXAMPLE_FILE, "utf8");

  assert.equal(redditManifest.connector_id, REDDIT_CONNECTOR_ID);
  assert.equal(redditManifest.runtime_requirements.bindings.browser.required, true);
  // Reddit's own auto-login code documents the same class of friction as
  // Amazon (2FA/OTP on first login, Cloudflare challenge fallback to
  // manual_action) — human_interaction now declares that honestly instead
  // of under-stating it as bare "credentials".
  assert.deepEqual(redditManifest.capabilities.human_interaction, ["manual_action", "otp"]);
  assert.equal(redditManifest.capabilities.refresh_policy.recommended_mode, "manual");
  assert.equal(redditManifest.capabilities.refresh_policy.background_safe, true);
  assert.equal(redditManifest.capabilities.refresh_policy.assisted_after_owner_auth, true);
  assert.match(envExample, new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS=.*${REDDIT_CONNECTOR_ID}`));
});

// The tests above assert that USAA is present in the env-template string. That
// proves config but not routing: the controller does not grep the env file, it
// gates managed-surface acquisition on
// `browserSurfaceLeaseManager.isManagedConnector(connectorId)`
// (reference-implementation/runtime/controller.ts). A refactor of the
// connector-id alias/canonical-key resolution could leave USAA in the env
// template yet stop the parser from recognising it, silently dropping USAA back
// to the plain Docker path and `headed_browser_unavailable`. This test runs the
// real runtime config off the committed managed-connector list and asserts the
// parser still routes USAA — by both its canonical registry URL and its short
// connector key.
test("runtime config routes USAA to a managed n.eko surface from the committed connector list", async () => {
  const envExample = await readFile(ENV_EXAMPLE_FILE, "utf8");
  const managedLine = envExample.split("\n").find((line) => line.startsWith("PDPP_NEKO_MANAGED_CONNECTORS="));
  assert.ok(managedLine, "PDPP_NEKO_MANAGED_CONNECTORS must be defined in .env.docker.example");
  const managedConnectors = managedLine.slice("PDPP_NEKO_MANAGED_CONNECTORS=".length);
  assert.ok(
    managedConnectors.split(",").includes(USAA_CONNECTOR_ID),
    "committed managed-connector list must include the USAA connector id"
  );

  const options = (await resolveNekoBrowserSurfaceControllerOptions({
    createBrowserSurfaceAllocator: fakeAllocator,
    env: {
      PDPP_NEKO_ALLOCATOR_URL: "http://allocator.test/api",
      PDPP_NEKO_MANAGED_CONNECTORS: managedConnectors,
      PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
      PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
      PDPP_NEKO_SURFACE_CAP: "3",
      PDPP_NEKO_SURFACE_MODE: "dynamic",
    },
    getBrowserSurfaceLeaseStore: fakeLeaseStore,
  })) as ResolvedNekoBrowserSurfaceOptions;

  assert.ok(options.browserSurfaceLeaseManager);
  // The controller calls isManagedConnector with whatever connector id the run
  // carries. Both the canonical registry URL and the short key must resolve so
  // USAA acquires a managed surface instead of failing headed_browser_unavailable.
  assert.equal(options.browserSurfaceLeaseManager.isManagedConnector(USAA_CONNECTOR_ID), true);
  assert.equal(options.browserSurfaceLeaseManager.isManagedConnector("usaa"), true);
});
