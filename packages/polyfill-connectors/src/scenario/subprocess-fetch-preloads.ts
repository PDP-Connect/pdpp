// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared subprocess/fetch-bridge plumbing for the scenario-record and
 * scenario-verify developer CLIs (bin/scenario-record.ts,
 * bin/scenario-verify.ts).
 *
 * EXTRACTED FROM (by copy, not by import — the source stays untouched):
 * connectors/oura/scenario.spike.test.ts's `writeRecordPreload`,
 * `writeReplayBridgePreload`, and `startFetchBridgeServer`. That spike wrote
 * a preload that embedded a hardcoded SYNTHETIC oura provider inline in the
 * generated source (`providerResponseFor.toString()` + JSON-literal fixture
 * data) because its `fetch` had nowhere real to go. This module drops that
 * synthetic-provider concern entirely: the record preload here wraps
 * whatever `fetch` already exists in the subprocess (the real global, or
 * Node's default) — that's the right shape for a CLI whose job is to talk to
 * either the real live network (bin/scenario-record.ts's normal use) or a
 * test's own loopback HTTP server (bin/scenario-cli.test.ts's stub
 * connector), never a baked-in fixture. The redaction/capture logic itself
 * (credential query-param stripping, body-size cap, seq numbering, header
 * allowlisting, provider-issued-value binding) is kept in lockstep with
 * record.ts's `createRecordingFetch`/`collectRedactedQueryParams` so the
 * subprocess's hand-rolled recorder matches the in-process one's contract as
 * closely as the two independent runtimes (in-process function vs. a
 * generated `.mjs` module string executed in a separate OS process) allow.
 *
 * Two preload flavors, matching the spike's design:
 *   - RECORD: patches `globalThis.fetch` to record every interaction to an
 *     in-memory array and flush it to `outPath` as JSON on process exit.
 *     Requests pass through to whatever `fetch` already resolves to in the
 *     subprocess (real network by default).
 *   - REPLAY: patches `globalThis.fetch`, `http.request`/`http.get`,
 *     `https.request`/`https.get`, and `net.Socket.prototype.connect` (the
 *     shared choke point under `net.connect`/`net.createConnection` too —
 *     see `writeReplayBridgePreload`'s docstring). `fetch` forwards every
 *     request over a loopback bridge to the parent process, whose handler is
 *     the REAL `createReplayFetch(run, scenario.normalizers)` instance
 *     `verifyScenario` constructs — so the actual matcher/
 *     `assertAllConsumed` machinery in replay.ts is exercised, not a
 *     reimplementation. `fetch` + `http` + `https` + `net` egress is denied
 *     for anything other than the bridge itself: a connector calling
 *     `node:http`/`node:https`/`node:net` directly fails loudly instead of
 *     silently reaching a real server. `child_process`-spawned network
 *     clients are out of scope for the JS-layer denial in THIS module — see
 *     isolation.ts for the OS-layer (network namespace) closure of that gap.
 *
 * Both preloads must be installed via `NODE_OPTIONS=--import <path>` (not a
 * CLI `--import` flag) so they run before tsx registers the connector's
 * module and before the connector's own top-level code (which may call
 * `runConnector(...)` unconditionally at module scope, as oura does) ever
 * executes — see the spike's module docstring for the empirical confirmation
 * that NODE_OPTIONS's --import always wins that race.
 *
 * ─── Secure evidence workspace (FIX 4) ─────────────────────────────────────
 *
 * Every temp file this module creates (generated preload `.mjs` modules, the
 * record preload's flushed capture JSON) now lives inside a per-call `mkdtemp`
 * directory created 0700, with every file inside it written 0600 — not
 * loose in the shared OS tmpdir root, where any other local user/process
 * could read a real developer's captured request/response bodies (which may
 * contain real personal data — `capture.privacy_class: "local-only"` in
 * format.ts exists precisely because these captures are NOT safe to treat as
 * public). `createScenarioEvidenceWorkspace()` creates the directory;
 * `cleanupScenarioEvidenceWorkspace(workspace)` removes it — callers MUST
 * invoke the cleanup helper on every terminal path (success, failure, and
 * thrown-before-either) of whatever CLI/test constructs a workspace.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScenarioInteraction, ScenarioResponseHeaders } from "./format.ts";
import { assertValidRecordMessage, assertValidStateMessage } from "./wire-registry.ts";

export interface SubprocessCapture {
  interactions: ScenarioInteraction[];
  normalizerNames: string[];
}

/**
 * Response headers this harness retains on both the record and replay
 * sides — the vocabulary `format.ts`'s `ScenarioResponseHeaders` doc comment
 * names (retry-after, etag, last-modified, link, x-ratelimit-*). Kept as a
 * single source of truth here so record-time capture and replay-time
 * re-serving can never silently diverge on which headers survive.
 * Comparison is case-insensitive (HTTP header names are case-insensitive by
 * spec, and both `Headers` (fetch) and Node's `http` lower-case incoming
 * header names already).
 */
const RETAINED_RESPONSE_HEADER_NAMES = ["retry-after", "etag", "last-modified", "link"];
function isRetainedResponseHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("x-ratelimit-") || RETAINED_RESPONSE_HEADER_NAMES.includes(lower);
}

/** Extracts the allowlisted headers from a fetch `Headers` object as sorted
 *  `[name, value][]` pairs (deterministic serialization). Returns undefined
 *  when nothing survived the allowlist, matching format.ts's `headers?`
 *  optionality. */
function retainedHeaderPairs(headers: Headers): ScenarioResponseHeaders | undefined {
  const kept: ScenarioResponseHeaders = [];
  for (const [name, value] of headers.entries()) {
    if (isRetainedResponseHeaderName(name)) {
      kept.push([name, value]);
    }
  }
  if (kept.length === 0) {
    return;
  }
  kept.sort((a, b) => a[0].localeCompare(b[0]));
  return kept;
}

