// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * REPLAY half of the `"recorded-browser"` driver — HAR-backed browser
 * network replay for connectors that drive their own HTTP traffic through
 * `page.evaluate(fetch)` inside a Patchright browser context (chatgpt,
 * amazon, and every other browser-driven connector), where the existing
 * `recorded-http` driver's `globalThis.fetch`/`node:http` preload
 * (subprocess-fetch-preloads.ts) structurally cannot see anything: that
 * traffic never touches the connector Node process's own fetch/http/net —
 * it originates inside the browser's own JS engine.
 *
 * OWNERSHIP NOTE: this module does NOT edit src/browser-launch.ts or
 * bin/scenario-record.ts (owned by the sibling RECORD-half lane). Instead it
 * follows the exact pattern subprocess-fetch-preloads.ts's REPLAY preload
 * already established for `node:http`/`node:net`: a NODE_OPTIONS preload
 * module, installed via `--import` BEFORE the connector subprocess's own
 * code (and therefore before its `import("./browser-launch.ts") ->
 * import("patchright")` chain) ever runs, that patches patchright's
 * `chromium` `BrowserType` PROTOTYPE method `launchPersistentContext` —
 * confirmed empirically (own-property-descriptor probe) writable/
 * configurable on the prototype, and — because `import("patchright")` is a
 * cached singleton within one process — visible to every LATER dynamic
 * import of the same module, including browser-launch.ts's own. This is the
 * same "Node's built-in/vendored module namespace objects are mutable, and a
 * later import sees an earlier import's patch" property
 * `writeReplayBridgePreload` already documents and relies on for
 * `node:http`.
 *
 * ─── SCOPE: DATA MAPPING, NOT CHOREOGRAPHY ─────────────────────────────────
 *
 * See format.ts's `ScenarioBrowserNetworkDriver` doc comment for the full
 * statement — restated here because it drives every design choice below:
 * this driver replays NETWORK TRAFFIC into the connector's real browser
 * context via Playwright's `routeFromHAR`, then proves the connector's
 * DATA MAPPING (recorded responses -> emitted RECORDs) exactly the way
 * `recorded-http` proves it for fetch traffic — using the SAME
 * `verifyScenario`/RECORD-STATE-trace oracle in verify.ts, unchanged. It
 * does NOT attempt to prove click/navigation choreography deterministic:
 * anti-bot JS and timer nondeterminism make that non-reproducible across two
 * separate browser runs even against an identical HAR, so this driver never
 * tries. `claims.ts` enforces the consequence structurally (recorded-browser
 * can never reach the canonical `recorded_replay` claim) and via a mandatory
 * staleness limitation on every earned `diagnostic_replay: PASS`.
 *
 * ─── EGRESS DENIAL SCOPE (mirrors subprocess-fetch-preloads.ts's stance) ───
 *
 * `notFound: "abort"` on `context.routeFromHAR` is REQUIRED, never optional
 * (this module never constructs the options object without it) — an
 * unmatched request must fail loudly, never silently fall through to the
 * real network, exactly like `recorded-http`'s `ScenarioEgressDeniedError`
 * posture for a connector calling `node:http` directly. `serviceWorkers:
 * "block"` closes a real HAR-replay-specific gap `routeFromHAR` alone does
 * not: a page-registered service worker can intercept fetches BEFORE they
 * reach Playwright's routing layer and serve them from its own cache or let
 * them reach the real network, silently bypassing `notFound: "abort"`'s
 * egress-denial guarantee. Blocking service workers entirely for a replay
 * context closes that gap at the same layer this driver already controls
 * (context creation), rather than trying to detect/intercept SW-originated
 * requests after the fact.
 *
 * NOT CAPTURED/REPLAYED — WebSocket/EventSource/SSE traffic and browser
 * download events. See format.ts's `ScenarioBrowserNetworkDriver` doc
 * comment for why (Playwright's HAR machinery is HTTP request/response
 * only; download bodies can bypass route interception) and the standing
 * fleet fact backing the decision not to build for them (zero of this
 * package's connectors use either surface as of this driver's
 * introduction). If that ever changes, THIS is the file that needs a new
 * interception layer — noted here so the gap is a documented boundary, not
 * a silent one.
 *
 * ─── SESSION STATE (storage_state_path) ────────────────────────────────────
 *
 * Capture runs against a WARM persistent profile — the connector's page-side
 * JS decides whether it's logged in from real cookie/localStorage state, not
 * from anything this harness controls. A `launchPersistentContext` profile
 * directory does carry its own on-disk cookie jar, but the REPLAY profile
 * (a scenario-evidence-workspace-scoped throwaway directory — see
 * `browserReplayProfileDir`) starts genuinely empty; without an explicit
 * storage-state injection, the app takes the login-wall path and every
 * subsequent request the page issues misses the HAR entirely (the
 * login-wall page's own requests were never recorded), which surfaces as a
 * confusing CASCADE of unrelated `notFound: "abort"` aborts instead of one
 * clear diagnosis. `assertStorageStateUsable` (below) checks this BEFORE any
 * browser launches and fails with one specific, named reason instead.
 *
 * ─── CLOCK (fixed_now) ──────────────────────────────────────────────────
 *
 * Connectors compute date-window request params (e.g. a 30-day scope
 * window) from wall-clock "now" — a HAR captured today therefore encodes
 * URLs that will stop matching a live-clock replay the moment enough real
 * time has passed for the window to shift. `run.clock.fixed_now` (format.ts,
 * pre-existing, driver-neutral) is the SAME mechanism `recorded-http` replay
 * already uses for the connector Node process's own `Date.now()`/timers
 * (subprocess-fetch-preloads.ts's REPLAY preload, gated on
 * `PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV`) — this module extends that, it does
 * not invent a parallel clock. TWO clocks need pinning for a browser
 * scenario, and this module pins BOTH from the same `fixed_now`:
 *   (1) the connector Node PROCESS clock — this preload's generated source
 *       includes the identical `Date`/`setTimeout`/`setInterval` patch
 *       `writeReplayBridgePreload` installs (necessarily duplicated, not
 *       imported — this preload's source is serialized into a standalone
 *       `.mjs` module that runs in a separate OS process with no access to
 *       this package's module graph, the same constraint that file's own
 *       doc comment states for `scaleReplayDelayMs`);
 *   (2) the in-PAGE clock — Playwright's `context.clock.install({time})`
 *       (called once per created context, inside the patched
 *       `launchPersistentContext` wrapper below), which patches the
 *       browser's own `Date`/timers for every page in that context. Without
 *       this, a browser-side date computation (many connectors build their
 *       date-window query params via in-page `new Date()`, not Node-side)
 *       would keep drifting from the HAR's capture time even though the
 *       Node-side clock was pinned.
 *
 * ─── NO AUTOMATIC RE-RECORD/REFRESH ────────────────────────────────────────
 *
 * This module has no code path that re-captures, refreshes, or extends a
 * HAR/storage-state file's validity — no timer-based re-record (the failure
 * mode VCR's `re_record_interval` and similar "cassette" tooling exhibit:
 * a passing replay can silently mean "the cassette was quietly
 * re-recorded a moment ago", not "this exact evidence still matches").
 * Re-capture is scenario-record.ts's job (the sibling lane), triggered only
 * by an explicit human-run command — never something this replay path
 * decides to do on a schedule, on a miss, or on staleness. The staleness
 * limitation (claims.ts's `buildBrowserStalenessLimitation`) exists
 * BECAUSE this module refuses to paper over the problem automatically.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenarioRun } from "./format.ts";
import { PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV, REPLAY_TIME_SCALE } from "./subprocess-fetch-preloads.ts";

/**
 * Generated module written by `writeBrowserHarReplayPreload` below does
 * `await import("patchright")` — a BARE specifier, unlike every other
 * preload this package generates (subprocess-fetch-preloads.ts's preloads
 * only import `node:*` builtins, which need no package resolution at all).
 * Node resolves a bare specifier by walking UP from the IMPORTING module's
 * own path looking for the nearest `node_modules` containing it. Writing
 * this file into `workspace.dir` (a `mkdtempSync(join(tmpdir(), ...))`
 * directory — see subprocess-fetch-preloads.ts's `createScenarioEvidenceWorkspace`)
 * would put it under `os.tmpdir()`, OUTSIDE this package tree entirely: that
 * walk reaches `/` and never finds this package's `node_modules/patchright`,
 * so the generated preload's own `import("patchright")` dies with
 * `ERR_MODULE_NOT_FOUND` before any of its patching ever runs. Reproduced
 * directly; not a hypothetical.
 *
 * This is the IDENTICAL defect class commit 2b674fdf1 fixed for
 * bin/scenario-cli.test.ts's generated connector fixtures (which import
 * src/connector-runtime.ts -> @pdpp/connector-protocol and hit the same
 * resolution walk, failing with ERR_PACKAGE_PATH_NOT_EXPORTED instead). That
 * fix's convention is reused verbatim here: write the file inside THIS
 * package tree, under the repo's existing gitignored `tmp/` (root
 * `.gitignore`'s bare `tmp/` line already matches
 * `packages/polyfill-connectors/tmp/`), with unique per-run naming so
 * concurrent runs never collide, and 0600 permissions matching this
 * function's existing security posture (this evidence is
 * `capture.privacy_class: "local-only"` — see subprocess-fetch-preloads.ts's
 * "Secure evidence workspace" module doc comment). Deliberately NARROWER
 * than that precedent: only THIS preload file moves — `workspace` (the 0700
 * mkdtemp evidence workspace) is untouched and still holds the HAR/
 * storage-state paths' resolution base, the UDS bridge socket, and
 * everything `runReplaySubprocess`'s network-namespace isolation binds —
 * none of which import anything and so none of which need to live inside
 * the package tree.
 *
 * ALTERNATIVE CONSIDERED — resolve patchright's absolute path in the PARENT
 * process (where resolution already works) and bake that path into the
 * generated `import(...)` call instead of moving the file: rejected in favor
 * of relocation. Baking in an absolute path freezes today's install layout
 * (e.g. pnpm's `.pnpm/patchright@<version>/node_modules/patchright/...`)
 * into generated source; a different install layout (npm/yarn classic
 * flat node_modules, a different pnpm hoist config, Yarn PnP where
 * `import.meta.resolve` behaves differently or virtual paths are involved)
 * could resolve to something this preload's baked-in path no longer matches,
 * or that patchright's own internal asset/binary lookups (relative to ITS
 * own module location) don't expect to be imported from. Writing the file
 * inside the package tree instead lets Node's ordinary resolution algorithm
 * do the work fresh every run, in every environment — no dependency on how
 * the parent process happened to resolve it.
 */
const PACKAGE_TMP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tmp");

function packageScratchDir(): string {
  mkdirSync(PACKAGE_TMP_DIR, { recursive: true });
  return PACKAGE_TMP_DIR;
}

/**
 * Thrown when a `recorded-browser` run's `environment.network` is missing
 * required fields, or when `har_path`/`storage_state_path` don't resolve to
 * a readable file relative to the scenario's own directory. A distinct,
 * named error class (not a generic `Error`) so `bin/scenario-verify.ts` can
 * report it the same plain-verdict way `ScenarioValidationError` and
 * `WatchdogTimeoutError` already are — a missing/misconfigured evidence
 * file is a diagnosed pre-flight verdict, not a crash in this module's own
 * code.
 */
export class BrowserReplayEvidenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserReplayEvidenceError";
  }
}

