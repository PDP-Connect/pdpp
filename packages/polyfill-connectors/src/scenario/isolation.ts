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
 * NOT WIRED INTO ANY CLI HERE: this module exports the capability-detection
 * and spawn-wrapping API and documents usage below; wiring
 * `bin/scenario-record.ts`/`bin/scenario-verify.ts` to use it is explicitly
 * another lane's follow-up (per this task's ownership split) — importing
 * and calling these functions from those CLIs is NOT done by this module.
 *
 * USAGE (for the follow-up CLI-wiring lane):
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
 *     isolate: capability.available,
 *   });
 *   // child is a normal node:child_process ChildProcess — stdout/stdin/stderr,
 *   // "close"/"error" events, .kill() all work exactly as an un-isolated spawn.
 */

import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";

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
    return { available: false, reason: `bwrap --unshare-net exited ${String(probe.status)}${stderr ? `: ${stderr}` : ""}` };
  }
  return { available: true, mechanism: "bwrap" };
}

export interface SpawnWithNetworkIsolationOptions extends SpawnOptions {
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

export function spawnWithNetworkIsolation(
  cmd: string,
  args: readonly string[],
  opts: SpawnWithNetworkIsolationOptions = {}
): ChildProcess {
  const { isolate, ...spawnOpts } = opts;
  if (!isolate) {
    return spawn(cmd, args, spawnOpts);
  }
  const innerCommand = [cmd, ...args].map(shQuote).join(" ");
  const shScript = `ip link set lo up >/dev/null 2>&1; exec ${innerCommand}`;
  const mechanism = isolate === true ? detectMechanism() : isolate;
  if (mechanism === "bwrap") {
    // `--dev-bind / /` keeps the filesystem view identical to the parent so
    // this stays a drop-in for the unshare path; only the network namespace
    // differs. bwrap brings up loopback itself, so no `ip link` prelude.
    return spawn("bwrap", ["--unshare-net", "--dev-bind", "/", "/", "--", "sh", "-c", `exec ${innerCommand}`], spawnOpts);
  }
  return spawn("unshare", ["--map-root-user", "--net", "--", "sh", "-c", shScript], spawnOpts);
}