/**
 * Env var NAMES stripped from a spawned connector subprocess's environment
 * (P1-2, ninth review, requirement (d)) — every one of these either names a
 * socket path or otherwise routes to a live credential/agent process on the
 * PARENT's host, none of which the isolated child's filesystem closure
 * (isolation.ts's `requiredFilesystemBinds()`) re-exposes at its real path
 * once P1-1/P1-2 land, but which stay a real risk whenever isolation itself
 * is unavailable (the process-local-only fallback this module's own
 * `claims.ts` already downgrades the claim for) or if a future filesystem
 * change ever re-widens the bind set. Exact names, not prefix matches
 * (unlike `NODE_TEST_*` below) — each one is a specific, named credential/
 * socket-routing surface, confirmed present on a real developer host running
 * this suite: `SSH_AUTH_SOCK` (the ssh-agent signing-oracle socket —
 * isolation.ts's module docstring documents this exact escape being closed
 * at the filesystem layer; stripping the env var too means even an
 * un-isolated fallback run, or a connector spawning something that reads
 * this var directly rather than dialing the path isolation.ts derived,
 * cannot find it), `GPG_AGENT_INFO`/`GNUPGHOME` (GPG agent socket/keyring
 * location), `DBUS_SESSION_BUS_ADDRESS` (the D-Bus session bus — an
 * independent review's own escape repro reached this exact socket via a
 * pathname UDS dial before the filesystem closure existed), `XDG_RUNTIME_DIR`
 * (the directory holding runtime sockets by XDG convention — the earlier
 * `/run`-masking fix in isolation.ts's own history exists because this
 * directory routinely holds exactly this class of socket), and the common
 * cloud-credential env vars a compromised connector could otherwise read
 * directly without ever touching a filesystem path at all
 * (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
 * `GOOGLE_APPLICATION_CREDENTIALS`, `AZURE_CLIENT_SECRET`, `GITHUB_TOKEN`,
 * `NPM_TOKEN`, `DOCKER_HOST` — the last because a reachable non-default
 * Docker socket endpoint is itself a privilege-escalation surface, not a
 * credential, but belongs in the same "don't hand a connector a host control
 * plane" category).
 */
const SUBPROCESS_ENV_DENYLIST: ReadonlySet<string> = new Set([
  "SSH_AUTH_SOCK",
  "GPG_AGENT_INFO",
  "GNUPGHOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "DOCKER_HOST",
]);

/**
 * Strips `NODE_TEST_*` env vars (e.g. `NODE_TEST_CONTEXT=child-v8`,
 * `NODE_TEST_WORKER_ID`) plus every name in `SUBPROCESS_ENV_DENYLIST` (P1-2,
 * ninth review) before they reach a spawned connector subprocess.
 *
 * NODE_TEST_* FINDING: when bin/scenario-record.ts or bin/scenario-verify.ts
 * runs inside a `node --test` process (as bin/scenario-cli.test.ts's own
 * `spawnSync` calls do) and spreads `...process.env` into its own child
 * `spawn()` call, `NODE_TEST_CONTEXT` propagates two levels down into the
 * connector subprocess. Node's `--import tsx <connector-entrypoint>` child
 * then hangs indefinitely — confirmed by reproducing the hang with only
 * `env NODE_TEST_CONTEXT=child-v8 node --import tsx <any connector
 * entrypoint>` and no scenario-record/verify code involved at all, and by
 * confirming the same command with that var unset exits normally in under a
 * second. This is Node's own test-runner-context detection misfiring on a
 * grandchild it never spawned, not a bug in this package's code — the fix
 * is to never let a `node --test`-inherited env leak into the connector
 * subprocess this CLI spawns for its own separate purpose.
 *
 * DENYLIST, NOT ALLOWLIST: an allowlist would also have to enumerate every
 * legitimate var a connector's OWN dependencies read (locale, `TERM`, proxy
 * config, `NODE_OPTIONS`-adjacent vars this CLI itself sets afterward, the
 * `PATH` the isolated child's own `exec` needs to resolve `node`/`tsx`
 * against) — none of which this fix has a mandate to audit exhaustively, and
 * getting that enumeration wrong fails CLOSED in the wrong direction (breaks
 * a legitimate connector) rather than the credential-leak direction this fix
 * targets. The denylist above names the SPECIFIC, concrete credential/
 * socket-routing surfaces the review identified; everything else passes
 * through unchanged, same as before this fix.
 */
export function subprocessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("NODE_TEST_") || SUBPROCESS_ENV_DENYLIST.has(key)) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

// ─── Secure evidence workspace (FIX 4) ─────────────────────────────────────

export interface ScenarioEvidenceWorkspace {
  /** Absolute path to the 0700 mkdtemp directory. Every file this module
   *  writes for a given record/replay run belongs inside this directory —
   *  never directly in `os.tmpdir()`. */
  dir: string;
}

/**
 * Creates a fresh 0700 mkdtemp directory to hold this run's generated
 * preload module(s) and (for a record run) its flushed capture JSON.
 * Callers MUST call `cleanupScenarioEvidenceWorkspace` on every terminal
 * path (success, failure, or an exception thrown before either) — this
 * directory can contain a real developer's captured request/response
 * bodies, which is exactly the kind of local, potentially-sensitive
 * evidence `format.ts`'s `privacy_class: "local-only"` already treats as
 * not safe to leave lying around.
 */
export function createScenarioEvidenceWorkspace(): ScenarioEvidenceWorkspace {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-scenario-evidence-"));
  return { dir };
}

/** Removes a workspace directory and everything in it. Safe to call more
 *  than once (idempotent — a missing directory is not an error) and safe to
 *  call even if the workspace was never fully populated. */
export function cleanupScenarioEvidenceWorkspace(workspace: ScenarioEvidenceWorkspace): void {
  rmSync(workspace.dir, { recursive: true, force: true });
}

/** Writes `contents` to `<workspace.dir>/<fileName>` with 0600 permissions
 *  and returns the absolute path. */