interface ResolvedBrowserEvidence {
  fixedNowIso: string | undefined;
  harEntryCount: number;
  harPath: string;
  storageStatePath: string;
}

interface HarLog {
  log?: { entries?: unknown[] };
}

/** Counts HTTP entries in a HAR file at `harPath` — used only to cross-check
 *  the scenario's own declared `har_entry_count` (see
 *  `resolveBrowserEvidence`), not as this module's primary evidence source
 *  (the format field is — see wire-registry.ts's `DRIVER_EVIDENCE_POLICIES`
 *  doc comment for why the pre-flight evidence-sufficiency check reads the
 *  declared count rather than re-parsing the file). A HAR that fails to
 *  parse as JSON, or has no `log.entries` array, counts as zero rather than
 *  throwing here — `assertHarUsable` (the actual pre-flight gate) is what
 *  turns "zero" into a named failure; this helper just counts.
 */
function countHarEntries(harPath: string): number {
  let parsed: HarLog;
  try {
    parsed = JSON.parse(readFileSync(harPath, "utf8")) as HarLog;
  } catch {
    return 0;
  }
  const entries = parsed.log?.entries;
  return Array.isArray(entries) ? entries.length : 0;
}

/** Resolves a scenario-relative path (`har_path`/`storage_state_path`,
 *  format.ts's `ScenarioBrowserNetworkDriver`) against the scenario file's
 *  own directory — both fields are documented as "never absolute", but this
 *  still tolerates an absolute path defensively (`isAbsolute` short-circuit)
 *  rather than double-joining, since nothing in validate.ts rejects one. */
