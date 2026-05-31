/**
 * Source-regex guard for the dashboard shell's deployment subnav.
 *
 * The DeploymentSubnav is the persistent discoverability path for owner-token
 * management. Without it, the tokens page is reachable only via the action
 * button on /dashboard/deployment — a link a fresh operator may miss entirely.
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
const DEPLOYMENT_LIVE_MODE_RE = /active === "deployment" && mode === "live"/;
const DEPLOYMENT_SUBNAV_RE = /DeploymentSubnav/;
const DEPLOYMENT_ROUTE_RE = /routes\.section\.deployment\b/;
const DEPLOYMENT_TOKENS_ROUTE_RE = /routes\.section\.deploymentTokens/;
const OWNER_TOKENS_LABEL_RE = /Owner tokens/;
const DEPLOYMENT_TOKENS_SYMBOL_RE = /deploymentTokens\b/;
const DEPLOYMENT_TOKENS_PATH_RE = /deployment\/tokens/;

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

test("DeploymentSubnav links to the owner-tokens page via routes.section.deploymentTokens", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, DEPLOYMENT_TOKENS_ROUTE_RE);
});

test("DeploymentSubnav label is 'Owner tokens', not a generic term", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, OWNER_TOKENS_LABEL_RE);
});

test("routes.ts exposes a deploymentTokens section pointing to /deployment/tokens", async () => {
  const routesFile = `${HERE}views/routes.ts`;
  const src = await readFile(routesFile, "utf8");
  assert.match(src, DEPLOYMENT_TOKENS_SYMBOL_RE);
  assert.match(src, DEPLOYMENT_TOKENS_PATH_RE);
});
