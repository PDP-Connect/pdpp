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
 * MECHANISM: `unshare --map-root-user --net --mount --pid --ipc --uts --fork
 * -- sh -c '<bring up lo>; <filesystem closure — see PATHNAME-UDS ESCAPE
 * below>; exec <cmd> <args>'`. `--net` creates a new, empty network namespace
 * (only a down `lo` interface exists in a fresh netns); `--map-root-user`
 * also unshares a user namespace and maps the caller to root *inside* it,
 * which is what makes `--net` usable WITHOUT the `CAP_SYS_ADMIN`/root the
 * bare `--net` flag would otherwise require on the host — an unprivileged
 * user can create a user+net namespace pair and hold real capabilities (incl.
 * `CAP_NET_ADMIN`) only inside it. `--mount` gives the child its own mount
 * namespace (needed for the filesystem closure below) and `--pid --fork`
 * gives it its own pid namespace (needed for that closure's post-pivot
 * `mount -t proc proc /proc`, which an unprivileged mount namespace without
 * its own pid namespace cannot perform — see `filesystemClosureShellPrelude`'s
 * doc comment). `--ipc` unshares the SysV IPC namespace (shared memory,
 * semaphores, message queues) — without it, `/proc/sysvipc/shm` and friends
 * enumerate every live host IPC object's key/owner/perms from inside the
 * isolated child, the same class of host reconnaissance `--unshare-pid`
 * closes for `/proc/<pid>/cmdline`; composes cleanly with the other unshared
 * namespaces, no observed cost. `--uts` unshares the hostname/domainname
 * namespace — hostname disclosure isn't treated as sensitive by this
 * module's threat model, but the flag is free (no functional cost observed),
 * so it's unshared anyway rather than left as a documented exception. The
 * `sh -c` prelude brings `lo` up (`ip link set lo up`)
 * before anything else, because a fresh netns's loopback starts DOWN —
 * without this, 127.0.0.1 traffic (the replay bridge, if reached via TCP
 * loopback) would fail too, not just external egress; it runs before the
 * filesystem closure specifically so `ip` still resolves through the
 * original, unmodified root. `exec` (not a plain subshell call) replaces
 * the shell with the target process so signals/exit codes propagate
 * normally and there's no lingering `sh` in the process tree.
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
 * PATHNAME-UDS ESCAPE — TWO REVIEW PASSES, TWO DIFFERENT REPAIRS:
 *
 * Pass 1 (external review) found that `--net`/`--unshare-net` only
 * constrains the network namespace, never the filesystem: a prior version
 * of this module left the isolated child's filesystem view IDENTICAL to the
 * parent's (`--dev-bind / /` for bwrap; plain `unshare --net` inherits the
 * parent's existing mount namespace unchanged), so a NATIVE descendant
 * (`curl --unix-socket <path>`, not routed through this package's JS
 * `fetch`/`http`/`net` patching at all) could dial ANY pathname UDS
 * reachable on the shared filesystem — reported repro: `unshare -r -n --
 * curl --unix-socket /tmp/foreign.sock http://localhost/probe`. The first
 * repair (kept in git history, no longer present in this file) masked a
 * hand-picked list of "conventional world-writable temp directories"
 * (`/tmp`, `/var/tmp`, `/dev/shm`, `os.tmpdir()`) plus, after a second
 * review round, `/run`.
 *
 * Pass 2 (independent second review) proved that repair architecturally
 * cannot terminate: `--dev-bind / /` still stood, so the reachable set was
 * "every path on the host that is not on the mask list" — and the list can
 * only ever be finitely long while the escape it targets (any world-
 * readable/writable path a foreign process might have put a socket under)
 * is unbounded. `/run` was the SECOND directory found reachable this way,
 * not the last: the reviewer went on to reach the REAL ssh-agent socket
 * (under `$HOME/.ssh/agent/`, not `/run/user/<uid>` — an entirely different
 * path the mask list never had, and never could enumerate in advance,
 * because it depends on the CALLER's environment, not this module's code),
 * the D-Bus session bus, a Bitwarden vault socket, browser native-messaging
 * sockets, and the codex-approval-host control socket — 24 live sockets in
 * total, none of them under any masked directory.
 *
 * `bwrapFilesystemClosureArgs`/`filesystemClosureShellPrelude` below replace
 * mask-listing with DEFAULT-DENY:
 * instead of starting from `--dev-bind / /` (everything visible) and
 * subtracting a list of directories to hide, the isolated child's root is
 * built from an empty `--tmpfs /` (nothing visible) and only the finite,
 * named set of real paths this replay subprocess actually needs is bound
 * back in, at its real location. That set is DERIVED — see
 * `requiredFilesystemBinds()` below — from what this package's own spawn
 * call, install script, and Node/pnpm layout declare as dependencies
 * (the Node binary's own resolved path, `REPO_ROOT` which holds
 * `node_modules`/tsx/every connector's source, Patchright's browser-binary
 * cache directory, and the handful of standard OS directories dynamic
 * linking and TLS need), not guessed or hand-curated independently of the
 * code that actually requires them. A foreign UDS under `$HOME/.ssh/agent`,
 * `/run/user/<uid>`, a Bitwarden vault directory, or literally any other
 * path NOT in that derived set is unreachable, because nothing outside the
 * set exists in the isolated child's filesystem view at all — closing the
 * escape CLASS, not one more instance of it. A path missing from the
 * derived set fails LOUDLY (the connector's own `require`/`import`/spawn
 * fails with ENOENT against a real, diagnosable path) rather than silently
 * widening the sandbox — the opposite failure direction from a mask list,
 * where a missed entry fails open and invisibly.
 *
 * CAPABILITY DETECTION: unprivileged user-namespace creation is not
 * guaranteed available. It can be disabled at the kernel level
 * (`kernel.unprivileged_userns_clone=0`, some hardened distros/containers)
 * or blocked by an LSM policy even when the sysctl allows it (observed
 * empirically in this development sandbox: `unprivileged_userns_clone=1`
 * but AppArmor's `kernel.apparmor_restrict_unprivileged_userns=1` still
 * rejects `unshare --map-root-user --net`, with `write failed
 * /proc/self/uid_map: Operation not permitted`). `isNamespaceIsolationAvailable()`
 * does not infer this from sysctls — it actually test-spawns the FULL
 * `unshare` namespace+procfs-mount sequence production uses (not just a bare
 * `unshare -r -n true`) and reports what really happened, so callers get a
 * true answer regardless of which of the many ways isolation can be
 * unavailable applies on a given host. This distinction matters: an
 * independent review found a real host shape (Docker `--cap-add=SYS_ADMIN`
 * without full `--privileged`, so Docker's default procfs-subpath masking
 * stays active) where namespace CREATION succeeds but the PID-namespace's
 * own `mount -t proc proc /proc` is refused by the kernel's "too revealing"
 * check — a bare `unshare -r -n true` probe cannot see this coming, because
 * it never attempts the mount. `probeUnshare()` runs the mount-and-verify
 * sequence itself (`procMountVerifyStatements()`) so this failure is caught
 * at probe time (`available: false`, with the kernel's own refusal message
 * in `reason`) rather than surfacing later as a silently empty `/proc` in a
 * spawn that reports success. `filesystemClosureShellPrelude` independently
 * re-checks the same condition at spawn time and refuses to `exec` the
 * target command if it fails, as a second gate for a caller that bypasses
 * the probe.
 *
 * WHAT THIS BOUNDARY DOES AND DOES NOT ISOLATE (both mechanisms, unless
 * noted): isolated — network (no egress beyond loopback), PID (no foreign
 * host process enumeration or `/proc/<pid>/cmdline` read, no `kill(pid, 0)`
 * reachability), mount/filesystem (default-deny: only the derived allowlist
 * plus `filesystemBindPath` are visible, closing pathname-UDS dials to any
 * foreign socket outside that set — see PATHNAME-UDS ESCAPE above), SysV IPC
 * (no `/proc/sysvipc/*` enumeration of host shared memory/semaphores/message
 * queues), UTS (hostname/domainname). Deliberately NOT isolated, by
 * conscious scope decision rather than oversight: the CGROUP namespace (an
 * isolated child's own `/proc/self/cgroup` still reflects the HOST's real
 * cgroup hierarchy path — narrow information disclosure of container/session
 * naming conventions and resource-group structure, not a credential or
 * process-content leak) and the TIME namespace (`CLOCK_MONOTONIC`/
 * `CLOCK_BOOTTIME` offsets are shared with the host — negligible risk, no
 * credential-adjacent exploitation path in this module's threat model, no
 * more dangerous than the already-unrestricted ability to read `date`).
 * Neither gap is treated as in-scope by this module's threat model (which is
 * about closing OS-layer network/filesystem/process-visibility escapes a
 * compromised connector could otherwise exploit, not about hiding every
 * possible fact about the host), but a reader should not assume "isolated"
 * covers either of these two namespaces just because the others are covered.
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
 *     // bridge socket) inside the otherwise-empty default-deny root — see
 *     // `requiredFilesystemBinds()`'s and
 *     // `bwrapFilesystemClosureArgs`/`filesystemClosureShellPrelude`'s doc
 *     // comments. Omitting this still isolates the network namespace and
 *     // the filesystem, but the child then has no path to a bridge socket
 *     // at all; callers whose isolated child dials a UDS bridge under a
 *     // workspace directory must pass it.
 *     filesystemBindPath: workspace.dir,
 *   });
 *   // child is a normal node:child_process ChildProcess — stdout/stdin/stderr,
 *   // "close"/"error" events, .kill() all work exactly as an un-isolated spawn.
 */