function resolveScenarioRelativePath(scenarioDir: string, relativeOrAbsolutePath: string): string {
  return isAbsolute(relativeOrAbsolutePath) ? relativeOrAbsolutePath : join(scenarioDir, relativeOrAbsolutePath);
}

/**
 * Pre-flight gate — throws `BrowserReplayEvidenceError` with ONE specific,
 * named reason before any browser is launched, rather than letting a
 * missing/unreadable/empty evidence file degrade into the generic
 * unmatched-request-abort cascade this file's module doc describes. Called
 * once per run, before `runBrowserReplaySubprocess` below does anything
 * else.
 */
export function resolveBrowserEvidence(scenarioDir: string, run: ScenarioRun): ResolvedBrowserEvidence {
  const network = run.environment?.network;
  if (network?.driver !== "recorded-browser") {
    throw new BrowserReplayEvidenceError(
      `browser replay requires run.environment.network.driver === "recorded-browser" — this run declares ${JSON.stringify(network?.driver)}`
    );
  }
  const {
    har_path: harPathRaw,
    storage_state_path: storageStatePathRaw,
    har_entry_count: declaredHarEntryCount,
  } = network;
  if (typeof harPathRaw !== "string" || harPathRaw.trim().length === 0) {
    throw new BrowserReplayEvidenceError(
      "browser replay requires run.environment.network.har_path — this run's is missing or empty"
    );
  }
  if (typeof storageStatePathRaw !== "string" || storageStatePathRaw.trim().length === 0) {
    // The failure this module's module doc names explicitly: absence here
    // is the single most likely first failure (a HAR without its paired
    // session state), so it gets its own exact wording rather than folding
    // into a generic "missing field" message.
    throw new BrowserReplayEvidenceError(
      "browser replay requires the captured session state (run.environment.network.storage_state_path is missing or empty) " +
        "— without it, the replaying page takes the login-wall path and every subsequent request misses the HAR"
    );
  }
  const harPath = resolveScenarioRelativePath(scenarioDir, harPathRaw);
  const storageStatePath = resolveScenarioRelativePath(scenarioDir, storageStatePathRaw);
  if (!existsSync(harPath)) {
    throw new BrowserReplayEvidenceError(
      `browser replay: HAR file not found at ${harPath} (run.environment.network.har_path)`
    );
  }
  if (!existsSync(storageStatePath)) {
    throw new BrowserReplayEvidenceError(
      `browser replay requires the captured session state — storage_state_path ${storageStatePath} does not exist ` +
        "(run.environment.network.storage_state_path)"
    );
  }
  let storageStateParsed: unknown;
  try {
    storageStateParsed = JSON.parse(readFileSync(storageStatePath, "utf8"));
  } catch (err) {
    throw new BrowserReplayEvidenceError(
      `browser replay requires the captured session state — storage_state_path ${storageStatePath} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err }
    );
  }
  if (typeof storageStateParsed !== "object" || storageStateParsed === null || Array.isArray(storageStateParsed)) {
    throw new BrowserReplayEvidenceError(
      `browser replay requires the captured session state — storage_state_path ${storageStatePath} does not contain a storage-state object`
    );
  }
  const harEntryCount = typeof declaredHarEntryCount === "number" ? declaredHarEntryCount : countHarEntries(harPath);
  if (harEntryCount <= 0) {
    throw new BrowserReplayEvidenceError(
      `browser replay: HAR at ${harPath} declares har_entry_count ${JSON.stringify(declaredHarEntryCount)} — no recorded entries to replay`
    );
  }
  return { harPath, storageStatePath, harEntryCount, fixedNowIso: run.clock?.fixed_now };
}

/**
 * Writes the browser-replay NODE_OPTIONS preload module and returns its
 * path — the browser-driven sibling of `writeReplayBridgePreload`
 * (subprocess-fetch-preloads.ts), covering `patchright`'s
 * `launchPersistentContext` instead of `node:http`/`node:net`/`fetch`.
 *
 * The generated module:
 *   1. Patches `Date`/`setTimeout`/`setInterval`/`clearTimeout`/
 *      `clearInterval` in the connector Node PROCESS exactly like
 *      `writeReplayBridgePreload` does (necessarily duplicated — see this
 *      file's module doc comment on why these two preloads can't share a
 *      runtime import).
 *   2. Dynamically imports `patchright` once, up front (winning the same
 *      "preload runs before the connector's own `import(...)`" race
 *      `writeReplayBridgePreload` already relies on for `node:http` — see
 *      this file's module doc comment for the empirical confirmation this
 *      also holds for patchright's `chromium` export).
 *   3. Replaces `chromium`'s PROTOTYPE `launchPersistentContext` with a
 *      wrapper that: calls the REAL implementation with `serviceWorkers:
 *      "block"` forced into the options (overriding anything the connector
 *      itself passed, since egress denial must not be optional); calls
 *      `context.setStorageState(storageStatePath)` on the returned context
 *      BEFORE returning it to the caller (browser-launch.ts's
 *      `acquireIsolatedBrowser`), so every page the connector later opens
 *      already carries the captured session; calls
 *      `context.routeFromHAR(harPath, { notFound: "abort" })`, REQUIRED —
 *      see this file's module doc comment; and, when `fixedNowIso` is set,
 *      calls `context.clock.install({ time: fixedNowIso })` so in-page date
 *      reads are pinned to the same instant the Node-process clock patch
 *      pins Date.now() to.
 *
 * Written into this package's own gitignored `tmp/` (via `packageScratchDir`
 * above), NOT into the caller's `ScenarioEvidenceWorkspace` — see this file's
 * module doc comment for why. `workspace` is therefore no longer a parameter
 * here (it would be unused — this package's `noUnusedParameters` tsconfig
 * option rejects that); the HAR/storage-state paths already come fully
 * resolved via `evidence`, so nothing else about this function's contract
 * depended on the workspace directory.
 */
export function writeBrowserHarReplayPreload(evidence: ResolvedBrowserEvidence): string {
  const preloadFileName = `browser-har-replay-preload-${String(process.pid)}-${String(Date.now())}.mjs`;
  const src = `
const HAR_PATH = ${JSON.stringify(evidence.harPath)};
const STORAGE_STATE_PATH = ${JSON.stringify(evidence.storageStatePath)};
const FIXED_NOW_ISO = ${JSON.stringify(evidence.fixedNowIso ?? null)} ?? process.env.${PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV} ?? null;

// ── Node-process clock pin (mirrors subprocess-fetch-preloads.ts's REPLAY
// preload byte-for-byte — see this file's module doc comment for why the
// two can't share an import). Every response the replaying connector's own
// Node-side code sees (if any) is either served from routeFromHAR (browser
// traffic) or has nothing left to protect from pacing timers, so delays are
// SCALED (relative ordering preserved), not skipped.
const REPLAY_TIME_SCALE = ${JSON.stringify(REPLAY_TIME_SCALE)};
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearTimeout = globalThis.clearTimeout;
const realClearInterval = globalThis.clearInterval;
const scaleReplayDelayMs = (delayMs) => Math.max(0, Math.ceil((delayMs ?? 0) / REPLAY_TIME_SCALE));
globalThis.setTimeout = (fn, delayMs, ...args) => realSetTimeout(fn, scaleReplayDelayMs(delayMs), ...args);
globalThis.setInterval = (fn, delayMs, ...args) => realSetInterval(fn, scaleReplayDelayMs(delayMs), ...args);
globalThis.clearTimeout = (handle) => realClearTimeout(handle);
globalThis.clearInterval = (handle) => realClearInterval(handle);

if (FIXED_NOW_ISO) {
  const startMs = new Date(FIXED_NOW_ISO).getTime();
  if (!Number.isNaN(startMs)) {
    let callCount = 0;
    const advance = () => {
      callCount += 1;
      return startMs + callCount;
    };
    Date.now = () => advance();
    const RealDate = Date;
    class ScenarioFixedDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) {
          super(advance());
        } else {
          super(...args);
        }
      }
      static now() {
        return advance();
      }
    }
    globalThis.Date = ScenarioFixedDate;
  }
}

