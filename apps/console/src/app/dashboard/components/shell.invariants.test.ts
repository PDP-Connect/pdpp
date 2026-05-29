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

test("shell renders DeploymentSubnav when active is deployment (live mode only)", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  // Both conditions must be present in the source. We check them independently
  // to avoid needing the /s (dotAll) flag, which tsc flags for ES2017 targets.
  assert.match(src, /active === "deployment" && mode === "live"/);
  assert.match(src, /DeploymentSubnav/);
});

test("DeploymentSubnav links to the deployment overview", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, /routes\.section\.deployment\b/);
});

test("DeploymentSubnav links to the owner-tokens page via routes.section.deploymentTokens", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, /routes\.section\.deploymentTokens/);
});

test("DeploymentSubnav label is 'Owner tokens', not a generic term", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, /Owner tokens/);
});

test("routes.ts exposes a deploymentTokens section pointing to /deployment/tokens", async () => {
  const routesFile = `${HERE}views/routes.ts`;
  const src = await readFile(routesFile, "utf8");
  assert.match(src, /deploymentTokens\b/);
  assert.match(src, /deployment\/tokens/);
});
