// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guard for the dashboard shell's deployment subnav.
 *
 * The DeploymentSubnav is the persistent discoverability path for owner-token
 * management. Without it, the tokens page is reachable only via the action
 * button on /deployment — a link a fresh operator may miss entirely.
 *
 * Invariants:
 * - The subnav renders when active === "deployment" (live mode only).
 * - It links to both the deployment overview and the owner-tokens page.
 * - It is NOT rendered in mock-owner mode (sandbox), where owner tokens
 *   do not exist.
 * - The label uses "Owner tokens", not a generic term, to keep the operator/
 *   trusted-agent framing consistent with the tokens page itself.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHELL_FILE = `${HERE}shell.tsx`;
// routes.ts moved to the shared @pdpp/operator-ui package; resolve it from the
// repo root rather than the now-deleted console-local components/views path.
const REPO_ROOT = new URL("../../../../../../", import.meta.url);
const PACKAGE_ROUTES_FILE = fileURLToPath(new URL("packages/operator-ui/src/components/views/routes.ts", REPO_ROOT));
const DEPLOYMENT_LIVE_MODE_RE = /active === "deployment" && mode === "live"/;
const DEPLOYMENT_SUBNAV_RE = /DeploymentSubnav/;
const DEPLOYMENT_ROUTE_RE = /routes\.section\.deployment\b/;
const CONNECT_ROUTE_RE = /routes\.section\.connect\b/;
const DEPLOYMENT_TOKENS_ROUTE_RE = /routes\.section\.deploymentTokens/;
const OWNER_TOKENS_LABEL_RE = /Owner tokens/;
const DEPLOYMENT_TOKENS_SYMBOL_RE = /deploymentTokens\b/;
const DEPLOYMENT_TOKENS_PATH_RE = /deployment\/tokens/;
const CONNECT_SYMBOL_RE = /connect\b/;
const CONNECT_PATH_RE = /\/connect/;
const MOBILE_DRAWER_PROVIDER_IMPORT_RE =
  /import \{[\s\S]*MobileDrawerProvider[\s\S]*\} from "@pdpp\/operator-ui\/components\/mobile-drawer"/;
const MOBILE_DRAWER_PROVIDER_WRAP_RE =
  /<MobileDrawerProvider>[\s\S]*<MobileDrawer>[\s\S]*<\/MobileDrawer>[\s\S]*<\/MobileDrawerProvider>/;
// Sandbox mode banner — must be rendered when mode is mock-owner, never in live mode.
const SANDBOX_MODE_BANNER_COMPONENT_RE = /function SandboxModeBanner/;
const SANDBOX_MODE_BANNER_RENDER_RE = /mode === "mock-owner" \? <SandboxModeBanner/;
const SANDBOX_MODE_BANNER_TESTID_RE = /data-testid="sandbox-mode-banner"/;
const SANDBOX_MODE_BANNER_ROLE_RE = /role="note"/;

test("shell renders DeploymentSubnav when active is deployment (live mode only)", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  // Both conditions must be present in the source. We check them independently
  // to avoid needing the /s (dotAll) flag, which tsc flags for ES2017 targets.
  assert.match(src, DEPLOYMENT_LIVE_MODE_RE);
  assert.match(src, DEPLOYMENT_SUBNAV_RE);
});

test("DeploymentSubnav links to the deployment overview", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, DEPLOYMENT_ROUTE_RE);
});

test("DeploymentSubnav links to the connect setup page", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, CONNECT_ROUTE_RE);
});

test("DeploymentSubnav links to the owner-tokens page via routes.section.deploymentTokens", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, DEPLOYMENT_TOKENS_ROUTE_RE);
});

test("DeploymentSubnav label is 'Owner tokens', not a generic term", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, OWNER_TOKENS_LABEL_RE);
});

test("routes.ts exposes a deploymentTokens section pointing to /deployment/tokens", async () => {
  const src = await readFile(PACKAGE_ROUTES_FILE, "utf8");
  assert.match(src, DEPLOYMENT_TOKENS_SYMBOL_RE);
  assert.match(src, DEPLOYMENT_TOKENS_PATH_RE);
});

test("routes.ts exposes a connect section pointing to /connect", async () => {
  const src = await readFile(PACKAGE_ROUTES_FILE, "utf8");
  assert.match(src, CONNECT_SYMBOL_RE);
  assert.match(src, CONNECT_PATH_RE);
});

test("shell wraps the topbar trigger and drawer in the same MobileDrawerProvider", async () => {
  // Moved here from the package mobile-drawer test: `shell.tsx` is forked per
  // app and stays app-local, so the shell↔provider wrap is an app invariant.
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, MOBILE_DRAWER_PROVIDER_IMPORT_RE);
  assert.match(src, MOBILE_DRAWER_PROVIDER_WRAP_RE);
});

test("shell has a SandboxModeBanner component rendered in mock-owner mode", async () => {
  // The banner must exist as a named component (findable without rendering)
  // and be rendered conditionally on mode === "mock-owner" so it is present
  // on every sandbox page and absent on every live-owner page.
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, SANDBOX_MODE_BANNER_COMPONENT_RE, "SandboxModeBanner component must be defined in shell.tsx");
  assert.match(src, SANDBOX_MODE_BANNER_RENDER_RE, "SandboxModeBanner must be rendered when mode is mock-owner");
});

test("SandboxModeBanner has a testid and ARIA role for accessibility and test pinning", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, SANDBOX_MODE_BANNER_TESTID_RE, "SandboxModeBanner must carry data-testid=sandbox-mode-banner");
  assert.match(src, SANDBOX_MODE_BANNER_ROLE_RE, "SandboxModeBanner must carry role=note");
});