// ── Browser-context patch: HAR routing + session state + service-worker
// block + in-page clock pin. Patched on the PROTOTYPE (not the instance) so
// every later \`await import("patchright")\` in this process — including
// browser-launch.ts's own — resolves to the SAME cached module and sees
// this patch, per this file's module doc comment.
import("patchright").then((patchright) => {
  const chromium = patchright.chromium;
  const proto = Object.getPrototypeOf(chromium);
  const realLaunchPersistentContext = proto.launchPersistentContext;
  proto.launchPersistentContext = async function scenarioHarReplayLaunch(userDataDir, options) {
    const context = await realLaunchPersistentContext.call(this, userDataDir, {
      ...(options ?? {}),
      // Egress-denial posture (this file's module doc comment): a page
      // service worker could otherwise intercept fetches before
      // routeFromHAR's routing layer sees them, silently bypassing
      // notFound:"abort". Forced regardless of what the connector's own
      // browser config requested.
      serviceWorkers: "block",
    });
    // Session state BEFORE routeFromHAR / clock install / returning to the
    // caller — the connector's first navigation must already be
    // authenticated, or it takes the login-wall path (see this file's
    // module doc comment on SESSION STATE).
    await context.setStorageState(STORAGE_STATE_PATH);
    // notFound: "abort" is REQUIRED — see this file's module doc comment
    // ("EGRESS DENIAL SCOPE"). An unmatched request must fail loudly, never
    // silently reach the real network.
    await context.routeFromHAR(HAR_PATH, { notFound: "abort" });
    if (FIXED_NOW_ISO) {
      // In-page clock pin — see this file's module doc comment ("CLOCK").
      // Installed AFTER routeFromHAR/setStorageState so neither of those
      // calls (which may themselves touch the page) observes a
      // clock-patched environment before the app's own code does.
      await context.clock.install({ time: FIXED_NOW_ISO });
    }
    return context;
  };
});
`;
  // 0600, inside this package's own gitignored tmp/ — NOT the 0700 mkdtemp
  // evidence workspace every other generated preload uses (see this file's
  // module doc comment on why: this preload's generated `import("patchright")`
  // needs package-tree resolution, which os.tmpdir() can never provide).
  // Still never loose in the shared OS tmpdir root, and still 0600 — same
  // content-confidentiality posture subprocess-fetch-preloads.ts's "Secure
  // evidence workspace" module doc comment establishes, just a different
  // parent directory.
  const path = join(packageScratchDir(), preloadFileName);
  writeFileSync(path, src, { mode: 0o600 });
  return path;
}