function writeWorkspaceFile(workspace: ScenarioEvidenceWorkspace, fileName: string, contents: string): string {
  const path = join(workspace.dir, fileName);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

// ─── RECORD preload (FIX 1) ────────────────────────────────────────────────

/**
 * Additive sibling of the flushed capture envelope's existing `storageFailed`
 * field (bin/scenario-record.ts's `RecordRunResult.storageFailed`, read
 * verbatim off the parsed capture JSON). `storageFailed` stays exactly as
 * it was — a hard "the recorder itself broke" signal. `incomplete` is a
 * broader, ADDITIVE honesty signal covering every other way this recorder
 * can lose data invisibly: a response body truncated at the size cap
 * (`truncatedCount > 0`), or a request still in flight when the process
 * exited (`pendingAtExit > 0`, the reproduced fire-and-forget-request +
 * `process.exit(0)` silent-loss race this fix closes). The CURRENT caller
 * (bin/scenario-record.ts) only reads `storageFailed` today — wiring it to
 * also honor `incomplete`/`truncatedCount`/`pendingAtExit` for
 * `capture.complete` is explicitly another lane's follow-up per this task's
 * ownership split (bin/scenario-record.ts is out of scope here). This
 * module's job is to surface the signal honestly in the envelope; nothing
 * in the existing shape is removed or renamed, so a caller that only reads
 * `storageFailed` still works exactly as before.
 */
export interface RecordPreloadCaptureEnvelope {
  incomplete: boolean;
  interactions: ScenarioInteraction[];
  normalizerNames: string[];
  /** Count of requests the preload's pending-counter saw still in flight
   *  (incremented before `underlying()`, decremented after persist) when
   *  the process exited. Non-zero means at least one interaction may be
   *  silently missing from `interactions` — the fire-and-forget-request +
   *  `process.exit(0)` race this fix closes. */
  pendingAtExit: number;
  storageFailed: boolean;
  /** Count of interactions whose response body was cut at the recorder's
   *  size cap (`response.truncated === true` on that interaction). */
  truncatedCount: number;
}

/**
 * Writes a RECORD-phase preload module and returns its path. The preload
 * wraps the subprocess's existing `globalThis.fetch` (real network by
 * default) with the same credential-query-param redaction and body-capture
 * behavior as record.ts's `createRecordingFetch`, plus this fix's additions
 * (body hash, header allowlist, seq-at-initiation, truncation/
 * pending-counter honesty signals, provenance bindings), and writes the
 * `RecordPreloadCaptureEnvelope` to `outPath` as JSON on process exit (the
 * only way to get data out of a separate OS process back to the parent
 * CLI/test).
 *
 * SIGNATURE COMPATIBILITY: `writeRecordPreload(outPath)` (the pre-existing
 * two-arg-less call shape `bin/scenario-record.ts` uses today) still works
 * unchanged — `workspace` is optional and, when omitted, this function
 * creates and owns a throwaway workspace for just the preload module itself
 * (the existing caller still passes its own `capturePath` for `outPath`
 * directly, unaffected by FIX 4's workspace convention until that CLI is
 * updated to pass one explicitly — another lane's follow-up). Passing an
 * explicit `workspace` (this task's FIX 4 usage) additionally places the
 * generated preload module inside that 0700 directory instead of a
 * one-off implicit one, and is the form new call sites should prefer.
 *

 * FIX (b) BINDINGS: per format.ts's `ScenarioBinding` doc comment, a
 * credential-name-matching query param whose value equals a string leaf of
 * an EARLIER recorded response body in this run is not persisted raw — a
 * `{param, source_seq, json_path}` binding entry is recorded on the
 * interaction instead, and the param is excluded from the stored query
 * entirely (neither the raw value nor a normalizer entry for it — the
 * binding itself, plus replay resolving the expected value from the
 * response it actually served for `source_seq`, is what proves the value
 * without ever persisting it). A credential-named param with NO such
 * provenance (a genuine client secret) is still redacted+normalized exactly
 * as before.
 *
 * FIX (e)/(f) PENDING-COUNTER + CRASH SEMANTICS: `pendingCount` increments
 * immediately before calling `underlying()` and decrements immediately after
 * `sink`-equivalent persistence (the `interactions.push`) completes for that
 * request. A `process.on("exit")` handler reads whatever `pendingCount`
 * holds at that moment — non-zero means a fire-and-forget request (started,
 * never awaited by the connector, process exits anyway) lost its result
 * silently; that count is surfaced as `pendingAtExit` rather than pretending
 * the capture is complete. `process.on("uncaughtExceptionMonitor", ...)` is
 * used instead of `process.on("uncaughtException", ...)` specifically
 * because `uncaughtException` is a BEHAVIOR-ALTERING listener — Node treats
 * ANY listener on that event as "the application has decided to handle this
 * itself," which suppresses Node's default action (print the stack trace,
 * exit non-zero) entirely; a preload installing one would silently change
 * whether a connector crash is fatal, which is exactly the kind of
 * observable-behavior change record-time instrumentation must never cause.
 * `uncaughtExceptionMonitor` listeners are observation-only by design — Node
 * still runs its default fatal handling afterward — so this preload can flag
 * `incomplete` truthfully without altering crash semantics.
 */
export function writeRecordPreload(outPath: string, workspace?: ScenarioEvidenceWorkspace): string {
  const targetWorkspace = workspace ?? createScenarioEvidenceWorkspace();
  const preloadFileName = `record-preload-${String(process.pid)}-${String(Date.now())}.mjs`;
  const src = `
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const MAX_STORED_BODY_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_QUERY_PARAM_RE = /token|key|secret|signature|auth/i;
const MAX_PROVIDER_ISSUED_VALUES = 10_000;
const MIN_PROVIDER_VALUE_LENGTH = 8;
const RETAINED_RESPONSE_HEADER_NAMES = ["retry-after", "etag", "last-modified", "link"];
const isRetainedResponseHeaderName = (name) => {
  const lower = name.toLowerCase();
  return lower.startsWith("x-ratelimit-") || RETAINED_RESPONSE_HEADER_NAMES.includes(lower);
};
const retainedHeaderPairs = (headers) => {
  const kept = [];
  for (const [name, value] of headers.entries()) {
    if (isRetainedResponseHeaderName(name)) kept.push([name, value]);
  }
  if (kept.length === 0) return;
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return kept;
};

const interactions = [];
const normalizerNames = new Set();
let truncatedCount = 0;
let pendingCount = 0;

// Provider-issued values (pagination cursors, continuation tokens) seen in
// earlier response bodies this run, PLUS enough provenance (which seq, which
// json_path) to emit a binding instead of just excusing the param from
// redaction. Maps string leaf value -> { seq, path } of its FIRST sighting.
const providerIssuedValues = new Map();
const walkForProviderValues = (value, seq, path) => {
  if (providerIssuedValues.size >= MAX_PROVIDER_ISSUED_VALUES) return;
  if (typeof value === "string") {
    if (value.length >= MIN_PROVIDER_VALUE_LENGTH && !providerIssuedValues.has(value)) {
      providerIssuedValues.set(value, { seq, path });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkForProviderValues(item, seq, path + "[" + String(i) + "]"));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (providerIssuedValues.size >= MAX_PROVIDER_ISSUED_VALUES) return;
      // dot path when the key is a plain identifier, bracket-quoted otherwise.
      const seg = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? "." + key : "[" + JSON.stringify(key) + "]";
      walkForProviderValues(item, seq, path + seg);
    }
  }
};

let seq = 0;

const underlying = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);

  // FIX (c): seq assigned at REQUEST INITIATION, before awaiting the
  // response, so two concurrent requests keep call order even though their
  // responses may resolve out of order.
  seq += 1;
  const thisSeq = seq;

  const kept = [];
  const bindings = [];
  for (const [name, value] of url.searchParams.entries()) {
    if (CREDENTIAL_QUERY_PARAM_RE.test(name)) {
      const provenance = providerIssuedValues.get(value);
      if (provenance) {
        bindings.push({ param: name, source_seq: provenance.seq, json_path: provenance.path });
        continue;
      }
      normalizerNames.add(name);
      continue;
    }
    kept.push([name, value]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  // FIX (a): request body hash, computed before the request is sent (the
  // clone must happen before the underlying call may consume the stream).
  let bodyHash;
  if (request.body !== null) {
    const bodyBuf = new Uint8Array(await request.clone().arrayBuffer());
    bodyHash = createHash("sha256").update(bodyBuf).digest("hex");
  }

  // FIX (e): increment BEFORE awaiting the underlying call.
  pendingCount += 1;
  let response;
  try {
    response = await underlying(input, init);
  } catch (err) {
    pendingCount -= 1;
    throw err;
  }

  const buf = new Uint8Array(await response.clone().arrayBuffer());
  const truncated = buf.byteLength > MAX_STORED_BODY_BYTES;
  if (truncated) truncatedCount += 1;
  const text = new TextDecoder().decode(truncated ? buf.subarray(0, MAX_STORED_BODY_BYTES) : buf);
  const contentType = response.headers.get("content-type") ?? undefined;
  let parsedBody;
  if (truncated) {
    parsedBody = { __scenario_body_truncated__: true, stored_bytes: buf.byteLength };
  } else {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }
  // Root at "" (not "$"): replay.ts resolveJsonPath splits on "." and drops
  // empty segments, so ".next_token" resolves while "$.next_token" would not.
  if (!truncated) walkForProviderValues(parsedBody, thisSeq, "");

  const headerPairs = retainedHeaderPairs(response.headers);

  interactions.push({
    seq: thisSeq,
    request: {
      method: request.method,
      origin: url.origin,
      path: url.pathname,
      query: kept,
      ...(bodyHash === undefined ? {} : { body_sha256: bodyHash }),
    },
    response: {
      status: response.status,
      ...(contentType === undefined ? {} : { content_type: contentType }),
      ...(headerPairs === undefined ? {} : { headers: headerPairs }),
      body: parsedBody,
      ...(truncated ? { truncated: true } : {}),
    },
    ...(bindings.length > 0 ? { bindings } : {}),
  });

  // FIX (e): decrement AFTER persist (the interactions.push above).
  pendingCount -= 1;

  return response;
};

let storageFailed = false;

// FIX (f): uncaughtExceptionMonitor, NOT uncaughtException — a listener on
// "uncaughtException" suppresses Node's default fatal crash handling for
// EVERY listener registered on that event, changing observable process
// behavior. "uncaughtExceptionMonitor" is observation-only: Node still runs
// its normal fatal path afterward. This preload only flags incomplete; it
// never swallows the crash.
process.on("uncaughtExceptionMonitor", (err) => {
  storageFailed = true;
  process.stderr.write("[scenario-record preload] uncaught: " + (err && err.stack ? err.stack : String(err)) + "\\n");
});

process.on("exit", () => {
  try {
    writeFileSync(
      ${JSON.stringify(outPath)},
      JSON.stringify({
        interactions,
        normalizerNames: [...normalizerNames],
        storageFailed,
        truncatedCount,
        pendingAtExit: pendingCount,
        incomplete: storageFailed || truncatedCount > 0 || pendingCount > 0,
      })
    );
  } catch (err) {
    // Best-effort: a failure here means outPath simply won't exist, which
    // the caller (bin/scenario-record.ts) already treats as a hard failure.
  }
});
`;
  return writeWorkspaceFile(targetWorkspace, preloadFileName, src);
}

// ─── Fetch bridge server (TCP or UDS) ──────────────────────────────────────

export interface FetchBridgeServer {
  close: () => Promise<void>;
  /** Set only when this bridge is listening on a Unix domain socket instead
   *  of TCP loopback — the filesystem path the preload's
   *  `http.request({ socketPath })` connects to. Undefined in the default
   *  TCP-loopback mode (every existing call site). */
  udsPath?: string;
  /**
   * A TCP loopback URL for this bridge. SIGNATURE COMPATIBILITY: kept
   * required (not optional) because the existing caller
   * (`bin/scenario-verify.ts`'s `runCollector`) reads `bridge.url` and
   * assigns it directly to a required `bridgeUrl: string` field — making
   * this optional would break that assignment under this package's strict
   * TypeScript config. In UDS mode (`udsPath` set), this is still populated
   * with a `unix://<path>` diagnostic string for logging/error messages,
   * but callers in UDS mode should dial `udsPath`, not this URL — it is not
   * a dialable TCP endpoint in that mode.
   */
  url: string;
}

interface BridgeRequestEnvelope {
  body?: string;
  method: string;
  url: string;
}

/** Calls `realFetch` for one bridged request and returns the JSON envelope
 *  to write back to the subprocess — split out of `startFetchBridgeServer`
 *  purely to keep that function's cognitive complexity under the package's
 *  lint ceiling; behavior is unchanged from the inline version.
 *
 *  FIX 2(a): a plain-text (non-JSON) recorded body is now forwarded with an
 *  explicit `is_raw_text: true` marker instead of being silently re-parsed
 *  as JSON-if-it-happens-to-parse — `serializeResponseBody`
 *  (src/scenario/replay.ts) already returns the raw string verbatim for a
 *  string body, so this handler must NOT re-stringify it (that would turn
 *  `"hello"` into `"\"hello\""`, corrupting exactly the fidelity this fix
 *  exists to restore) and must tell the preload not to re-parse it as JSON
 *  either. */
async function handleBridgedRequest(realFetch: typeof fetch, envelope: BridgeRequestEnvelope): Promise<string> {
  try {
    const response = await realFetch(envelope.url, {
      method: envelope.method,
      ...(envelope.body === undefined ? {} : { body: envelope.body }),
    });
    const contentType = response.headers.get("content-type");
    const isRawText = !(contentType?.includes("json") ?? false);
    const bodyText = await response.text();
    let body: unknown = bodyText;
    if (!isRawText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        // Claimed JSON content-type but didn't parse: forward as raw text
        // rather than silently corrupting it — the preload's envelope
        // marker below still says is_raw_text so it's served byte-faithful.
      }
    }
    const headerPairs = retainedHeaderPairs(response.headers);
    return JSON.stringify({
      status: response.status,
      content_type: contentType,
      is_raw_text: isRawText || typeof body === "string",
      body,
      ...(headerPairs === undefined ? {} : { headers: headerPairs }),
    });
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

function handleBridgeHttpRequest(realFetch: typeof fetch, req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeRequestEnvelope;
    handleBridgedRequest(realFetch, envelope)
      .then((responseJson) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(responseJson);
      })
      .catch(() => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bridge handler threw" }));
      });
  });
}