import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo root, derived from THIS module's own on-disk location
 * (`packages/polyfill-connectors/src/scenario/isolation.ts`) rather than
 * `process.cwd()` (which is set by the caller and not reliable) — four
 * `dirname` levels up from this file lands at the repo root, the same
 * directory `bin/scenario-verify.ts`'s own `PACKAGE_ROOT`/`REPO_ROOT`
 * constants resolve to. Used by `requiredFilesystemBinds()` below: the
 * entire `node_modules` tree (including `tsx`, every connector's runtime
 * dependencies) and every connector's own source live under this path.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Result of probing whether this host can actually create an isolated
 *  (user+net) namespace pair right now. `available: false` always carries a
 *  human-readable `reason` so a caller can print an honest capability
 *  statement instead of silently downgrading. */
export type IsolationMechanism = "unshare" | "bwrap";
export type NamespaceIsolationCapability =
  | { available: true; mechanism: IsolationMechanism }
  | { available: false; reason: string };

/**
 * Shell statements that mount and verify a fresh procfs, shared verbatim
 * between the real `unshare`-mechanism prelude
 * (`filesystemClosureShellPrelude`) and this module's own capability probe
 * (`probeUnshare` below) — ADVERTISE-VS-HONOR FIX: an earlier version of the
 * probe ran only `unshare -r -n true`, a bare namespace-creation check that
 * never attempted the procfs mount the real prelude depends on. An
 * independent review found a concrete host shape (Docker `--cap-add=
 * SYS_ADMIN` granted without full `--privileged`, so Docker's default
 * procfs-subpath masking is still in effect) where namespace CREATION
 * succeeds (`unshare -r -n true` exits 0) but the PID-namespace's own
 * `mount -t proc proc /proc` is refused by a real, named kernel check
 * (`VFS: Mount too revealing` in the kernel log — a mount namespace
 * attempting to mount a fresh procfs must fully own the PID namespace it
 * reflects, or the kernel refuses it to prevent exactly this class of
 * "escape a masked/restricted procfs by mounting an unmasked one"). Under
 * the old probe, that host reported `available: true`, `unshare` got
 * selected over `bwrap`, and the real spawn then ran to completion (exit 0)
 * with `/proc` present but mounted-but-empty (mkdir succeeded, the mount
 * failed, the failure was swallowed by `>/dev/null 2>&1`) — isolation
 * silently absent while self-reporting healthy, exactly the "fail loud,
 * never silently widen" principle this module states elsewhere. The fix:
 * both the probe and the real prelude run this SAME mount-and-verify
 * sequence, so a host that cannot honor the procfs mount is caught at probe
 * time (reported `available: false`, with the kernel refusal named) and,
 * as a second independent gate, the real prelude also refuses to `exec` the
 * target command if this sequence fails on it (see `filesystemClosureShellPrelude`).
 * `test -r /proc/self/cmdline` (not just checking the mount's own exit
 * status) is the actual verification: this is the same distinction the
 * PID-namespace regression tests draw — a real procfs must let its own
 * mounting process read its own `/proc/self/cmdline`, so this check can't be
 * satisfied by an empty or stale mountpoint the way a bare exit-code check
 * could be.
 */
function procMountVerifyStatements(): string[] {
  return ["mkdir -p /proc", "mount -t proc proc /proc", "test -r /proc/self/cmdline"];
}

/** Human-readable sentinel written to stdout by `unshareProcMountProbeArgv()`'s script
 *  when the mount-and-verify sequence above succeeds — distinguishes a
 *  genuine pass from any other reason the probe child might exit 0 (e.g. a
 *  shell built-in silently no-op'ing). */
const PROC_MOUNT_PROBE_OK = "PDPP_PROC_MOUNT_OK";

/**
 * The full end-to-end dry run the `unshare`-mechanism probe executes: the
 * SAME namespace flags `spawnWithNetworkIsolation` uses in production
 * (`--map-root-user --net --mount --pid --ipc --uts --fork`), then
 * `procMountVerifyStatements()`, then an explicit sentinel print so a
 * process-level success (exit 0) is only trusted when it's also the RIGHT
 * kind of success. On failure the mount statements' own stderr (redirected
 * to stdout here, unlike the swallowed `>/dev/null 2>&1` the real prelude
 * uses once it trusts the probe) surfaces the kernel's own refusal message
 * so a caller's diagnostic names the actual cause, not just "unavailable."
 */
function unshareProcMountProbeArgv(): string[] {
  const script = `${procMountVerifyStatements().join(" && ")} && echo ${PROC_MOUNT_PROBE_OK}`;
  return ["--map-root-user", "--net", "--mount", "--pid", "--ipc", "--uts", "--fork", "--", "sh", "-c", script];
}

/**
 * Test-spawns the real `unshare` namespace+procfs-mount sequence (not just
 * `unshare -r -n true` — see `procMountVerifyStatements()`'s doc comment for
 * why a bare namespace-creation check is insufficient) and reports whether
 * it actually succeeded, INCLUDING the procfs mount the real prelude depends
 * on. Deliberately does NOT infer availability from `/proc/sys/kernel/*`
 * sysctls or capability bits: those are necessary but not sufficient (LSM
 * policy — AppArmor's `restrict_unprivileged_userns`, SELinux, gVisor/other
 * sandboxed container runtimes, seccomp profiles, and Docker's default
 * procfs-subpath masking on a `CAP_SYS_ADMIN`-only, non-`--privileged`
 * container — can all independently block one part or another of this even
 * when a shallower check would say it should work). Actually running the
 * whole sequence is the only way to get a true answer, and it still exits
 * in well under a second so the cost of asking is negligible.
 */
