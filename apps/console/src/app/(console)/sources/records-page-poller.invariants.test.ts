/**
 * Structural coverage for the always-on records poller.
 *
 * `RecordsPagePoller` is a client component built on `useEffect` +
 * `setInterval`, and this app has no JSX render harness (no jsdom /
 * testing-library) — so, exactly like `cancel-run-control.test.ts`, we assert
 * via source regex that the effect is wired the way the freshness fix requires,
 * and cover the load-bearing cadence decision behaviorally in the pure module
 * (`records-poll-interval.test.ts`).
 *
 * The contract these invariants lock:
 *   - the poller mounts unconditionally and ALWAYS arms an interval (no
 *     `if (!enabled) return` early-out — the regression that froze a quiet page);
 *   - the cadence comes from the pure `recordsPollIntervalMs(running)` (fast
 *     when running, slow idle heartbeat otherwise);
 *   - the effect cleans up with `clearInterval` and re-runs on `running`, so a
 *     running↔idle transition swaps cadence without leaking or double-stacking
 *     timers;
 *   - the page mounts the poller regardless of `runningCount` and passes
 *     `running` (not the removed `enabled` gate).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const POLLER_FILE = `${HERE}records-page-poller.tsx`;
const PAGE_FILE = `${HERE}page.tsx`;

// ── Poller: client component, always-on interval, pure-cadence, cleanup ───────

const POLLER_IS_CLIENT_RE = /^"use client";/;
const POLLER_TAKES_RUNNING_PROP_RE = /export function RecordsPagePoller\(\{ running \}: \{ running: boolean \}\)/;
const POLLER_IMPORTS_CADENCE_RE = /import \{ recordsPollIntervalMs \} from "\.\/records-poll-interval\.ts"/;
const POLLER_ARMS_INTERVAL_RE = /setInterval\(\(\) => router\.refresh\(\), recordsPollIntervalMs\(running\)\)/;
const POLLER_CLEANS_UP_RE = /return \(\) => clearInterval\(id\)/;
const POLLER_DEPS_ON_RUNNING_RE = /\}, \[running, router\]\)/;
// The defect being fixed: an `enabled` gate that returned early and disabled
// the interval for a quiet page. Neither the prop nor an early-out may return.
const POLLER_NO_ENABLED_PROP_RE = /enabled/;
const POLLER_EARLY_RETURN_RE = /if \(!\w+\) \{\s*return;\s*\}/;

test("records poller is a client component driven by the pure cadence module", async () => {
  const src = await readFile(POLLER_FILE, "utf8");
  assert.match(src, POLLER_IS_CLIENT_RE);
  assert.match(src, POLLER_TAKES_RUNNING_PROP_RE);
  assert.match(src, POLLER_IMPORTS_CADENCE_RE);
});

test("records poller ALWAYS arms an interval (no enabled gate, no early return)", async () => {
  // This is the load-bearing invariant: a quiet page must keep polling. If
  // either of these reappears, a quiet page would freeze until manual reload —
  // the exact regression this fix removed.
  const src = await readFile(POLLER_FILE, "utf8");
  assert.match(src, POLLER_ARMS_INTERVAL_RE);
  assert.doesNotMatch(src, POLLER_NO_ENABLED_PROP_RE, "the `enabled` gate must be gone");
  assert.doesNotMatch(src, POLLER_EARLY_RETURN_RE, "the effect must not early-return before arming the interval");
});

test("records poller cleans up and re-arms on the running flip — no leaked/double timers", async () => {
  const src = await readFile(POLLER_FILE, "utf8");
  assert.match(src, POLLER_CLEANS_UP_RE);
  assert.match(src, POLLER_DEPS_ON_RUNNING_RE);
});

// ── Page wiring: always mount, pass running not enabled ───────────────────────

const PAGE_MOUNTS_POLLER_WITH_RUNNING_RE = /<RecordsPagePoller running=\{runningCount > 0\} \/>/;
const PAGE_NO_ENABLED_PROP_RE = /RecordsPagePoller enabled=/;

test("records page mounts the poller unconditionally and passes running, not enabled", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The slot is always present in the JSX (not conditionally rendered), and it
  // carries the run state as `running` so the poller can pick its cadence.
  assert.match(src, PAGE_MOUNTS_POLLER_WITH_RUNNING_RE);
  assert.doesNotMatch(src, PAGE_NO_ENABLED_PROP_RE, "the removed `enabled` gate must not be passed");
});
