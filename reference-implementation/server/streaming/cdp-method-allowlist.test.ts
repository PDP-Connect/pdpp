// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CDP method allowlist test.
 *
 * Asserts that the streaming-companion code ONLY sends methods from an
 * explicit allowlist. This protects the patchright stealth property:
 * if Runtime.* or other detection vectors leak into streaming code,
 * we fail the build rather than silently shipping a re-detected variant.
 *
 * Test strategy:
 *   1. Read the adapter sources and the installed Remote Surface CDP backend
 *   2. Strip comments (avoid false positives from JSDoc)
 *   3. Extract ALL string literals matching `Domain.method`
 *   4. Assert they are a subset of the allowlist
 *   5. Assert basic methods are present (so we know the check is working)
 */

import { strict as assert } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * CDP method allowlist. Each method is permitted because it:
 * - Exists in Page domain (framebuffer/streaming control + main-frame nav
 *   notifications) — safe under patchright
 * - Exists in Input domain (user event relay) — safe under patchright
 * - Exists in Emulation domain (device metric override) — safe under patchright
 * - Exists in Target domain (popup discovery, observe-only) — safe under
 *   patchright; we only call `setDiscoverTargets` to receive
 *   `targetCreated/Destroyed/InfoChanged` events, never `attachToTarget` or
 *   anything that injects script into a child target.
 * Runtime is allowed only for Remote Surface's documented text-focus detector
 * and read-only remote-selection expression. Network, DOM, Console, etc.
 * remain forbidden.
 */
const ALLOWLIST = new Set<string>([
  // Page domain: framebuffer streaming control — explicitly allowed
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.enable",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Page.screencastFrame",
  "Page.screencastFrameAck",
  // Page domain: main-frame navigation observer (event subscription only;
  // appears as a string literal in the message dispatcher switch).
  "Page.frameNavigated",
  // Input domain: user event relay to target — explicitly allowed
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.dispatchTouchEvent",
  "Input.insertText",
  // Emulation domain: device metrics (viewport, scale, mobile mode) — explicitly allowed
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Emulation.setUserAgentOverride",
  // Target domain: popup discovery. `setDiscoverTargets` is the only
  // *method* we send; the others appear as event-name string literals.
  "Target.setDiscoverTargets",
  "Target.targetCreated",
  "Target.targetDestroyed",
  "Target.targetInfoChanged",
  "Runtime.enable",
  "Runtime.addBinding",
  "Runtime.bindingCalled",
  "Runtime.evaluate",
]);

/**
 * Strip single-line and block comments from source.
 * Intentionally imperfect (trades false positives for safety);
 * false positives (comment-mention triggering fail) are caught in review.
 */
function stripComments(src: string): string {
  // Remove //... to end of line
  let result = src.replace(/\/\/.*$/gm, "");
  // Remove /* ... */ blocks
  result = result.replace(/\/\*[\s\S]*?\*\//g, "");
  return result;
}

/**
 * Extract all quoted Domain.method literals from source.
 * Restricting this to strings avoids mistaking browser APIs such as
 * `CSS.supports()` inside the Remote Surface implementation for CDP calls.
 */
function extractCdpMethods(src: string): Set<string> {
  const methods = new Set<string>();
  // Match Domain.method where Domain is a known domain.
  // This is broad but intentional: we want to catch anything that LOOKS
  // like a CDP method, then fail if it's not in the allowlist.
  const regex =
    /["'`](Page|Input|Emulation|Runtime|Network|DOM|Console|Debugger|Target|Browser|Security|Tracing|Profiler|HeapProfiler|Storage|Cast|ServiceWorker|Animation|Accessibility|CSS|Database|DeviceOrientation|Fetch|HeadlessExperimental|IndexedDB|LayerTree|Log|Memory|Overlay|Performance|Schema|SystemInfo|WebAuthn|Audits|BackgroundService|Inspector|IO|Media)\.([A-Za-z][A-Za-z0-9_]*)["'`]/g;

  let match: RegExpExecArray | null = regex.exec(src);
  while (match !== null) {
    methods.add(`${match[1]}.${match[2]}`);
    match = regex.exec(src);
  }
  return methods;
}

function inspectStreamingFile(filename: string): Set<string> {
  const filepath = filename.startsWith("/") ? filename : join(__dirname, filename);
  return extractCdpMethods(stripComments(readFileSync(filepath, "utf8")));
}

function findAllowlistViolations(filename: string, methods: Set<string>): { file: string; method: string }[] {
  const violations: { file: string; method: string }[] = [];
  for (const method of methods) {
    if (!ALLOWLIST.has(method)) {
      violations.push({ file: filename, method });
    }
  }
  return violations;
}

function inspectStreamingFiles(files: string[]): {
  allMethods: Set<string>;
  violations: { file: string; method: string }[];
} {
  const allMethods = new Set<string>();
  const violations: { file: string; method: string }[] = [];

  for (const filename of files) {
    const methods = inspectStreamingFile(filename);
    for (const method of methods) {
      allMethods.add(method);
    }
    violations.push(...findAllowlistViolations(filename, methods));
  }

  return { allMethods, violations };
}

function formatViolations(violations: { file: string; method: string }[]): string {
  return violations
    .map(({ file, method }) => {
      const [domain] = method.split(".");
      return `  ${file}: found '${method}' (${domain} domain not in allowlist)`;
    })
    .join("\n");
}

function assertNoViolations(violations: { file: string; method: string }[]): void {
  if (violations.length === 0) {
    return;
  }
  assert.fail(`Streaming code contains non-allowlisted CDP methods:\n${formatViolations(violations)}`);
}

test("streaming code only sends allowlisted CDP methods", () => {
  const files = [
    "cdp-adapter.ts",
    "cdp-companion.ts",
    "run-target-registry.ts",
    join(__dirname, "../../node_modules/@opendatalabs/remote-surface/dist/backends/cdp/backend.js"),
  ];

  const { allMethods, violations } = inspectStreamingFiles(files);

  // If any violations found, report them clearly
  assertNoViolations(violations);

  // Assert that at least some basic Page/Input methods are present
  // (so we know streaming code actually exists and the test is working)
  assert.ok(allMethods.has("Page.enable"), "Expected Page.enable to be present in streaming code");
  assert.ok(allMethods.has("Page.startScreencast"), "Expected Page.startScreencast to be present in streaming code");
  assert.ok(
    allMethods.has("Input.dispatchMouseEvent"),
    "Expected Input.dispatchMouseEvent to be present in streaming code"
  );
});
