// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Descendant network isolation for the scenario-record/scenario-verify
 * subprocess boundary.
 *
 * PROBLEM THIS CLOSES: `subprocess-fetch-preloads.ts`'s replay preload denies
 * egress at the JS layer (patched `fetch`/`http`/`https`/`net.Socket.prototype.connect`
 * inside the connector's OWN process — see that module's docstring). That
 * preload explicitly documents a gap it does not close: a connector that
 * shells out to `child_process` (a `curl` invocation, a helper `node`
 * process with its own network stack, a browser child Playwright/Patchright
 * launches) is NOT intercepted, because the preload only patches bindings
 * inside the process it's loaded into — a spawned descendant gets a fresh,
 * unpatched network stack. This module closes that gap at the OS layer
 * instead of the JS layer: it puts the connector subprocess (and therefore
 * every descendant it spawns, transitively) into a Linux network namespace
 * with no interfaces except loopback, so `curl`, a child `node`, a spawned
 * browser, etc. all physically have nowhere to send a non-loopback packet.
 *
 * MECHANISM: `unshare --map-root-user --net -- sh -c '<bring up lo>; exec
 * <cmd> <args>'`. `--net` creates a new, empty network namespace (only a
 * down `lo` interface exists in a fresh netns); `--map-root-user` also
 * unshares a user namespace and maps the caller to root *inside* it, which
 * is what makes `--net` usable WITHOUT the `CAP_SYS_ADMIN`/root the bare
 * `--net` flag would otherwise require on the host — an unprivileged user
 * can create a user+net namespace pair and hold real capabilities (incl.
 * `CAP_NET_ADMIN`) only inside it. The `sh -c` prelude brings `lo` up
 * (`ip link set lo up`) before `exec`-ing the real command, because a fresh
 * netns's loopback starts DOWN — without this, 127.0.0.1 traffic (the
 * replay bridge, if reached via TCP loopback) would fail too, not just
 * external egress. `exec` (not a plain subshell call) replaces the shell
 * with the target process so signals/exit codes propagate normally and
 * there's no lingering `sh` in the process tree.
 *
 * WHY THE BRIDGE NEEDS A UNIX DOMAIN SOCKET: a fresh network namespace's
 * loopback is its OWN loopback, disjoint from the parent namespace's
 * 127.0.0.1 — a TCP server the parent process binds on 127.0.0.1 is NOT
 * reachable from inside the child's netns (they are different loopback
 * devices in different namespaces; that is the entire point of `--net`).
 * A Unix domain socket bound to a path in the shared filesystem crosses
 * that boundary fine, because netns isolation is a network-stack property,
 * not a filesystem property — a UDS is just a special file `connect()`
 * opens, no IP routing involved. So the replay bridge must additionally
 * support a UDS transport (see `writeReplayBridgePreload`'s `udsPath`
 * option and `startFetchBridgeServer`'s `listen` argument in
 * subprocess-fetch-preloads.ts) whenever the connector subprocess this
 * module spawns is namespace-isolated; the existing TCP-loopback bridge
 * mode remains the only option (and the only one that could ever work) when
 * isolation is unavailable and the connector runs in the parent's own netns.
 *
 * PATHNAME-UDS ESCAPE (external review, closed by FIX 5 below): the exact
 * property that makes a UDS cross the netns boundary — it is a filesystem
 * object, not a network endpoint — is ALSO a hole in the isolation this
 * module claims: `--net`/`--unshare-net` only constrains the network
 * namespace, never the filesystem. A prior version of this module left the
 * isolated child's filesystem view IDENTICAL to the parent's
 * (`--dev-bind / /` for bwrap; plain `unshare --net` inherits the parent's
 * existing mount namespace unchanged) — so a NATIVE descendant the isolated
 * process spawns (`curl --unix-socket <path>`, not routed through this
 * package's JS `fetch`/`http`/`net` patching at all) could dial ANY
 * pathname UDS reachable on the shared filesystem, including one a foreign,
 * unrelated parent-namespace process happens to be listening on — reported
 * and independently reproduced: `unshare -r -n -- curl --unix-socket
 * /tmp/foreign.sock http://localhost/probe` reaches a socket the isolated
 * process was never supposed to be able to see. `--net` alone was never a
 * complete answer to "descendant network isolation" — it isolates the
 * network stack, not the filesystem, and a UDS is reachable through the
 * latter. `withFilesystemClosure` below closes this: it gives the isolated
 * child a FRESH, empty view of every conventional world-writable temp
 * directory (`/tmp`, `/var/tmp`, `/dev/shm`, and `os.tmpdir()` if it
 * resolves somewhere else via `TMPDIR`/`TMP`/`TEMP`) and re-exposes, at its
 * real path, ONLY the caller's own evidence-workspace directory (which
 * holds this run's bridge socket and nothing else) — so a `curl
 * --unix-socket <foreign-path>` inside the isolated child finds no such
 * file, while the bridge's own socket keeps resolving exactly where the
 * preload was told to dial it. The rest of the filesystem (`/usr`, `/lib`,
 * the repo checkout, `node_modules`, cwd, everything a connector's own code
 * or a spawned browser needs) stays bound exactly as before — only the
 * handful of directories a foreign pathname socket could plausibly live in
 * are masked, so this closes the actual reported gap without hand-
 * enumerating a minimal filesystem (which would risk silently breaking
 * legitimate connector execution — Playwright/Patchright browser binaries,
 * tsx's module resolution, etc. — on paths this module's author can't fully
 * enumerate in advance).
 *
 * CAPABILITY DETECTION: unprivileged user-namespace creation is not
 * guaranteed available. It can be disabled at the kernel level
 * (`kernel.unprivileged_userns_clone=0`, some hardened distros/containers)
 * or blocked by an LSM policy even when the sysctl allows it (observed
 * empirically in this development sandbox: `unprivileged_userns_clone=1`
 * but AppArmor's `kernel.apparmor_restrict_unprivileged_userns=1` still
 * rejects `unshare --map-root-user --net`, with `write failed
 * /proc/self/uid_map: Operation not permitted`). `isNamespaceIsolationAvailable()`
 * does not infer this from sysctls — it actually test-spawns `unshare -r -n
 * true` and reports what really happened, so callers get a true answer
 * regardless of which of the many ways isolation can be unavailable applies
 * on a given host.
 *
 * WIRED IN: `bin/scenario-verify.ts` calls `isNamespaceIsolationAvailable()`
 * once up front and threads the resolved mechanism through every
 * `spawnWithNetworkIsolation` call for that run (see its
 * `resolveIsolationMechanism` helper) — see USAGE below for the exact shape
 * a caller must follow.
 *
 * USAGE:
 *
 *   import { isNamespaceIsolationAvailable, spawnWithNetworkIsolation } from "./isolation.ts";
 *
 *   const capability = isNamespaceIsolationAvailable();
 *   if (!capability.available) {
 *     console.error(`network isolation: process-local only (${capability.reason})`);
 *   }
 *   const child = spawnWithNetworkIsolation(process.execPath, ["--import", "tsx", connectorPath], {
 *     cwd: PACKAGE_ROOT,
 *     env: { ...subprocessEnv(), NODE_OPTIONS: `--import ${preloadPath}` },
 *     stdio: ["pipe", "pipe", "pipe"],
 *     // Pass the ALREADY-RESOLVED mechanism, never a bare boolean — passing
 *     // `capability.available` (a boolean) here would make `isolate: true`
 *     // re-run the ENTIRE capability probe (spawning `unshare`, and — if
 *     // denied — `bwrap`) from scratch on every single spawn, contradicting
 *     // the "probe once up front, reuse for every run" contract this
 *     // module's capability-detection section documents. `false` when
 *     // isolation isn't available skips wrapping entirely, same as before.
 *     isolate: capability.available ? capability.mechanism : false,
 *     // Re-exposes ONLY this run's own evidence-workspace directory (its
 *     // bridge socket) inside the fresh temp-dir view `withFilesystemClosure`
 *     // builds — see that function's doc comment. Omitting this still
 *     // isolates the network namespace, but leaves every conventional
 *     // world-writable temp directory fully visible to the child, which is
 *     // the exact gap FIX 5 closes; callers whose isolated child dials a UDS
 *     // bridge under a workspace directory must pass it.
 *     filesystemBindPath: workspace.dir,
 *   });
 *   // child is a normal node:child_process ChildProcess — stdout/stdin/stderr,
 *   // "close"/"error" events, .kill() all work exactly as an un-isolated spawn.
 */

import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

/** Result of probing whether this host can actually create an isolated
 *  (user+net) namespace pair right now. `available: false` always carries a
 *  human-readable `reason` so a caller can print an honest capability
 *  statement instead of silently downgrading. */
export type IsolationMechanism = "unshare" | "bwrap";
export type NamespaceIsolationCapability =
  | { available: true; mechanism: IsolationMechanism }
  | { available: false; reason: string };

/**
 * Test-spawns `unshare -r -n true` (equivalent unshare short flags for
 * `--map-root-user --net`) and reports whether it actually succeeded.
 * Deliberately does NOT infer availability from `/proc/sys/kernel/*`
 * sysctls or capability bits: those are necessary but not sufficient (LSM
 * policy — AppArmor's `restrict_unprivileged_userns`, SELinux, gVisor/other
 * sandboxed container runtimes, seccomp profiles — can all independently
 * block this even when the sysctl says it should work). Actually spawning
 * is the only way to get a true answer, and `true` exits instantly so the
 * cost of asking is negligible.
 */
export function isNamespaceIsolationAvailable(): NamespaceIsolationCapability {
  if (process.platform !== "linux") {
    return {
      available: false,
      reason: `unprivileged network namespaces are Linux-only (platform: ${process.platform})`,
    };
  }
  const probe = spawnSync("unshare", ["-r", "-n", "true"], { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
  if (probe.error) {
    const viaBwrap = probeBwrap();
    return viaBwrap.available
      ? viaBwrap
      : { available: false, reason: `unshare not runnable: ${probe.error.message}; ${viaBwrap.reason}` };
  }
  if (probe.status !== 0) {
    const stderr = probe.stderr ? probe.stderr.toString("utf8").trim() : "";
    // The common real-world case: AppArmor's restrict_unprivileged_userns
    // denies a bare `unshare` while still permitting `bwrap`. Try it before
    // declaring the host incapable.
    const viaBwrap = probeBwrap();
    if (viaBwrap.available) {
      return viaBwrap;
    }
    return {
      available: false,
      reason: `unshare -r -n true exited ${String(probe.status)}${stderr ? `: ${stderr}` : ""} — unprivileged user namespaces are unavailable on this host (kernel sysctl or an LSM policy such as AppArmor's unprivileged-userns restriction is the usual cause); ${viaBwrap.reason}`,
    };
  }
  return { available: true, mechanism: "unshare" };
}

/**
 * Second mechanism, tried only when `unshare` is denied.
 *
 * On Ubuntu 24.04+ the AppArmor profile `bwrap-userns-restrict` grants
 * bubblewrap exactly the unprivileged-userns capability that
 * `apparmor_restrict_unprivileged_userns=1` withholds from a bare
 * `unshare`. So a host can report `kernel.unprivileged_userns_clone=1`,
 * refuse `unshare -r -n true`, and still isolate correctly through
 * `bwrap` — which is precisely the configuration this pilot first hit.
 *
 * Probed the same way and for the same reason as `unshare`: by actually
 * spawning it. A profile can be absent, modified, or unloaded, so the
 * only honest answer comes from running the thing.
 */
function probeBwrap(): NamespaceIsolationCapability {
  const probe = spawnSync("bwrap", ["--unshare-net", "--dev-bind", "/", "/", "true"], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 5000,
  });
  if (probe.error) {
    return { available: false, reason: `bwrap not runnable: ${probe.error.message}` };
  }
  if (probe.status !== 0) {
    const stderr = probe.stderr ? probe.stderr.toString("utf8").trim() : "";
    return {
      available: false,
      reason: `bwrap --unshare-net exited ${String(probe.status)}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  return { available: true, mechanism: "bwrap" };
}

export interface SpawnWithNetworkIsolationOptions extends SpawnOptions {
  /**
   * Absolute path of the caller's own evidence-workspace directory (holding
   * this run's UDS bridge socket, if any) — the ONE path re-exposed, at its
   * real location, inside the fresh/empty view `withFilesystemClosure`
   * builds for every conventional world-writable temp directory. See FIX 5
   * in this module's doc comment for why this is required to actually close
   * the pathname-UDS escape, and `withFilesystemClosure`'s doc comment for
   * the exact mechanism per `isolate` value. Ignored when `isolate` is
   * falsy (no isolation requested, so nothing to close).
   */
  filesystemBindPath?: string;
  /**
   * When true, wrap the spawn in `unshare --map-root-user --net` with
   * loopback brought up first, so `cmd` and every descendant it spawns have
   * no external network reachability. When false (or omitted), this is a
   * passthrough to a plain `child_process.spawn(cmd, args, opts)` — callers
   * should set this from a prior `isNamespaceIsolationAvailable()` check
   * rather than assuming isolation is possible.
   */
  isolate?: boolean | IsolationMechanism;
}

/**
 * Quotes a single argv entry for safe interpolation inside the `sh -c`
 * prelude this module constructs. POSIX single-quote escaping: end the
 * quoted string, emit an escaped literal quote, resume quoting. Handles
 * every byte a shell single-quoted string can contain except NUL (which
 * cannot appear in a process argv entry to begin with).
 */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Spawns `cmd`/`args` normally, or — when `opts.isolate` is true — wrapped
 * in `unshare --map-root-user --net -- sh -c '<bring up lo>; exec <cmd
 * args...>'` so the process and every descendant it spawns run in a fresh
 * network namespace with no reachable interface except loopback. Returns a
 * standard `node:child_process` `ChildProcess`; callers interact with it
 * exactly as they would an un-isolated `spawn()` result (same stdio
 * streams, same `"close"`/`"error"` events, same `.kill()`).
 *
 * Does NOT itself check `isNamespaceIsolationAvailable()` — callers decide
 * `isolate` from that check (or their own policy) so this function stays a
 * pure "spawn, optionally wrapped" primitive without hidden fallback
 * behavior a caller might not expect (e.g. silently running un-isolated
 * when isolation was requested but unavailable would be exactly the kind of
 * false safety claim this whole fix exists to prevent).
 */
function detectMechanism(): IsolationMechanism {
  const cap = isNamespaceIsolationAvailable();
  return cap.available ? cap.mechanism : "unshare";
}

/**
 * Every conventional world-writable location a foreign process could bind a
 * pathname UDS to. `os.tmpdir()` is included separately from the hardcoded
 * `/tmp` because it honors `TMPDIR`/`TMP`/`TEMP` and can resolve somewhere
 * else entirely; deduplicated so `os.tmpdir() === "/tmp"` (the common case)
 * doesn't produce a redundant mount. `/var/tmp` and `/dev/shm` are masked
 * for the same reason `/tmp` is: `drwxrwxrwt`, world-writable, a plausible
 * place for an unrelated process to have bound a listening UDS.
 */
function worldWritableTempDirs(): readonly string[] {
  const dirs = new Set(["/tmp", "/var/tmp", "/dev/shm", tmpdir()]);
  return [...dirs];
}

/**
 * Directories masked UNCONDITIONALLY, under BOTH mechanisms, regardless of
 * whether the caller passes `filesystemBindPath` — a declared invariant,
 * not an emergent side effect of some other feature's plumbing. Independent
 * review (external, second pass): `/run` — specifically `/run/user/<uid>`,
 * the XDG runtime directory — was reachable from an isolated child even
 * after FIX 5's original `worldWritableTempDirs()` masking, because `/run`
 * was never in that list at all (bwrap never masked it, under any
 * circumstance) and `unshare`'s masking of `/run` was only ever an
 * incidental side effect of the escape-hatch staging logic below, which
 * only runs when `filesystemBindPath` is set — so a caller invoking
 * `spawnWithNetworkIsolation` with `isolate` set but no `filesystemBindPath`
 * (the type signature allows this) got zero `/run` masking under `unshare`
 * either. Reproduced live: `/run/user/<uid>` on a real host holds sockets
 * for ssh-agent, the D-Bus session bus, PipeWire, and other same-uid
 * tooling — reachable by the isolated child because `--map-root-user`/
 * `unshare -r` only remaps the UID *inside* the new user namespace; the
 * underlying host UID (and therefore same-uid `/run/user/<uid>` access) is
 * unchanged. This is the exact escape class the original review flagged,
 * one directory over. `ALWAYS_MASKED_DIRS` is kept separate from
 * `worldWritableTempDirs()` (rather than folding `/run` into that list) so
 * the "masked no matter what, no conditional path" property is visible at
 * a glance in both `bwrapFilesystemClosureArgs` and
 * `filesystemClosureShellPrelude` — both mask this list first and
 * unconditionally, before anything that depends on `filesystemBindPath`.
 */
const ALWAYS_MASKED_DIRS: readonly string[] = ["/run"];

/**
 * FIX 5 — closes the pathname-UDS filesystem escape this module's doc
 * comment describes (external review, independently reproduced): `--net`/
 * `--unshare-net` only isolates the NETWORK namespace, so a native
 * descendant (`curl --unix-socket <path>`, a spawned helper binary — none
 * of it routed through this package's JS-layer `fetch`/`http`/`net`
 * patching) could previously still dial any pathname UDS reachable on the
 * shared filesystem, because the isolated child's filesystem view was left
 * completely unrestricted (`--dev-bind / /` for bwrap; the parent's
 * existing mount namespace, untouched, for a plain `unshare --net`).
 *
 * MECHANISM (bwrap): after the existing `--dev-bind / /` (which keeps
 * everything a connector legitimately needs — cwd, `node_modules`, browser
 * binaries, the rest of the filesystem — working exactly as before),
 * `--tmpfs <dir>` is appended for every `ALWAYS_MASKED_DIRS` entry FIRST,
 * unconditionally, then every `worldWritableTempDirs()` entry. bwrap
 * applies mount operations in argv order, so each `--tmpfs` masks that
 * directory with a fresh, empty tmpfs, hiding whatever real files
 * (including a foreign UDS) live there on the host — proved empirically: a
 * `curl --unix-socket` to a socket bound outside `filesystemBindPath` fails
 * with "No such file or directory" under this construction, while a normal
 * write to e.g. `/tmp/scratch` still succeeds (the tmpfs is real, just
 * fresh). `--bind <filesystemBindPath> <filesystemBindPath>` is appended
 * last (after every masking `--tmpfs`) ONLY when `filesystemBindPath` is
 * provided, re-exposing that one directory at its real path — this is how
 * the caller's own evidence workspace (and the UDS bridge socket inside it)
 * stays reachable even though the temp-dir tree around it is now empty.
 * `ALWAYS_MASKED_DIRS` is masked whether or not `filesystemBindPath` is
 * set — it does not depend on that option at all.
 *
 * MECHANISM (unshare): `unshare --net` alone shares the parent's existing
 * mount namespace unchanged, so there is nothing to mask without also
 * unsharing mounts. `-m`/`--mount` is added (composes with the existing
 * `--map-root-user --net`) to give the child its own mount namespace, then
 * the `sh -c` prelude this function builds masks every `ALWAYS_MASKED_DIRS`
 * entry FIRST, unconditionally (`mount -t tmpfs tmpfs <dir>`), then every
 * `worldWritableTempDirs()` entry the same way — mirroring bwrap's ordering
 * exactly, and, critically, NOT gated on whether `filesystemBindPath` is
 * set (a prior version of this function nested `/run`'s masking inside the
 * `filesystemBindPath` branch below, as a side effect of the escape-hatch
 * staging step alone — independent review found this meant `/run` was left
 * completely open under `unshare` whenever a caller omitted
 * `filesystemBindPath`, since the type signature allows that. Masking is
 * now a standalone, declared step that runs regardless).
 *
 * `filesystemBindPath` needs an "escape hatch" to survive that masking, NOT
 * a naive `mount --bind <path> <path>` run AFTER the mask: once
 * `filesystemBindPath`'s ancestor directory (e.g. `/tmp`) has a fresh tmpfs
 * mounted over it, the ORIGINAL path is no longer reachable through that
 * name at all — `mkdir -p <path>` at that point creates a brand-new, empty
 * directory in the fresh tmpfs, and bind-mounting that empty directory onto
 * itself is a no-op that does NOT restore the pre-mask content (confirmed
 * empirically: the bridge socket became unreachable — curl exit 7,
 * "couldn't connect" — under exactly this naive ordering). The fix: bind
 * `filesystemBindPath` into a namespace-private staging point BEFORE any
 * masking touches its ancestor, then bind that staging copy back onto the
 * real path AFTER masking. The staging point itself lives inside `/run`
 * (already masked, unconditionally, by the `ALWAYS_MASKED_DIRS` step above
 * — a standard FHS directory on every Linux host, safe to mask for the same
 * reason `/tmp` is: ephemeral runtime state a connector has no legitimate
 * reason to depend on during an isolated replay run) so `mkdir`-ing and
 * bind-mounting the staging directory INSIDE that fresh tmpfs guarantees
 * nothing is ever written to the real host filesystem (the tmpfs — and
 * everything created inside it — is discarded when the namespace exits)
 * while still giving the bind mount a stable anchor that survives `/tmp`
 * (or wherever `filesystemBindPath` lives) being masked afterward.
 * `--map-root-user` already grants the capabilities (`CAP_SYS_ADMIN` inside
 * the new user+mount namespace) every `mount` call here needs; no
 * additional privilege is required beyond what unprivileged user-namespace
 * creation already grants.
 */
const UNSHARE_FS_ESCAPE_HATCH_DIR = "/run/pdpp-scenario-isolation-fsclosure-escape";
function filesystemClosureShellPrelude(filesystemBindPath: string | undefined): string {
  const statements: string[] = [];
  // Declared invariant, unconditional, first — see ALWAYS_MASKED_DIRS's doc
  // comment: this must NOT depend on filesystemBindPath being set.
  for (const dir of ALWAYS_MASKED_DIRS) {
    statements.push(`mount -t tmpfs tmpfs ${shQuote(dir)} >/dev/null 2>&1`);
  }
  const escapeHatch = shQuote(UNSHARE_FS_ESCAPE_HATCH_DIR);
  if (filesystemBindPath !== undefined) {
    // Stage BEFORE any masking below touches filesystemBindPath's ancestor
    // — see this function's doc comment for why a post-mask bind onto the
    // same path does not work. /run is already masked (above), so the
    // staging directory itself is namespace-private (discarded on exit,
    // never written to the real host filesystem).
    statements.push(`mkdir -p ${escapeHatch} >/dev/null 2>&1`);
    statements.push(`mount --bind ${shQuote(filesystemBindPath)} ${escapeHatch} >/dev/null 2>&1`);
  }
  for (const dir of worldWritableTempDirs()) {
    statements.push(`mount -t tmpfs tmpfs ${shQuote(dir)} >/dev/null 2>&1`);
  }
  if (filesystemBindPath !== undefined) {
    statements.push(`mkdir -p ${shQuote(filesystemBindPath)} >/dev/null 2>&1`);
    statements.push(`mount --bind ${escapeHatch} ${shQuote(filesystemBindPath)} >/dev/null 2>&1`);
  }
  return statements.join("; ");
}

function bwrapFilesystemClosureArgs(filesystemBindPath: string | undefined): string[] {
  const args: string[] = [];
  // Declared invariant, unconditional, first — mirrors
  // filesystemClosureShellPrelude's ordering; see ALWAYS_MASKED_DIRS's doc
  // comment.
  for (const dir of ALWAYS_MASKED_DIRS) {
    args.push("--tmpfs", dir);
  }
  for (const dir of worldWritableTempDirs()) {
    args.push("--tmpfs", dir);
  }
  if (filesystemBindPath !== undefined) {
    args.push("--bind", filesystemBindPath, filesystemBindPath);
  }
  return args;
}

export function spawnWithNetworkIsolation(
  cmd: string,
  args: readonly string[],
  opts: SpawnWithNetworkIsolationOptions = {}
): ChildProcess {
  const { isolate, filesystemBindPath, ...spawnOpts } = opts;
  if (!isolate) {
    return spawn(cmd, args, spawnOpts);
  }
  const innerCommand = [cmd, ...args].map(shQuote).join(" ");
  const mechanism = isolate === true ? detectMechanism() : isolate;
  if (mechanism === "bwrap") {
    // `--dev-bind / /` keeps the filesystem view identical to the parent so
    // this stays a drop-in for the unshare path; only the network namespace
    // (`--unshare-net`) and the masked temp directories (FIX 5, below)
    // differ. bwrap brings up loopback itself, so no `ip link` prelude.
    return spawn(
      "bwrap",
      [
        "--unshare-net",
        "--dev-bind",
        "/",
        "/",
        ...bwrapFilesystemClosureArgs(filesystemBindPath),
        "--",
        "sh",
        "-c",
        `exec ${innerCommand}`,
      ],
      spawnOpts
    );
  }
  const closurePrelude = filesystemClosureShellPrelude(filesystemBindPath);
  const shScript = `ip link set lo up >/dev/null 2>&1; ${closurePrelude ? `${closurePrelude}; ` : ""}exec ${innerCommand}`;
  return spawn("unshare", ["--map-root-user", "--net", "--mount", "--", "sh", "-c", shScript], spawnOpts);
}