/**
 * A loopback-only (TCP) or filesystem-local (UDS) HTTP server whose single
 * POST handler calls `realFetch` and echoes back its status/content-type/
 * headers/body as JSON. Exists solely to let a subprocess's real HTTP
 * requests reach a real, in-process `fetch` implementation (verify.ts's
 * `createReplayFetch` instance) that a subprocess cannot call directly
 * across the process boundary.
 *
 * FIX 3: when `udsPath` is given, the server listens on that Unix domain
 * socket instead of TCP loopback. A network-namespace-isolated child (see
 * isolation.ts) has its OWN, disjoint loopback device — the parent's TCP
 * 127.0.0.1 server is unreachable from inside that netns — but a UDS is a
 * filesystem object, not a network endpoint, so it crosses the namespace
 * boundary exactly like any other shared file the two processes can both
 * see. `udsPath` should live inside the scenario evidence workspace
 * (FIX 4) alongside the generated preloads.
 */
export function startFetchBridgeServer(realFetch: typeof fetch, udsPath?: string): Promise<FetchBridgeServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleBridgeHttpRequest(realFetch, req, res);
    });
    server.on("error", reject);
    if (udsPath !== undefined) {
      // A stale socket file from a prior crashed run would make listen()
      // fail with EADDRINUSE; best-effort remove it first.
      rmSync(udsPath, { force: true });
      server.listen(udsPath, () => {
        resolve({
          url: `unix://${udsPath}`,
          udsPath,
          close: () =>
            new Promise((closeResolve) => {
              server.close(() => {
                rmSync(udsPath, { force: true });
                closeResolve();
              });
            }),
        });
      });
      return;
    }
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("startFetchBridgeServer: expected a bound TCP address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}/`,
        close: () => new Promise((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}

// ─── REPLAY preload (FIX 2 + FIX 3 UDS transport) ──────────────────────────

export interface WriteReplayBridgePreloadOptions {
  /**
   * When set, replay patches `Date.now()`/`new Date()` (no-args) in the
   * subprocess to a monotonically advancing clock starting at this ISO
   * timestamp — mirrors format.ts's `ScenarioClock.fixed_now`. `new
   * Date(explicitArg)` is left untouched (a connector explicitly
   * constructing a date from a specific value is not a wall-clock read).
   * Per the task's env-var contract, the CLI wiring that resolves this from
   * the scenario file is another lane's follow-up; this module both accepts
   * it directly AND (see `PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV`) reads it from
   * the environment as a simpler alternative for a caller that would rather
   * not thread it through a function argument.
   */
  fixedNowIso?: string;
  /** UDS path to bridge over instead of TCP loopback — see FIX 3's module
   *  docstring on `startFetchBridgeServer`. Mutually exclusive with
   *  `bridgeUrl` being used as a live transport (bridgeUrl is still
   *  required for error messages / the same-origin allowlist check when a
   *  TCP bridge is not the active transport, but when `udsSocketPath` is
   *  set the preload dials the socket, not `bridgeUrl`). */
  udsSocketPath?: string;
  /** Places the generated preload module inside this 0700 workspace instead
   *  of an implicit one-off workspace this function creates when omitted.
   *  SIGNATURE COMPATIBILITY: kept inside the options bag (not a required
   *  positional parameter) so the existing single-argument call site
   *  (`writeReplayBridgePreload(args.bridgeUrl)` in
   *  `bin/scenario-verify.ts`) keeps compiling unchanged. */
  workspace?: ScenarioEvidenceWorkspace;
}

/**
 * Env var the replay preload reads `fixed_now` from when
 * `WriteReplayBridgePreloadOptions.fixedNowIso` is not passed directly —
 * the "read it directly from the scenario file path env if simpler"
 * alternative the task describes. The CLI wiring that actually sets this
 * from `scenario.runs[i].clock.fixed_now` before spawning the replay
 * subprocess is another lane's follow-up (bin/scenario-verify.ts is out of
 * scope for this module); this module defines the contract and honors it.
 */
export const PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV = "PDPP_SCENARIO_CLOCK_FIXED_NOW";

/**
 * Env var carrying the UDS path the preload should bridge fetch over,
 * selected instead of TCP loopback whenever it's set — the "UDS mode ...
 * selected by env" FIX 3 calls for. When unset, the preload uses the
 * ordinary TCP `bridgeUrl` transport (unchanged from before this fix).
 */
export const PDPP_SCENARIO_BRIDGE_UDS_PATH_ENV = "PDPP_SCENARIO_BRIDGE_UDS_PATH";

/**
 * Time-scaling factor the REPLAY preload applies to every `setTimeout`/
 * `setInterval` delay in the replaying subprocess (see `writeReplayBridgePreload`'s
 * "REPLAY TIME SCALING" section below for the full rationale).
 *
 * RATIONALE: every response the replaying connector sees is served from a
 * local recording — there is no live provider on the other end — so a
 * connector's own inter-request pacing (whether it runs through the shared
 * HTTP governor's `ProviderPacing`, or a connector's inline
 * `setTimeout`-based delay like venmo/reddit's PAGE_DELAY) has nothing left
 * to protect during replay. Time itself is an effect this harness already
 * virtualizes for replay determinism (see `Date.now()`/`new Date()` patching
 * below, gated on `FIXED_NOW_ISO`) — scaling `setTimeout`/`setInterval` is
 * the same idea applied to wall-clock delays: a connector's pacing/backoff
 * CONTROL FLOW (how many times it waits, in what order, relative to which
 * other waits) survives untouched, but the actual wall-clock cost collapses
 * to roughly 1% of the recorded run. This turns iterate-against-the-
 * recording into seconds instead of minutes, which is the terminal developer
 * loop `bin/scenario-verify.ts` exists to serve.
 *
 * SCALE, NOT SKIP: an earlier design skipped the shared governor's pacing
 * sleep outright via an env-var check inside `src/provider-pacing.ts`. That
 * approach was rejected on review for two reasons: (1) it makes PRODUCTION
 * pacing machinery aware of its caller's execution mode via env
 * action-at-a-distance, a concern that belongs to the harness driving
 * replay, not the pacing primitive itself; and (2) it only covered the one
 * connector class that routes through `createConnectorHttpGovernor` —
 * connectors with their own inline delay (e.g. a bare
 * `setTimeout`-based PAGE_DELAY) would keep re-sleeping in full during
 * replay, since nothing there reads the env flag. Scaling every timer at the
 * one shared choke point (`globalThis.setTimeout`/`setInterval`, patched only
 * inside THIS harness-owned replay preload) fixes both: production code
 * never learns it is being replayed, and every timer-based delay — governor
 * pacing, inline PAGE_DELAY sleeps, anything else built on the same two
 * primitives — is covered uniformly.
 *
 * RELATIVE ORDERING IS PRESERVED (not fire-immediately): scaling a delay by a
 * constant factor keeps a longer wait longer than a shorter one (a 20s pace
 * becomes 200ms; a 30s backoff becomes 300ms; the backoff still fires AFTER
 * the pace it followed). Collapsing every delay to 0 instead would not: two
 * timers scheduled in a specific relative order could then fire in
 * event-loop registration order instead, silently changing a connector's
 * observable control flow (e.g. a retry-before-pace vs pace-before-retry
 * race) — exactly the kind of behavior change replay must not introduce.
 */
export const REPLAY_TIME_SCALE = 100;

/**
 * The scaling arithmetic `writeReplayBridgePreload`'s generated source
 * applies to every `setTimeout`/`setInterval` delay it sees, extracted here
 * as a plain function so it has a direct unit-test seam (the generated
 * source itself only runs inside a spawned subprocess and can't be unit
 * tested in-process). MUST stay byte-equivalent to the inline arithmetic
 * embedded in the template literal below — there is no way to `import` this
 * function into the generated `.mjs` module (it runs in a different OS
 * process with no access to this package's module graph), so a change here
 * must be mirrored there by hand. Floors at 0 (a negative delay is already
 * nonsensical) and rounds up (`Math.ceil`) rather than down, so a nonzero
 * recorded delay never scales to a 0ms timer (which some code paths could
 * read as "did not wait at all" rather than "waited a negligible amount").
 * `delayMs ?? 0` guards the same edge case `setTimeout(fn)` (no delay
 * argument, which is valid JS and defaults to a 0ms timer) hits at the real
 * call site — without it, `undefined / REPLAY_TIME_SCALE` is `NaN`, and
 * `Math.ceil`/`Math.max` of `NaN` is also `NaN`, silently breaking the timer.
 */
export function scaleReplayDelayMs(delayMs: number | undefined): number {
  return Math.max(0, Math.ceil((delayMs ?? 0) / REPLAY_TIME_SCALE));
}

/**
 * Writes a REPLAY-phase preload module and returns its path. The preload
 * forwards every outgoing `fetch()` call in the subprocess to `bridgeUrl`
 * (a `startFetchBridgeServer` instance in the parent process) — or, when
 * `PDPP_SCENARIO_BRIDGE_UDS_PATH` is set in the subprocess's env (or
 * `options.udsSocketPath` is passed here), over that Unix domain socket
 * instead — rather than matching interactions itself, so the parent's real
 * `createReplayFetch` — the same instance `verifyScenario` tracks for
 * `assertAllConsumed()` — is the actual code exercised.
 *
 * SIGNATURE COMPATIBILITY: `writeReplayBridgePreload(bridgeUrl)` (the
 * pre-existing single-argument call shape `bin/scenario-verify.ts` uses
 * today) still works unchanged — `options` (including `options.workspace`)
 * is optional and, when omitted, this function creates and owns a
 * throwaway workspace for just the preload module. Passing
 * `options.workspace` explicitly (this task's FIX 4 usage) places the
 * generated preload inside that shared 0700 directory instead, and is the
 * form new call sites should prefer.
 *
 * EGRESS DENIAL SCOPE (v1, JS layer): this preload patches `globalThis.fetch`,
 * `http.request`/`http.get`, `https.request`/`https.get`, and
 * `net.Socket.prototype.connect` — the complete set of Node built-in entry
 * points a connector could use to open an outbound connection without going
 * through `fetch`. A connector calling `node:http`/`node:https`/`node:net`
 * directly now fails loudly with a `ScenarioEgressDeniedError`-style message
 * naming the API it called, instead of silently reaching a real server.
 * `child_process`-spawned clients (a connector shelling out to `curl`,
 * another `node` process with its own network stack, etc.) are OUT OF SCOPE
 * for this JS-layer preload — this module does not intercept process
 * spawning. Closing that gap at the OS layer (network namespaces) is
 * isolation.ts's job, wired in by the CLI (another lane's follow-up); the
 * UDS bridge mode this preload supports exists specifically so that
 * OS-layer isolation remains compatible with the bridge still working (see
 * isolation.ts's module docstring for why TCP loopback can't cross a netns
 * boundary but a UDS can).
 *
 * IMPLEMENTATION NOTE: Node's built-in module namespace objects returned by
 * `import http from "node:http"` (a default import) is NOT a frozen ESM
 * namespace object — it is the same mutable object CJS `require("http")`
 * returns, with every export an own, writable, non-configurable data
 * property (verified empirically: `Object.getOwnPropertyDescriptor(http,
 * "request").writable === true`). Reassigning `http.request = ...`
 * therefore really does redirect every later default-style
 * `import`/`require` of `node:http` in this process, including the
 * connector's own module, if it imports the same way this preload does.
 * NAMED imports (`import { get } from "node:http"`) do NOT see this
 * reassignment — Node synthesizes those as bindings on a genuinely frozen
 * ESM namespace object (confirmed empirically: `import * as httpNs from
 * "node:http"; httpNs.get = ...` throws `TypeError: Cannot assign to read
 * only property`), a separate object from the default-export one this
 * preload patches. A connector using a named import bypasses the
 * `http.get`/`http.request`/`https.get`/`https.request` denials below —
 * but NOT the actual network boundary, because of the next paragraph.
 *
 * `net.Socket.prototype.connect` (also writable, and NOT subject to the
 * named-vs-default-import split above since it's a shared class prototype,
 * not a rebindable module export) is the actual network choke point patched
 * here, NOT `net.connect`/`net.createConnection` themselves: `net.connect`,
 * `net.createConnection`, `http`/`https` (however imported), and `fetch`
 * (undici) all construct a raw `net.Socket` internally and call
 * `.connect(...)` on it — confirmed empirically by wrapping the prototype
 * method and observing `net.connect(port, host)`, `http.get(...)` (both
 * default- and named-imported), and `fetch(...)` (via undici) all route
 * through it. Patching only the top-level `net.connect`/`net.createConnection`
 * factory functions would (a) miss `new net.Socket().connect(...)` entirely
 * and (b) — discovered while building this fix — break the bridge itself,
 * since undici calls `net.connect` directly for the bridge's own outbound
 * request (TCP mode only). UDS mode uses `http.request({socketPath})`, but
 * that call still internally constructs a `net.Socket` and calls
 * `.connect({path: socketPath, ...})` on it — `path`, not `socketPath`,
 * is the field Node's http module actually sets on the connect-options
 * object it hands to `net.Socket.prototype.connect` (confirmed
 * empirically) — so it DOES route through this same prototype method, and
 * the guard below carries an explicit `path === UDS_PATH` allowlist branch
 * for it, alongside the existing host+port branch for the TCP bridge.
 * Patching the one shared
 * prototype method closes the raw-socket gap AND the named-import gap in
 * one place, and the two allowlist checks (TCP bridge host+port, UDS
 * bridge's own socket path) keep the bridge's own call working in either
 * mode while still denying every other destination.
 *
 * `http.request`/`http.get`/`https.request`/`https.get` are denied
 * unconditionally on the default-export object in TCP mode (the bridge
 * never calls them in that mode, only `fetch`). In UDS mode, this preload's
 * OWN bridge client uses `http.request({socketPath})` directly — the denial
 * wrapper is installed AFTER the preload captures its own reference to the
 * real `http.request`, so the connector still sees the denial while the
 * preload's internal bridge call is unaffected.
 */
export function writeReplayBridgePreload(bridgeUrl: string, options: WriteReplayBridgePreloadOptions = {}): string {
  const targetWorkspace = options.workspace ?? createScenarioEvidenceWorkspace();
  const preloadFileName = `replay-preload-${String(process.pid)}-${String(Date.now())}.mjs`;
  const bridge = new URL(bridgeUrl);
  const bridgeHost = bridge.hostname;
  const defaultPort = bridge.protocol === "https:" ? "443" : "80";
  const bridgePort = bridge.port === "" ? defaultPort : bridge.port;
  const src = `
import http from "node:http";
import https from "node:https";
import net from "node:net";

const BRIDGE_URL = ${JSON.stringify(bridgeUrl)};
const BRIDGE_HOST = ${JSON.stringify(bridgeHost)};
const BRIDGE_PORT = ${JSON.stringify(bridgePort)};
const UDS_PATH = ${JSON.stringify(options.udsSocketPath ?? null)} ?? process.env.${PDPP_SCENARIO_BRIDGE_UDS_PATH_ENV} ?? null;
const FIXED_NOW_ISO = ${JSON.stringify(options.fixedNowIso ?? null)} ?? process.env.${PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV} ?? null;
// Captured BEFORE any of this preload's patching below, so the preload's
// own UDS bridge call (in UDS mode) always uses the real implementation
// regardless of what the connector-facing denial wrappers below do to
// http.request/http.get.
const realHttpRequest = http.request;
const realFetch = globalThis.fetch;

// ── REPLAY TIME SCALING ─────────────────────────────────────────────────
// Every response the replaying connector sees is served from the recording
// - there is no live provider to protect - so a connector's own
// setTimeout/setInterval-based pacing/backoff (whether it runs through the
// shared HTTP governor's ProviderPacing or a connector's inline delay, e.g.
// venmo/reddit's PAGE_DELAY) has nothing left to protect during replay.
// Real setTimeout/setInterval/clearTimeout/clearInterval are captured here,
// BEFORE any patching, so this preload's own bridge I/O (bridgeOverUds/
// bridgeRequest below, and anything Node's http/net internals schedule
// under the hood) keeps using real timers even after the patch below is
// installed. The patch then SCALES every delay a connector schedules by
// REPLAY_TIME_SCALE (rounded up, floored at 0) instead of skipping it
// outright: relative ordering between two timers is preserved (a 20s pace
// and a 30s backoff scale to 200ms and 300ms - the backoff still fires
// after the pace it followed), so a connector's observable control flow is
// unchanged; only the wall-clock cost collapses to roughly 1% of the
// recorded run. See REPLAY_TIME_SCALE's doc comment (subprocess-fetch-
// preloads.ts) for why this replaced an earlier design that skipped pacing
// via an env-var check inside the governor itself.
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

class ScenarioEgressDeniedError extends Error {
  constructor(api) {
    super(
      "scenario replay: egress denied - connector called " + api + " directly, bypassing fetch. " +
      "Replay only permits requests through the patched fetch() so they can be matched against " +
      "recorded interactions; node:http/node:https/node:net are denied outright at this JS layer " +
      "(child_process-spawned network clients are closed at the OS layer by network-namespace " +
      "isolation when available - see src/scenario/isolation.ts)."
    );
    this.name = "ScenarioEgressDeniedError";
  }
}

const denyDirectApi = (api) => {
  return () => {
    throw new ScenarioEgressDeniedError(api);
  };
};

http.request = denyDirectApi("http.request");
http.get = denyDirectApi("http.get");
https.request = denyDirectApi("https.request");
https.get = denyDirectApi("https.get");

// The one shared choke point: net.connect, net.createConnection, http,
// https, and fetch (undici, TCP mode) all construct a raw net.Socket
// internally and call .connect(...) on it - patching this single prototype
// method also covers every path that would otherwise bypass the explicit
// http/https denials above. UDS-mode bridge calls use
// http.request({socketPath}) - Node's http module internally normalizes
// that into a connect-options object carrying path (confirmed empirically:
// net.connect({path}) and http.request({socketPath}) both end up calling
// .connect({..., path: (the socket path), ...})), so it DOES route through
// this same prototype method and DOES read as a "path" option, never
// "socketPath". The allowlist below has two branches: the TCP bridge's own
// host+port, and (UDS mode only) the bridge's own known UDS_PATH via an
// exact path match - both narrow to "this call is the bridge dialing
// itself", denying every other destination including a foreign UDS path.
const realSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function scenarioGuardedConnect(...args) {
  const first = Array.isArray(args[0]) && args[0].length > 0 && typeof args[0][0] === "object" && args[0][0] !== null
    ? args[0][0]
    : args[0];
  if (first && typeof first === "object" && typeof first.path === "string") {
    if (UDS_PATH !== null && first.path === UDS_PATH) {
      return realSocketConnect.apply(this, args);
    }
    throw new ScenarioEgressDeniedError("net.connect (or net.createConnection / a raw net.Socket) to a UDS path");
  }
  const targetHost =
    first && typeof first === "object"
      ? String(first.host ?? "localhost")
      : typeof args[1] === "string"
        ? args[1]
        : "localhost";
  const targetPort = first && typeof first === "object" ? String(first.port ?? "") : String(first ?? "");
  if (targetHost === BRIDGE_HOST && targetPort === BRIDGE_PORT) {
    return realSocketConnect.apply(this, args);
  }
  throw new ScenarioEgressDeniedError("net.connect (or net.createConnection / a raw net.Socket)");
};

// FIX 3 UDS transport: dials the bridge over a Unix domain socket instead of
// TCP loopback, using the pre-capture real http.request so the denial
// wrapper installed above never intercepts this call. Only used when
// UDS_PATH is set (isolation.ts's caller sets this whenever the subprocess
// is network-namespace-isolated, since TCP loopback cannot cross that
// namespace boundary).
function bridgeOverUds(payload) {
  return new Promise((resolve, reject) => {
    const req = realHttpRequest({ socketPath: UDS_PATH, path: "/", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function bridgeRequest(payload) {
  if (UDS_PATH) {
    return bridgeOverUds(payload);
  }
  const bridged = await realFetch(BRIDGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  return bridged.text();
}

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const bodyText = request.body === null ? undefined : await request.clone().text();
  const responseText = await bridgeRequest(JSON.stringify({
    method: request.method,
    url: request.url,
    body: bodyText,
  }));
  const envelope = JSON.parse(responseText);
  if (envelope.error) {
    throw new Error(envelope.error);
  }
  const headers = {};
  if (envelope.content_type) headers["content-type"] = envelope.content_type;
  for (const [name, value] of envelope.headers ?? []) headers[name] = value;
  // FIX 2(a): a body the record side marked as raw text is served AS-IS -
  // never re-JSON.stringify'd. Only a body whose content_type was JSON (and
  // parsed successfully at record/bridge time) is re-serialized here.
  const serialized = envelope.is_raw_text || typeof envelope.body === "string"
    ? envelope.body
    : JSON.stringify(envelope.body);
  return new Response(envelope.body === null ? null : serialized, {
    status: envelope.status,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
};

// FIX 2(c): patch Date.now()/new Date() (no-args) to a monotonically
// advancing clock starting at FIXED_NOW_ISO, when set. "Monotonically
// advancing" (not frozen) so code that measures elapsed time between two
// reads (e.g. "did N ms pass") still observes forward progress, while every
// read is still deterministic given a fixed starting point and call
// sequence. new Date(arg) with an explicit argument is untouched - that is
// the connector constructing a date from a known value, not reading the
// wall clock.
if (FIXED_NOW_ISO) {
  const startMs = new Date(FIXED_NOW_ISO).getTime();
  if (!Number.isNaN(startMs)) {
    let callCount = 0;
    const advance = () => {
      callCount += 1;
      // 1ms per call keeps reads strictly increasing without needing a
      // real timer; deterministic given the same call sequence on replay.
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
`;
  return writeWorkspaceFile(targetWorkspace, preloadFileName, src);
}

export interface ProtocolMessage {
  cursor?: unknown;
  data?: unknown;
  emitted_at?: unknown;
  key?: unknown;
  op?: unknown;
  status?: string;
  stream?: string;
  type: string;
}

/**
 * Canonicalizes a RECORD message's `key` (a string, or a string[] for
 * compound primary keys) into the single string id `messagesToRecordsAndState`
 * stores. Compound keys use the protocol's canonical encoding —
 * `JSON.stringify` of the key array — rather than a fixed-separator join. A
 * fixed-separator join is NOT collision-safe in general: even an "unlikely"
 * separator can, in principle, appear inside a component, at which point two
 * distinct arrays (e.g. `["ab","c"]` vs `["a","bc"]`) could collapse onto
 * the same joined string. `JSON.stringify` of the array is unambiguous —
 * JSON string encoding escapes quotes and structural characters inside
 * string content, so distinct arrays always produce distinct JSON text.
 * Returns `undefined` for any other key shape.
 */
function canonicalRecordKey(key: unknown): string | undefined {
  if (typeof key === "string") {
    return key;
  }
  if (!(Array.isArray(key) && key.every((part) => typeof part === "string"))) {
    return;
  }
  return JSON.stringify(key);
}

/**
 * Normalizes a RECORD message's wire `op` (connector-runtime-protocol.ts's
 * `EmittedMessage` RECORD variant: `op?: "delete"`) into the explicit
 * `"upsert" | "delete"` this oracle's `ScenarioStreamExpectation.ops`
 * (format.ts) and `RunCollectorRecordedRecord.op` (verify.ts) carry — absent
 * on the wire normalizes to `"upsert"` (there is no explicit upsert literal;
 * connector-runtime.ts's `makeEmitRecord` — the only producer — omits `op`
 * entirely for a non-tombstone record and sets `op: "delete"` only for a
 * tombstone). Assumes `assertValidRecordMessage` has already confirmed `op`
 * is absent-or-`"delete"`; called only from that path below.
 */
function normalizeRecordOp(op: unknown): "upsert" | "delete" {
  return op === "delete" ? "delete" : "upsert";
}

/** Splits a connector subprocess's parsed JSONL messages into RECORD /
 *  STATE payloads, the same shape verify.ts's `RunCollectorEmit` expects.
 *
 *  P1-1 (seventh review, wire-registry duty-2) + P2 (eighth review,
 *  wire-registry STATE duty): RECORD and STATE now actually share the
 *  strict-parser policy the previous version of this comment merely CLAIMED
 *  — every RECORD message is validated via `assertValidRecordMessage`
 *  (wire-registry.ts) and every STATE message via `assertValidStateMessage`
 *  (same file, added this wave), BOTH before this function reads any of
 *  their fields: RECORD's nonempty `stream`, valid `key` (string, or
 *  string[] of nonempty strings), object-shaped `data`, string `emitted_at`,
 *  and `op` absent-or-`"delete"`; STATE's nonempty `stream` and a REQUIRED
 *  (even if `null`-valued) `cursor` property. Enforced uniformly for both
 *  the recording side (bin/scenario-record.ts) and the replaying side
 *  (bin/scenario-verify.ts), since both route every subprocess RECORD/STATE
 *  through this one function — a malformed RECORD/STATE now fails recording
 *  and replay instead of being silently dropped or absorbed into a
 *  best-effort projection (previously true for RECORD; STATE had NO
 *  wire-boundary check at all before this wave — a STATE message missing
 *  `cursor`, or carrying a non-string/empty `stream`, previously either
 *  silently vanished from `stateMessages` (`typeof msg.stream === "string"`
 *  was the only prior gate, so `stream: ""` passed straight through) or
 *  read `msg.cursor` as `undefined` with no signal that the field was ever
 *  absent). A message that fails either check throws
 *  `MalformedRecordMessageError`/`MalformedStateMessageError` — matching
 *  this package's "strict parsers reject, never sanitize" policy (verify.ts's
 *  `TraceNormalizationError` doc comment states the same policy for the
 *  protocol-trace oracle; this is the RECORD/STATE oracle's actual
 *  equivalent, not just a comment claiming one). The pre-existing
 *  unsupported-key-shape throw below is unreachable in practice (a key that
 *  fails `isValidRecordKey` already fails `assertValidRecordMessage` first)
 *  but is kept as a defense-in-depth invariant, not removed. */
export function messagesToRecordsAndState(messages: readonly ProtocolMessage[]): {
  records: Array<{ data: unknown; id: string; op: "upsert" | "delete"; stream: string }>;
  stateMessages: Array<{ cursor: unknown; stream: string }>;
} {
  const records: Array<{ data: unknown; id: string; op: "upsert" | "delete"; stream: string }> = [];
  const stateMessages: Array<{ cursor: unknown; stream: string }> = [];
  for (const msg of messages) {
    if (msg.type === "RECORD") {
      assertValidRecordMessage(msg);
      const key = canonicalRecordKey(msg.key);
      if (key === undefined) {
        throw new Error(
          `scenario accounting: RECORD in stream ${String(msg.stream)} has an unsupported key shape; refusing to drop it silently`
        );
      }
      records.push({ stream: msg.stream as string, id: key, data: msg.data, op: normalizeRecordOp(msg.op) });
    } else if (msg.type === "STATE") {
      assertValidStateMessage(msg);
      stateMessages.push({ stream: msg.stream as string, cursor: msg.cursor });
    }
  }
  return { records, stateMessages };
}