function probeUnshare(): NamespaceIsolationCapability {
  const probe = spawnSync("unshare", unshareProcMountProbeArgv(), {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  if (probe.error) {
    return { available: false, reason: `unshare not runnable: ${probe.error.message}` };
  }
  const stdout = probe.stdout ? probe.stdout.toString("utf8") : "";
  if (probe.status === 0 && stdout.includes(PROC_MOUNT_PROBE_OK)) {
    return { available: true, mechanism: "unshare" };
  }
  const stderr = probe.stderr ? probe.stderr.toString("utf8").trim() : "";
  // The specific, named failure this hardening exists to catch: namespace
  // creation succeeded (an earlier bare `unshare -r -n true` probe would
  // have reported this host as available) but the PID-namespace's own
  // procfs mount was refused by the kernel's "too revealing" check —
  // surfaced verbatim in `stderr` (`mount: /proc: permission denied`) rather
  // than paraphrased, so a caller sees the real kernel-level cause.
  return {
    available: false,
    reason: `unshare namespace+procfs-mount dry run exited ${String(probe.status)}${stderr ? `: ${stderr}` : ""} — either unprivileged user namespaces are unavailable on this host (kernel sysctl or an LSM policy such as AppArmor's unprivileged-userns restriction is the usual cause), or namespace creation succeeded but the PID-namespace's own \`mount -t proc proc /proc\` was refused by the kernel (commonly: Docker's default procfs masking combined with a CAP_SYS_ADMIN grant that stops short of full --privileged, producing a kernel "Mount too revealing" refusal)`,
  };
}

/**
 * Probes `unshare` first (see `probeUnshare()`), falling back to `bwrap`
 * when `unshare` is denied — the common real-world shape, where AppArmor's
 * `restrict_unprivileged_userns` denies a bare `unshare` while still
 * permitting `bwrap`.
 */
export function isNamespaceIsolationAvailable(): NamespaceIsolationCapability {
  if (process.platform !== "linux") {
    return {
      available: false,
      reason: `unprivileged network namespaces are Linux-only (platform: ${process.platform})`,
    };
  }
  const viaUnshare = probeUnshare();
  if (viaUnshare.available) {
    return viaUnshare;
  }
  const viaBwrap = probeBwrap();
  if (viaBwrap.available) {
    return viaBwrap;
  }
  return { available: false, reason: `${viaUnshare.reason}; ${viaBwrap.reason}` };
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
/**
 * PRODUCTION-EQUIVALENT PROBE (P2-1, ninth review): the OLD probe ran a
 * trivial `bwrap --unshare-net --dev-bind / / true` — a bare capability
 * check that shares almost nothing with what production actually invokes
 * (`bwrapArgvForFilesystemClosure`'s empty `--tmpfs /` root, `--unshare-pid`/
 * `--unshare-ipc`/`--unshare-uts`, fresh `--proc`/`--dev`, every derived
 * `requiredFilesystemBinds()` entry, `requiredFhsCompatSymlinks()`, and the
 * workspace bind). The review's exact concern: `--dev-bind / /` is by far
 * the MOST PERMISSIVE root bwrap can be given — a host that can satisfy that
 * bare check might still be UNABLE to satisfy the far narrower default-deny
 * root production actually builds (e.g. a host where `--tmpfs /` itself is
 * refused, or one of the individual FHS-symlink/device-node steps fails
 * under a stricter LSM policy) — so a host could report `available: true`
 * from the old probe while the real production invocation is unsupportable.
 * Marked P2 (not P1) because bwrap, unlike the unshare-mechanism's shell
 * prelude, is a single declarative argv — it exits NONZERO on its own if any
 * declared bind/namespace/mount fails (no equivalent of the unshare
 * prelude's `>/dev/null 2>&1`-swallowed silent-continue failure mode is
 * possible here), so this gap could produce a false "unavailable" verdict
 * turning into a crash-on-first-real-spawn, not a false "available" that
 * silently runs unisolated.
 *
 * Fix: probe via the SAME argument builder production uses
 * (`bwrapArgvForFilesystemClosure`) against a real temporary workspace
 * directory (standing in for `filesystemBindPath`) and a trivial executable
 * (`true`) — the exact shape `isolation-mechanism.test.ts`'s own argv-guard
 * tests already use to inspect the generated argv, now also actually
 * SPAWNED here so the probe exercises real bwrap behavior against
 * production's real derived bind set, not just a shape production never
 * invokes.
 */
function probeBwrap(): NamespaceIsolationCapability {
  const probeWorkspace = mkdtempSync(join(tmpdir(), "pdpp-isolation-bwrap-probe-"));
  try {
    const probe = spawnSync("bwrap", bwrapArgvForFilesystemClosure("true", [], probeWorkspace), {
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
        reason: `bwrap production-equivalent dry run exited ${String(probe.status)}${stderr ? `: ${stderr}` : ""}`,
      };
    }
    return { available: true, mechanism: "bwrap" };
  } finally {
    rmSync(probeWorkspace, { recursive: true, force: true });
  }
}

export interface SpawnWithNetworkIsolationOptions extends SpawnOptions {
  /**
   * Absolute path of the caller's own evidence-workspace directory (holding
   * this run's UDS bridge socket, if any) — the ONE additional path
   * re-exposed, at its real location, inside the default-deny root
   * `bwrapFilesystemClosureArgs`/`filesystemClosureShellPrelude` build (see
   * `requiredFilesystemBinds()`'s doc comment for the base set every
   * isolated child gets regardless of this option). Ignored when `isolate`
   * is falsy (no isolation requested, so nothing to close).
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
 * A single real host path bound into the isolated child's otherwise-empty
 * root. `mode: "rw"` is used ONLY for `filesystemBindPath` (the caller's own
 * evidence workspace, which the replay bridge writes into, and which now also
 * hosts the sandbox-local scratch subdirectories — see
 * `SANDBOX_SCRATCH_SUBDIRS` below) — every path this module derives on its
 * own is `"ro"`.
 *
 * REPO READ-ONLY (P1-2, ninth review): an earlier version bound `REPO_ROOT`
 * `rw` on the theory that a dependency might maintain a `.cache` next to
 * itself under `node_modules`. An external review proved that reasoning
 * unfalsifiable in practice and dangerous in effect: `rw` on `REPO_ROOT`
 * meant a compromised or buggy connector could mutate its OWN source, another
 * connector's source, `node_modules`, `package.json`, test fixtures, or
 * `.git` — and because `dedupeBinds` treats a `REPO_ROOT` entry as covering
 * every path under it, that one `rw` bind silently widened every
 * connector-source path this module's own doc comment describes as
 * "no legitimate reason to write". `REPO_ROOT` is now always `"ro"`; any
 * dependency that genuinely needs a writable cache must be added as its own
 * narrow, individually-justified bind (none has been demonstrated to need
 * one — see `requiredFilesystemBinds()`'s doc comment).
 */
interface FilesystemBind {
  mode: "ro" | "rw";
  path: string;
}

/**
 * The derived, finite set of real paths this replay subprocess needs —
 * REPLACES the old world-writable-temp-dir mask list. Each entry traces to a
 * concrete requirement, not a guess:
 *
 * - `REPO_ROOT` (ro, P1-2 ninth review — was `rw`): `bin/scenario-verify.ts`
 *   spawns `process.execPath ["--import", "tsx", connectorPath]` with `cwd:
 *   PACKAGE_ROOT` — `tsx`, every connector's source, and the ENTIRE
 *   `node_modules` tree (confirmed: this repo's pnpm store resolves fully
 *   inside `REPO_ROOT`, no external symlink targets) live under the repo
 *   checkout. Read-only: a connector replay has no legitimate reason to
 *   mutate its own source, another connector's source, `node_modules`, or
 *   `.git` — see `FilesystemBind`'s doc comment for the review finding this
 *   closes. Any scratch/cache state a dependency needs at runtime goes under
 *   the sandbox-local writable scratch space instead — see
 *   `SANDBOX_SCRATCH_SUBDIRS` and `sandboxScratchEnv()` below — never under
 *   `REPO_ROOT`.
 * - The directory containing `process.execPath` (ro): the actual Node
 *   binary the child re-execs as. Derived from `process.execPath` itself,
 *   not hardcoded to a distro path, because this repo's Node is a
 *   version-manager install (e.g. under `~/.local/share/mise/...`), not
 *   `/usr/bin/node` — hardcoding a "standard" location would silently break
 *   on exactly this kind of setup, which is the failure mode default-deny
 *   exists to convert from silent to loud.
 * - The Playwright/Patchright browser-binary cache (ro), when it exists:
 *   `PLAYWRIGHT_BROWSERS_PATH`, if set in this process's own environment, is
 *   read and honored — Playwright/Patchright itself resolves browser
 *   binaries relative to that override when present (confirmed via
 *   Playwright's own resolution order), so a caller running with a
 *   non-default browser path gets that path bound, not silently ignored in
 *   favor of the default. Absent an override, this falls back to
 *   `~/.cache/ms-playwright` (`browser-har-replay.ts`'s
 *   `import("patchright")` path resolves Chromium/Firefox/WebKit binaries
 *   here by default, outside `REPO_ROOT` — confirmed via this package's own
 *   `scripts/install-patchright-browser.ts`, which downloads into exactly
 *   this location absent the env override). Optional (bind-if-present)
 *   because a `recorded-http`-only run never launches a browser and the
 *   directory may not exist in that environment (e.g. a minimal CI image) —
 *   that absence is not a defect in THIS fix. If `PLAYWRIGHT_BROWSERS_PATH`
 *   IS set but the directory it names does not exist, nothing is bound for
 *   it — a run that then launches a browser fails loudly with ENOENT against
 *   the real configured path, not a silent fallback to the wrong cache.
 * - `/usr` (ro): dynamic linking (`ld-linux`, `libc`, `libcurl`, etc. — every
 *   entry `ldd node` / `ldd curl` reports on this host resolves under
 *   `/usr/lib*`) and every binary this module's own inner command can name
 *   (`node`, `curl`, `sh`).
 * - `/etc` (ro), bound WHOLE, not a narrow subset: `/etc/ssl` (TLS trust
 *   roots), `nsswitch.conf`/`passwd`/`group` (glibc NSS resolution),
 *   `os-release`, and `ld.so.cache`/`ld.so.preload` are all confirmed
 *   touched by `node`/`curl` alone (via `strace -e trace=openat`); a
 *   Playwright-launched browser reads substantially more of `/etc`
 *   (fontconfig, D-Bus machine-id, locale data, its own crypto/cert config)
 *   that varies by distro and browser engine. Binding a curated subset risked
 *   silently under-provisioning that browser surface on some future host;
 *   the whole directory is bound instead and left readable — no new
 *   privilege, since DAC still applies (the isolated child runs as the same
 *   real UID as the parent, confirmed: `--map-root-user`/`--unshare-pid`
 *   only remap namespaces, not the underlying UID `/etc/shadow`-class files
 *   are already protected by on this host).
 * - `/proc`, `/dev` (bwrap's own `--proc`/`--dev`, not a bind of the host's):
 *   every process needs `/proc/self`, `/dev/null`, `/dev/urandom`, etc. to
 *   function as a process at all; bwrap synthesizes fresh, namespace-private
 *   instances of both rather than exposing the host's.
 *
 * `filesystemBindPath` (the caller's own evidence workspace / UDS bridge
 * socket) is NOT part of this derived list — it is a per-call, per-run
 * argument threaded through separately by `spawnWithNetworkIsolation`,
 * exactly as before. `/bin`, `/lib`, `/lib64`, `/lib32`, `/libx32`, `/sbin`
 * are NOT bind-mounted here at all — see `requiredFhsCompatSymlinks()`
 * below: on a merged-usr layout (this host, and every current major distro)
 * they are top-level SYMLINKS into `/usr/...`, not separate directories,
 * and binding `/usr` does not recreate a symlink that has to exist AT THAT
 * TOP-LEVEL PATH for `execvp`/the ELF loader to find it — confirmed
 * empirically: `--ro-bind /usr /usr` alone produces `bwrap: execvp
 * /usr/bin/dash: No such file or directory`, because dash's own ELF
 * interpreter is `/lib64/ld-linux-x86-64.so.2`, an absolute path that does
 * not exist in a root where only `/usr` was bound.
 *
 * A path that does not exist on this host is silently omitted only when
 * explicitly documented above as optional (`~/.cache/ms-playwright`).
 * Every other entry is REQUIRED: `spawnWithNetworkIsolation` does not probe
 * for `REPO_ROOT`/`process.execPath`'s directory/`/usr`/`/etc` existing —
 * their absence would mean Node itself could not have started, so failure
 * there surfaces as bwrap's own loud, diagnostic bind error, never a silent
 * widening of the sandbox.
 */
export function requiredFilesystemBinds(): readonly FilesystemBind[] {
  const nodeDir = dirname(process.execPath);
  const binds: FilesystemBind[] = [
    { path: REPO_ROOT, mode: "ro" },
    { path: nodeDir, mode: "ro" },
    { path: "/usr", mode: "ro" },
    { path: "/etc", mode: "ro" },
  ];
  const playwrightCache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  if (existsSync(playwrightCache)) {
    binds.push({ path: playwrightCache, mode: "ro" });
  }
  return dedupeBinds(binds);
}

/** Drops any bind whose path is identical to, or a filesystem descendant of,
 *  an earlier entry in the list — binding both would either be a harmless
 *  redundant mount or (worse) a `rw` ancestor accidentally masking a
 *  narrower `ro` intent. Order-preserving: the FIRST occurrence wins. */
function dedupeBinds(binds: readonly FilesystemBind[]): FilesystemBind[] {
  const kept: FilesystemBind[] = [];
  for (const bind of binds) {
    const normalized = resolve(bind.path);
    const alreadyCovered = kept.some(
      (existing) => normalized === existing.path || normalized.startsWith(`${existing.path}${sep}`)
    );
    if (!alreadyCovered) {
      kept.push({ path: normalized, mode: bind.mode });
    }
  }
  return kept;
}

/**
 * Sandbox-local writable subdirectories created UNDER `filesystemBindPath`
 * (P1-2, ninth review) — `filesystemBindPath` is already the one `rw` path
 * every isolated child gets (the caller's evidence workspace), so these ride
 * inside it rather than requiring a second bind. Replaces `REPO_ROOT`'s old
 * `rw` grant (see `FilesystemBind`'s doc comment): a connector that writes a
 * `.cache`, a browser profile, or any other transient state now writes here,
 * never into the repo checkout.
 *
 * `home` / `xdgCache` / `tmp` map onto `HOME` / `XDG_CACHE_HOME` / `TMPDIR` —
 * see `sandboxScratchEnv()` below, which callers (bin/scenario-verify.ts,
 * bin/scenario-record.ts) fold into the isolated child's environment so
 * anything resolving a home/cache/tmp directory (glibc, npm-style tools,
 * `os.tmpdir()`, `homedir()`) lands here instead of the real host paths —
 * `connector-artifact-root.ts`'s `homedir()` fallback and
 * `browser-launch.ts`'s `PDPP_BROWSER_PROFILE_ROOT`-or-`homedir()` default
 * both benefit from this redirection for free, without either module needing
 * isolation-awareness of its own.
 */
const SANDBOX_SCRATCH_SUBDIRS = { home: "home", tmp: "tmp", xdgCache: "xdg-cache" } as const;

/** Absolute sandbox-local scratch paths for a given `filesystemBindPath`
 *  (the caller's evidence-workspace directory) — pure path arithmetic, no
 *  filesystem access. `filesystemClosureShellPrelude`/
 *  `bwrapFilesystemClosureArgs` use these to know where to `mkdir` the
 *  scratch subdirectories; `sandboxScratchEnv()` uses them to build the env
 *  vars pointing a spawned child at them. */
function sandboxScratchPaths(filesystemBindPath: string): { home: string; tmp: string; xdgCache: string } {
  return {
    home: join(filesystemBindPath, SANDBOX_SCRATCH_SUBDIRS.home),
    tmp: join(filesystemBindPath, SANDBOX_SCRATCH_SUBDIRS.tmp),
    xdgCache: join(filesystemBindPath, SANDBOX_SCRATCH_SUBDIRS.xdgCache),
  };
}

/**
 * Env vars pointing an isolated child at its sandbox-local writable scratch
 * space instead of the real host's `$HOME`/`$TMPDIR`/`$XDG_CACHE_HOME` — the
 * caller merges this into the child's environment alongside
 * `subprocessEnv()`. Exported so `bin/scenario-verify.ts`/
 * `bin/scenario-record.ts` (which own building the full child env) can call
 * it directly rather than re-deriving the scratch layout independently of
 * `sandboxScratchPaths()`. Returns `{}` (no override) when `filesystemBindPath`
 * is `undefined` — matches `spawnWithNetworkIsolation`'s own existing
 * behavior of leaving the environment untouched when no workspace was
 * supplied (e.g. `isolate` is falsy).
 */
export function sandboxScratchEnv(filesystemBindPath: string | undefined): NodeJS.ProcessEnv {
  if (filesystemBindPath === undefined) {
    return {};
  }
  const scratch = sandboxScratchPaths(filesystemBindPath);
  return { HOME: scratch.home, TMPDIR: scratch.tmp, XDG_CACHE_HOME: scratch.xdgCache };
}

/**
 * A top-level FHS compatibility symlink (`/bin`, `/lib`, `/lib64`, ...) that
 * must be RECREATED as a symlink inside the default-deny root, distinct
 * from `requiredFilesystemBinds()`'s real directory binds. On a merged-usr
 * layout (confirmed on this host, and standard on every current major
 * distro: Debian/Ubuntu since ~2020, Fedora/Arch for years longer) these
 * paths are symlinks INTO `/usr/...` on the real host, not separate
 * directories — `--ro-bind /usr /usr` alone does not make `/bin` or
 * `/lib64` exist at the TOP LEVEL of the sandboxed root, and `execvp`/the
 * ELF loader look for binaries and interpreters (`/lib64/ld-linux-...`) at
 * exactly those top-level paths. `target` is read from the REAL host
 * symlink via `readlinkSync`, not hardcoded to `usr/bin`-style guesses, so
 * a host with a different (or absent) compat-symlink layout is followed
 * exactly rather than assumed.
 */
interface FhsCompatSymlink {
  path: string;
  target: string;
}

const FHS_COMPAT_SYMLINK_CANDIDATES: readonly string[] = ["/bin", "/sbin", "/lib", "/lib64", "/lib32", "/libx32"];

/**
 * Reads which of `FHS_COMPAT_SYMLINK_CANDIDATES` actually exist as symlinks
 * on THIS host and what they point at — skips any that don't exist (e.g. a
 * non-merged-usr host has real `/bin`, not a symlink; a 32-bit-less host has
 * no `/lib32`) and skips any that exist but are NOT a symlink (a real
 * directory at `/bin` needs its own full bind, which is out of scope for
 * this fix's derived set — this module's target hosts are the merged-usr
 * layout confirmed above).
 */
function requiredFhsCompatSymlinks(): readonly FhsCompatSymlink[] {
  const symlinks: FhsCompatSymlink[] = [];
  for (const path of FHS_COMPAT_SYMLINK_CANDIDATES) {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        symlinks.push({ path, target: readlinkSync(path) });
      }
    } catch {
      // Doesn't exist on this host — nothing to recreate.
    }
  }
  return symlinks;
}

/**
 * DEFAULT-DENY FILESYSTEM CLOSURE — replaces the mask-list architecture
 * (`worldWritableTempDirs`/`ALWAYS_MASKED_DIRS`, removed) that a second,
 * independent review proved cannot terminate: with `--dev-bind / /` still
 * in place, the reachable set was always "every path not yet added to the
 * list," and the reviewer kept finding new members of that set ($HOME/.ssh,
 * a Bitwarden vault socket, the codex-approval control socket — 24 live
 * sockets total) no matter how many directories got masked.
 *
 * MECHANISM (bwrap): `--unshare-pid` gives the child its own PID namespace
 * (composing with the pre-existing `--unshare-net`) — without it, bwrap's
 * `--proc /proc` mounts a FRESH procfs instance that still reflects the
 * HOST's PID namespace (procfs is a view of whichever PID namespace the
 * mounting process belongs to, independent of the mount being "fresh"), so
 * an isolated child could enumerate and read `/proc/<pid>/cmdline` — full
 * argv, which routinely carries secrets (`--token=...`, connection strings)
 * — for every process on the host, not just its own subtree. `--unshare-ipc`
 * closes the symmetric gap for SysV IPC: without it, `/proc/sysvipc/shm`
 * (and semaphores/message queues) enumerate every live host IPC object's
 * key/owner/perms from inside the isolated child, the same reconnaissance
 * shape as the unpatched `/proc/<pid>/cmdline` leak. `--unshare-uts` closes
 * hostname/domainname visibility — not treated as sensitive by this module's
 * threat model, but added because it composes with no observed cost.
 * Confirmed via an independent review's repro: without `--unshare-pid`, an
 * isolated child's `ls /proc | grep -cE '^[0-9]+$'` showed 1683 of 1681 host
 * processes (essentially the entire host process table); with it, the same
 * probe shows only the child's own tiny subtree, matching what `unshare
 * --pid --fork` (below) already did correctly. The child's root is
 * `--tmpfs /` — an empty, private tmpfs, NOT the host's `/` — so nothing
 * exists in the isolated view except what this function explicitly binds
 * back in: `--proc /proc`, `--dev /dev`, every `requiredFilesystemBinds()`
 * entry (`--ro-bind` or `--bind` per its `mode`), and, last,
 * `filesystemBindPath` if the caller passed one.
 * A foreign UDS under `$HOME/.ssh/agent`, `/run/user/<uid>`, or any other
 * path outside that finite set has NO node in the isolated child's mount
 * table to be reached through — `curl --unix-socket <foreign-path>` fails
 * with "No such file or directory" not because that specific path was
 * masked, but because the child's filesystem contains only what was
 * explicitly built, the same way a fresh container image contains only what
 * its Dockerfile added.
 *
 * MECHANISM (unshare): `--mount --pid --fork` (composing with
 * `--map-root-user --net`) gives the child its own mount AND pid namespace,
 * then the `sh -c` prelude this function builds performs an actual
 * `pivot_root` — NOT a `mount -t tmpfs tmpfs /` on the existing root, which
 * was tried first and empirically does NOT work: mounting a tmpfs directly
 * onto the mount namespace's OWN root is a documented Linux special case
 * that silently fails to change what's visible (confirmed: files written
 * after the "masking" mount remained visible alongside pre-existing
 * content — the mount succeeded, exit 0, but never became the root's
 * effective view). The correct, standard technique: build a fresh tmpfs at
 * a STAGING path (e.g. `/tmp/newroot`), bind every `requiredFilesystemBinds()`
 * entry and `filesystemBindPath` (if given) into that staging tree at their
 * real absolute sub-paths, `mount --make-rprivate /` (detach from the
 * parent mount namespace's propagation so the pivot never touches the real
 * host), then `pivot_root <staging> <staging>/oldroot` — this ATOMICALLY
 * swaps the process's root to the staging tree and moves the old root out
 * of the way at `/oldroot`, which is then lazily unmounted
 * (`umount -l /oldroot`) so nothing outside the staged tree remains
 * reachable at all. `mount -t proc proc /proc` MUST run AFTER the pivot
 * (procfs is tied to the calling process's pid namespace, and mounting it
 * pre-pivot at a bind-mounted staging path was empirically denied —
 * `--pid --fork` gives the child a genuine fresh pid namespace so the
 * post-pivot mount is permitted). This produces the SAME filesystem view
 * bwrap's `--tmpfs /` + explicit binds produces — verified empirically:
 * `ls /` post-pivot shows only the bound paths' basenames, a foreign path
 * outside every bind is provably absent (`ENOENT`, not merely masked), and
 * `node -e "..."`/`curl` both run correctly through the FHS-compat symlinks
 * `requiredFhsCompatSymlinks()` recreates the same way bwrap's `--symlink`
 * does.
 */
/**
 * A fixed, absolute directory list — NOT the caller's inherited `$PATH` —
 * that every setup command below (`mkdir`, `mount`, `pivot_root`, `umount`,
 * `ln`, `touch`, `ip`) is resolved against (P1-1, ninth review). Without
 * this, the closure's own setup commands are looked up through whatever
 * `$PATH` the calling Node process happened to have — which callers
 * (`bin/scenario-verify.ts`, `bin/scenario-record.ts`, this file's own test
 * suite) do not control end-to-end, and which a repo-local `node_modules/
 * .bin` entry or a malicious connector's own manipulated environment could
 * shadow with a same-named binary, running attacker code with the elevated
 * capabilities (`--map-root-user`) this prelude has. The prelude sets `PATH`
 * to exactly this list as its FIRST statement, before any other command
 * (including `ip link set lo up`) runs.
 */
const TRUSTED_SETUP_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The single fixed exit code every mandatory setup step in
 * `filesystemClosureShellPrelude` uses on failure (distinct from `97`, the
 * existing post-pivot procfs-verification gate's own code, kept unchanged so
 * a caller string-matching on that specific diagnostic is not broken by this
 * fix). Any of these steps failing means the closure did not complete as
 * declared — the exact command's own stderr is included in the message so a
 * caller sees the real kernel/tool-level cause, not just a bare exit code.
 */
const SETUP_STEP_FAILURE_EXIT_CODE = 90;

/**
 * The `req` shell function definition itself — see `reqStatement`'s doc
 * comment for its role. Written and tested as a standalone POSIX/dash
 * snippet (verified directly under `sh` against both a successful and a
 * failing wrapped command before being embedded here) rather than assembled
 * from concatenated fragments, to avoid the nested-quoting mistakes that
 * shape of string-building invites. `$1` (the label) is captured into
 * `__label` before `shift` removes it from `"$@"`, so the wrapped command
 * receives exactly its own argv with no label prefix; `__out=$("$@" 2>&1)`
 * folds the wrapped command's stdout and stderr into one string (verified:
 * `$?` immediately after a command substitution still reflects the
 * substituted command's own exit status, not the assignment's).
 */
const REQ_FUNCTION_DEFINITION =
  'req() { __label="$1"; shift; __out=$("$@" 2>&1); __rc=$?; ' +
  'if [ "$__rc" -ne 0 ]; then ' +
  'echo "pdpp isolation: setup step [$__label] failed (exit $__rc) - $__out" 1>&2; ' +
  `exit ${SETUP_STEP_FAILURE_EXIT_CODE}; fi; }`;

/**
 * The single fixed exit code the post-pivot filesystem-closure verification
 * (new root active, `/oldroot` unreachable, every `ro` bind genuinely
 * read-only) uses on failure — distinct from both `90` (a setup STEP itself
 * failing) and `97` (the pre-existing procfs-specific gate) so a caller can
 * tell which of the three failure classes fired from the exit code alone.
 */
const POST_PIVOT_VERIFICATION_FAILURE_EXIT_CODE = 91;

/**
 * Builds one `req "<label>" <command...>` shell statement — the run-or-die
 * primitive every mandatory setup step below is wrapped in (P1-1, ninth
 * review, requirement (a)). `req` itself (defined once, inline, as the
 * prelude's first real statement after the `PATH` assignment) captures the
 * wrapped command's own stdout+stderr via command substitution and, on a
 * nonzero exit, echoes a diagnostic NAMING THE STEP plus the command's own
 * captured output to stderr, then exits `SETUP_STEP_FAILURE_EXIT_CODE` —
 * replacing the old architecture where every one of these statements ended
 * in `>/dev/null 2>&1` (discarding the exit status AND the diagnostic) and
 * the whole prelude was joined with `;` (so a failure never stopped the next
 * statement from running). A failed `pivot_root` under the OLD prelude meant
 * every statement after it — including `cd /` (which then succeeded against
 * the ORIGINAL host root) and the procfs sentinel (which could then also
 * pass, since the original root's real `/proc` was still mounted) — kept
 * running, and the target command was `exec`'d against the unmodified host
 * filesystem while network/PID/IPC namespaces still existed, so the isolated
 * child looked isolated (namespaces genuinely were) while its filesystem view
 * was NOT (the mount/pivot never took effect). `req` makes that impossible:
 * the very first mandatory step that fails halts the whole script before
 * `exec <target>` is ever reached.
 */
function reqStatement(label: string, command: string): string {
  return `req ${shQuote(label)} ${command}`;
}

/**
 * DEFAULT-DENY FILESYSTEM CLOSURE (unshare mechanism) — STRICT, FAIL-CLOSED
 * VERSION (P1-1, ninth review). Replaces the mask-list architecture
 * (`worldWritableTempDirs`/`ALWAYS_MASKED_DIRS`, removed) that a second,
 * independent review proved cannot terminate: with `--dev-bind / /` still
 * in place, the reachable set was always "every path not yet added to the
 * list," and the reviewer kept finding new members of that set ($HOME/.ssh,
 * a Bitwarden vault socket, the codex-approval control socket — 24 live
 * sockets total) no matter how many directories got masked.
 *
 * A LATER, INDEPENDENT REVIEW (ninth pass) then found that this rewrite's
 * OWN setup sequence was itself fail-OPEN: every statement in the list above
 * (staging tmpfs create+mount, oldroot dir creation, every required bind,
 * every ro remount, the caller's workspace bind, device-node creation and
 * binds, FHS compat symlinks, `mount --make-rprivate /`, `pivot_root`,
 * `umount -l /oldroot`) discarded its own exit status via `>/dev/null 2>&1`
 * and the statements were joined with `;` (unconditional continuation), so a
 * failure ANYWHERE in that sequence — most severely, a failed `pivot_root`
 * itself — left the isolated child executing against the ORIGINAL,
 * UNMODIFIED host filesystem while `recorded_replay: PASS` could still print
 * (the network/PID/IPC namespaces genuinely were isolated; only the
 * filesystem closure silently never took effect). This function closes that:
 * every mandatory step now runs through `req` (see `reqStatement`'s doc
 * comment) — the first failure halts the whole prelude before `exec <target>`
 * is ever reached, PATH is fixed to `TRUSTED_SETUP_PATH` so a repo-local or
 * environment-manipulated binary cannot shadow `mount`/`pivot_root`/`umount`/
 * `mkdir`/`ln`/`touch`, and a POST-PIVOT VERIFICATION block (see
 * `postPivotVerificationStatements`) proves — not merely assumes — that the
 * new root is active, `/oldroot` is genuinely unreachable, and every
 * declared `ro` bind is genuinely read-only, before `exec` runs.
 *
 * MECHANISM otherwise unchanged from the prior version: `--mount --pid
 * --fork` (composing with `--map-root-user --net`) gives the child its own
 * mount AND pid namespace; the `sh -c` prelude performs an actual
 * `pivot_root` (NOT a `mount -t tmpfs tmpfs /` on the existing root, which
 * was tried first and empirically does not change what's visible — see the
 * git history for that repro) — build a fresh tmpfs at a STAGING path,
 * `--rbind` (RECURSIVE bind — see below for why plain `--bind` is
 * insufficient) every `requiredFilesystemBinds()` entry and
 * `filesystemBindPath` (if given) into that staging tree at their real
 * absolute sub-paths, `mount --make-rprivate /`, then `pivot_root <staging>
 * <staging>/oldroot` — ATOMICALLY swaps the process's root and moves the old
 * root out of the way at `/oldroot`, lazily unmounted afterward so nothing
 * outside the staged tree remains reachable at all.
 *
 * `--rbind`, NOT plain `--bind` (P1-1, ninth review — found while building
 * this fix's own forced-failure negative controls, verified against a real
 * privileged container): a plain `mount --bind /etc <staged>` FAILS outright
 * ("wrong fs type, bad option, bad superblock") whenever the source
 * directory itself contains further mount points underneath it — the
 * ordinary case for `/etc` on any container runtime that injects
 * `/etc/resolv.conf`/`/etc/hostname`/`/etc/hosts` as individual bind mounts
 * (confirmed: Docker does this by default; every container this fix was
 * tested against has three such sub-mounts under `/etc`). Under the OLD
 * fail-open prelude this failure was invisible (swallowed by
 * `>/dev/null 2>&1`, and the isolated child then ran with `/etc` either
 * empty or absent inside its new root — a different, also-silent failure
 * mode). `--rbind` recursively carries every sub-mount along with the parent
 * directory, matching what a plain, non-recursive host directory would look
 * like from inside the isolated child, and is a strict superset of what a
 * non-nested source (e.g. `REPO_ROOT`, which has no sub-mounts on any tested
 * host) needs — so it is used uniformly for every entry, not conditionally.
 */
function filesystemClosureShellPrelude(filesystemBindPath: string | undefined, cwd: string | undefined): string {
  const newroot = "/tmp/pdpp-scenario-isolation-newroot";
  const oldroot = `${newroot}/oldroot`;
  const binds = requiredFilesystemBinds();

  const statements: string[] = [
    `PATH=${TRUSTED_SETUP_PATH}`,
    // `req` — see `reqStatement`'s doc comment. Defined once, inline, as a
    // dash/POSIX shell function (this prelude always runs under `sh -c`,
    // which is `/bin/sh` -> `dash` on every host this module targets).
    // `"$@" 2>&1` captures BOTH the wrapped command's stdout and stderr into
    // one string via command substitution (none of these setup commands emit
    // meaningful stdout on success, so folding them together loses nothing);
    // `$?` after the substitution still reflects the wrapped command's own
    // exit status (command substitution does not reset it).
    REQ_FUNCTION_DEFINITION,
    reqStatement("create staging tmpfs directory", `mkdir -p ${shQuote(newroot)}`),
    reqStatement("mount staging tmpfs", `mount -t tmpfs tmpfs ${shQuote(newroot)}`),
    reqStatement("create oldroot directory", `mkdir -p ${shQuote(oldroot)}`),
  ];
  for (const bind of binds) {
    const staged = shQuote(`${newroot}${bind.path}`);
    statements.push(reqStatement(`create bind mountpoint ${bind.path}`, `mkdir -p ${staged}`));
    statements.push(reqStatement(`bind ${bind.path}`, `mount --rbind ${shQuote(bind.path)} ${staged}`));
    if (bind.mode === "ro") {
      statements.push(reqStatement(`remount ${bind.path} read-only`, `mount -o remount,ro,bind ${staged}`));
    }
  }
  if (filesystemBindPath !== undefined) {
    const staged = shQuote(`${newroot}${filesystemBindPath}`);
    statements.push(reqStatement("create workspace bind mountpoint", `mkdir -p ${staged}`));
    statements.push(reqStatement("bind workspace", `mount --rbind ${shQuote(filesystemBindPath)} ${staged}`));
  }
  // Sandbox-local writable scratch subdirectories (HOME/TMPDIR/XDG_CACHE_HOME
  // — see `sandboxScratchEnv()`) are created on the REAL host filesystem by
  // `ensureSandboxScratchDirs()` before this process is even spawned (see
  // `spawnWithNetworkIsolation`), not staged here — `filesystemBindPath` is
  // bind-mounted as a LIVE view of the real directory (confirmed empirically:
  // a directory created inside a bind-mounted copy appears at the real host
  // path too, since a bind mount is a second reference to the same inode, not
  // a snapshot), so whatever already exists there before the bind runs is
  // exactly what the isolated child sees — no separate staging step needed,
  // and this keeps the unshare and bwrap mechanisms' scratch-dir handling
  // identical (bwrap has no shell prelude to run an extra `mkdir` in).
  //
  // /dev: individual device-node binds, not a whole-/dev bind — a bare
  // `mount --bind /dev <staged>` was empirically denied in a nested
  // container test environment even with full capabilities, while binding
  // specific device files (the small, fixed set a connector/curl/node
  // actually opens) works everywhere and is itself a narrower, more
  // default-deny-consistent exposure than the whole host /dev tree.
  const stagedDev = shQuote(`${newroot}/dev`);
  statements.push(reqStatement("create staging /dev directory", `mkdir -p ${stagedDev}`));
  for (const device of ["null", "zero", "urandom", "random", "tty"]) {
    const stagedDevice = shQuote(`${newroot}/dev/${device}`);
    statements.push(reqStatement(`create device node placeholder /dev/${device}`, `touch ${stagedDevice}`));
    statements.push(
      reqStatement(`bind device /dev/${device}`, `mount --bind ${shQuote(`/dev/${device}`)} ${stagedDevice}`)
    );
  }
  // See requiredFhsCompatSymlinks()'s doc comment: /bin, /lib, /lib64, ...
  // are top-level symlinks into /usr on a merged-usr host, not covered by
  // binding /usr itself — recreated inside the staging tree so they exist
  // at the right paths once it becomes the root. `ln -sfn` itself cannot
  // meaningfully fail here (the target directory was just created by the
  // staging steps above) but is still run through `req` for the same
  // "no undiagnosed silent failure" discipline as everything else.
  for (const symlink of requiredFhsCompatSymlinks()) {
    statements.push(
      reqStatement(
        `create FHS compat symlink ${symlink.path}`,
        `ln -sfn ${shQuote(symlink.target)} ${shQuote(`${newroot}${symlink.path}`)}`
      )
    );
  }
  // Written into the STAGING tree, immediately before pivot_root — see
  // `postPivotVerificationStatements`'s doc comment, property 1: this file's
  // presence at `/pdpp-isolation-canary` AFTER the pivot is what proves the
  // effective root actually changed, rather than assuming a zero pivot_root
  // exit code means the change took effect.
  statements.push(
    reqStatement("create post-pivot root canary", `touch ${shQuote(`${newroot}/pdpp-isolation-canary`)}`)
  );
  statements.push(reqStatement("make root mount propagation private", "mount --make-rprivate /"));
  statements.push(reqStatement("pivot_root into staging tree", `pivot_root ${shQuote(newroot)} ${shQuote(oldroot)}`));
  // CWD (R9): the caller's requested `spawnOpts.cwd` only sets the working
  // directory of the `unshare` PROCESS ITSELF — Node's `spawn(cmd, args,
  // { cwd })` has no reach into the shell script this process later
  // execs into (see `spawnWithNetworkIsolation`'s `unshare` branch), so a
  // bare `cd /` here unconditionally discarded whatever cwd the caller
  // asked for. The real production call site (`bin/scenario-verify.ts`'s
  // `runReplaySubprocess`) always sets `cwd: PACKAGE_ROOT`, a path under
  // `REPO_ROOT` — already staged read-only by the bind loop above — so no
  // extra staging is needed here, only a `cd` into it AFTER the pivot.
  // NOT routed through `req`/`reqStatement`: `req` captures its wrapped
  // command's output via `$(...)` command substitution, which POSIX runs in
  // a SUBSHELL — a `cd` inside that subshell only changes ITS OWN cwd and
  // evaporates when the subshell exits, leaving the outer script (and the
  // `exec <target>` that follows it) at whatever cwd it had before, not the
  // requested one (confirmed empirically: this exact mistake was the first
  // version of this fix, and it left the exec'd child with a cwd made
  // invalid by pivot_root, crashing with ENOENT on the first
  // `process.cwd()` call rather than silently landing at `/`). `cd` must run
  // directly in the current shell; failure is still checked and still fails
  // closed (exit `SETUP_STEP_FAILURE_EXIT_CODE`), matching every other
  // mandatory step's severity.
  statements.push(
    cwd === undefined
      ? "cd /"
      : `cd ${shQuote(cwd)} || { echo "pdpp isolation: setup step [cd into requested cwd] failed" 1>&2; exit ${SETUP_STEP_FAILURE_EXIT_CODE}; }`
  );
  // Mounted AFTER pivot_root — see this function's doc comment for why a
  // pre-pivot procfs mount at the staging path is denied. mkdir it here,
  // immediately before the mount that needs it.
  //
  // This step keeps its OWN pre-existing verification shape (exit 97, not
  // the generic `req` helper) — see `procMountVerifyStatements()`'s doc
  // comment for the full "advertise-vs-honor" history this specific check
  // closes, and why its diagnostic is captured via inline command
  // substitution rather than a temp file (post-pivot_root, no `/tmp` exists
  // in the new root at all). `mkdir -p /proc` itself is now ALSO run through
  // `req` first (P1-1, ninth review) — the old version folded it into the
  // same swallowed statement as the mount+verify, so a failure creating the
  // mountpoint itself (as opposed to the mount or the read-back) produced no
  // distinguishable diagnostic.
  statements.push(reqStatement("create /proc mountpoint", "mkdir -p /proc"));
  statements.push(
    `procfail=$(${procMountVerifyStatements().slice(1).join(" && ")} 2>&1 >/dev/null); ` +
      `if [ "$?" -ne 0 ]; then echo "pdpp isolation: PID-namespace procfs mount failed, refusing to run isolated — $procfail" 1>&2; exit 97; fi`
  );
  statements.push(reqStatement("detach old root", "umount -l /oldroot"));
  statements.push(...postPivotVerificationStatements(binds));
  return statements.join("; ");
}

/**
 * POST-PIVOT VERIFICATION (P1-1, ninth review, requirement (c)) — proves,
 * rather than assumes, that the filesystem closure actually took effect,
 * run as the LAST gate before `exec <target>` (see `spawnWithNetworkIsolation`'s
 * unshare branch). Every check here uses only shell builtins (`[`, `set --`
 * globbing) — no external binary — so it cannot itself be defeated by a
 * shadowed/missing tool the way the setup steps above could be before
 * `TRUSTED_SETUP_PATH` was introduced.
 *
 * Three independent properties, matching the review's requirement exactly:
 *   1. NEW ROOT ACTIVE — `/` is the staged tmpfs, not the original host
 *      root. Checked via `/pdpp-isolation-canary`, a file this function
 *      writes into the STAGING tree (i.e. it will exist at `/` once the
 *      pivot succeeds) immediately before `pivot_root` runs — if `pivot_root`
 *      silently failed to change the effective root (the exact false-success
 *      shape the review's `(a)` scenario describes), this file would be
 *      absent from the now-still-original `/`.
 *   2. `/oldroot` UNREACHABBLE — after `umount -l /oldroot`, the directory
 *      itself remains (as an empty mountpoint stub — `umount` removes the
 *      MOUNT, not the directory entry) but must contain NOTHING: `set --
 *      /oldroot/*` glob-expands to the literal string `/oldroot/*` (unmatched)
 *      when the directory is empty, and dash leaves `$1` as that literal
 *      unexpanded pattern in that case — `[ -e "$1" ]` against the literal
 *      pattern string then correctly reports "does not exist" only when the
 *      directory is genuinely empty (proven empirically: matches Linux's
 *      documented behavior for `umount -l` — the lazy detach leaves an empty,
 *      unmounted directory, not a leftover reachable filesystem view).
 *   3. EVERY DECLARED `ro` BIND IS ACTUALLY READ-ONLY — attempts to `touch`
 *      a real probe file under each `ro`-mode bind's real path; success (the
 *      touch did NOT fail) means the remount-ro step from setup did not
 *      actually take effect for that specific path, which is exactly
 *      scenario (b) in the review's false-success list (a preceding bind
 *      remains writable and nothing verifies it). The probe file itself is
 *      removed immediately after a successful write (defense in depth — the
 *      isolated child is about to be torn down/killed anyway, but leaving a
 *      stray file in `/usr` or `/etc` if this check ever legitimately fires
 *      would be an unrelated mess on top of a real security finding).
 *
 * Any failure here uses `POST_PIVOT_VERIFICATION_FAILURE_EXIT_CODE` (91),
 * distinguishing it from a setup STEP failing (90) or the procfs-specific
 * gate (97) — the diagnostic names exactly which of the three properties
 * failed.
 */
export function postPivotVerificationStatements(binds: readonly FilesystemBind[]): string[] {
  const statements: string[] = [];
  const roBindPaths = binds.filter((b) => b.mode === "ro").map((b) => b.path);
  const roCheck = roBindPaths
    .map((path) => {
      const probe = shQuote(`${path}/.pdpp-isolation-ro-probe-$$`);
      return `if touch ${probe} 2>/dev/null; then rm -f ${probe} 2>/dev/null; echo ${shQuote(path)}; fi`;
    })
    .join("; ");
  statements.push(
    "__canary_ok=1; [ -e /pdpp-isolation-canary ] || __canary_ok=0; " +
      `__oldroot_leftover=$(set -- /oldroot/*; if [ -e "$1" ]; then echo "$1"; fi); ` +
      `__writable_ro=$(${roCheck || "true"}); ` +
      `if [ "$__canary_ok" -ne 1 ] || [ -n "$__oldroot_leftover" ] || [ -n "$__writable_ro" ]; then ` +
      `echo "pdpp isolation: post-pivot verification failed — new-root-active=$__canary_ok oldroot-leftover=[$__oldroot_leftover] writable-ro-binds=[$__writable_ro]" 1>&2; ` +
      `exit ${POST_PIVOT_VERIFICATION_FAILURE_EXIT_CODE}; fi`
  );
  return statements;
}

function bwrapFilesystemClosureArgs(filesystemBindPath: string | undefined): string[] {
  const args: string[] = [
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--tmpfs",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];
  for (const bind of requiredFilesystemBinds()) {
    args.push(bind.mode === "ro" ? "--ro-bind" : "--bind", bind.path, bind.path);
  }
  // See requiredFhsCompatSymlinks()'s doc comment: recreated as symlinks,
  // not binds, mirroring what these paths actually are on the real host.
  for (const symlink of requiredFhsCompatSymlinks()) {
    args.push("--symlink", symlink.target, symlink.path);
  }
  if (filesystemBindPath !== undefined) {
    args.push("--bind", filesystemBindPath, filesystemBindPath);
  }
  return args;
}

/**
 * Creates the sandbox-local writable scratch subdirectories (see
 * `SANDBOX_SCRATCH_SUBDIRS`/`sandboxScratchEnv()`) on the REAL host
 * filesystem, under `filesystemBindPath`, before the isolated child is
 * spawned. Both mechanisms bind `filesystemBindPath` as a live view of the
 * real directory (bwrap's `--bind`, unshare's `mount --rbind` in
 * `filesystemClosureShellPrelude`), so whatever exists here before that bind
 * runs is exactly what the isolated child sees — creating them host-side,
 * once, covers both mechanisms identically without bwrap needing a shell
 * prelude of its own. `recursive: true` makes this a no-op on a second call
 * for the same workspace (idempotent, matching every other setup step in
 * this module). A no-op (nothing created) when `filesystemBindPath` is
 * `undefined` — same as `sandboxScratchEnv()`'s own no-op behavior in that
 * case.
 */
function ensureSandboxScratchDirs(filesystemBindPath: string | undefined): void {
  if (filesystemBindPath === undefined) {
    return;
  }
  const scratch = sandboxScratchPaths(filesystemBindPath);
  for (const dir of [scratch.home, scratch.tmp, scratch.xdgCache]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * GUARD (test-facing): the exact bwrap argv `spawnWithNetworkIsolation`
 * will invoke for a given `filesystemBindPath`, WITHOUT spawning anything —
 * so `isolation-mechanism.test.ts` can assert, mechanically, that no future
 * edit reintroduces `--dev-bind / /` or a bind outside
 * `requiredFilesystemBinds()`/`filesystemBindPath`. Kept in sync with the
 * `"bwrap"` branch of `spawnWithNetworkIsolation` by construction: both call
 * this same function.
 */
export function bwrapArgvForFilesystemClosure(
  cmd: string,
  args: readonly string[],
  filesystemBindPath: string | undefined
): string[] {
  const innerCommand = [cmd, ...args].map(shQuote).join(" ");
  return ["--unshare-net", ...bwrapFilesystemClosureArgs(filesystemBindPath), "--", "sh", "-c", `exec ${innerCommand}`];
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
  ensureSandboxScratchDirs(filesystemBindPath);
  const mechanism = isolate === true ? detectMechanism() : isolate;
  if (mechanism === "bwrap") {
    return spawn("bwrap", bwrapArgvForFilesystemClosure(cmd, args, filesystemBindPath), spawnOpts);
  }
  const innerCommand = [cmd, ...args].map(shQuote).join(" ");
  // `spawnOpts.cwd` (a `string | URL | undefined` per `SpawnOptions`) is
  // normalized to a plain string here — see `filesystemClosureShellPrelude`'s
  // cwd handling for why the shell script needs it explicitly rather than
  // relying on Node's own `cwd` spawn option.
  const requestedCwd = spawnOpts.cwd === undefined ? undefined : String(spawnOpts.cwd);
  const closurePrelude = filesystemClosureShellPrelude(filesystemBindPath, requestedCwd);
  // `ip link set lo up` runs BEFORE the filesystem closure's pivot_root,
  // while the real host filesystem (and therefore /usr/sbin/ip) is still
  // the process's root — avoids any dependency on `ip` resolving correctly
  // through the freshly-staged root's bound paths. Resolved through
  // `TRUSTED_SETUP_PATH` (P1-1, ninth review), same as every filesystem-
  // closure setup command, rather than the caller's inherited `$PATH` — `ip`
  // failing here is not fatal (no route to bring up loopback would simply
  // mean the UDS bridge, which doesn't need it, still works, while a TCP
  // loopback bridge would not — an existing, unchanged tradeoff this fix
  // does not alter), so it intentionally stays a best-effort step, not
  // wrapped in `req`.
  const shScript = `PATH=${TRUSTED_SETUP_PATH}; ip link set lo up >/dev/null 2>&1; ${closurePrelude}; exec ${innerCommand}`;
  return spawn(
    "unshare",
    ["--map-root-user", "--net", "--mount", "--pid", "--ipc", "--uts", "--fork", "--", "sh", "-c", shScript],
    spawnOpts
  );
}
