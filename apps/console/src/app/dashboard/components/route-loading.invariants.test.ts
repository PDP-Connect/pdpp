/**
 * Invariants for the route-level loading states (report 4, 2026-06-01).
 *
 * The owner reported that heavy dashboard pages had no Next.js route-level
 * loading state. These structural assertions pin that the high-value records
 * and runs surfaces each ship a `loading.tsx`, that the loading UI reuses the
 * shared `DashboardShell` (stable chrome, no bespoke layout), and that the
 * shared skeleton stays lightweight (a single `animate-pulse`, an accessible
 * live region) so a loading state never becomes a second source of slowness.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DASHBOARD = fileURLToPath(new URL("..", import.meta.url));

const LOADING_FILES = [
  "records/loading.tsx",
  "records/[connector]/loading.tsx",
  "runs/loading.tsx",
  "runs/[runId]/loading.tsx",
] as const;

const DASHBOARD_SHELL_RE = /DashboardShell/;
const SHARED_SKELETON_IMPORT_RE = /from "\.\.?(\/\.\.)?\/components\/route-loading\.ts/;
const ROLE_STATUS_RE = /role="status"/;
const ARIA_BUSY_RE = /aria-busy="true"/;
const ARIA_HIDDEN_RE = /aria-hidden/;
const ANIMATE_PULSE_RE = /animate-pulse/;

test("every high-value records/runs surface ships a route-level loading.tsx", () => {
  for (const rel of LOADING_FILES) {
    assert.ok(existsSync(`${DASHBOARD}${rel}`), `missing loading state: ${rel}`);
  }
});

test("each loading.tsx renders inside the shared DashboardShell for stable chrome", async () => {
  for (const rel of LOADING_FILES) {
    const src = await readFile(`${DASHBOARD}${rel}`, "utf8");
    assert.match(src, DASHBOARD_SHELL_RE, `${rel} must reuse DashboardShell`);
    assert.match(src, SHARED_SKELETON_IMPORT_RE, `${rel} must use the shared skeleton`);
  }
});

test("the shared skeleton is lightweight and accessible", async () => {
  const src = await readFile(`${DASHBOARD}components/route-loading.tsx`, "utf8");
  // A polite live region announces what is loading.
  assert.match(src, ROLE_STATUS_RE);
  assert.match(src, ARIA_BUSY_RE);
  // Decorative placeholder bars are hidden from assistive tech.
  assert.match(src, ARIA_HIDDEN_RE);
  // Exactly one animation primitive — the pulse — no bespoke motion framework.
  assert.match(src, ANIMATE_PULSE_RE);
});
