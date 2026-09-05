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
 * REMAINING GAP, RECONCILED (P1, external review of ab415be6c): default-deny
 * closes reachability for a FOREIGN path outside the derived set, but a `ro`
 * bind (the derived set's own entries, including `REPO_ROOT`) only blocks
 * WRITES — a socket file that ALREADY EXISTS somewhere under `REPO_ROOT` (or
 * any other `ro` bind) at spawn time stays dialable, `connect()` needing no
 * write permission. Recursive read-only (`recursiveReadOnlyRemountCommand`)
 * closes the ability to CREATE a new one during a run, turning this into a
 * finite, checkable precondition rather than an open-ended exception:
 * `findPreexistingSocketsUnderReadOnlyBinds()` scans for exactly this
 * before every spawn, and `bin/scenario-verify.ts` withholds
 * `recorded_replay` — naming the exact path — whenever the scan finds one.
 * See that function's own doc comment for the full mechanism.
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
 * FOREIGN socket outside that set — see PATHNAME-UDS ESCAPE above — AND,
 * recursively, every submount under a `ro` bind, not just its top mount —
 * see `recursiveReadOnlyRemountCommand`; a pre-existing socket already
 * inside a `ro` bind at spawn time is a separate, RECONCILED case, checked
 * per-run by `findPreexistingSocketsUnderReadOnlyBinds()`, not something
 * this static filesystem view alone closes), SysV IPC
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
import {
  accessSync,
  constants,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
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
 * The same fixed, absolute directory list as `TRUSTED_SETUP_PATH`, as an
 * array — used by `resolveTrustedLauncherPath` below to find the LAUNCHER
 * binaries themselves (`unshare`, `bwrap`, and — P1-1, external review of
 * ced8300be, see that function's doc comment — the `sh` interpreter those
 * launchers exec into), not the setup commands the launched shell script
 * runs. Kept as a literal array (not derived by splitting
 * `TRUSTED_SETUP_PATH`) so the two stay independently readable at their own
 * call sites, but the values are the same list for the same reason: this is
 * the operating system's own set of locations for trusted, privileged system
 * binaries, nothing caller- or environment-specific.
 */
const TRUSTED_LAUNCHER_DIRECTORIES: readonly string[] = ["/usr/sbin", "/usr/bin", "/sbin", "/bin"];

/**
 * TRUSTED LAUNCHER RESOLUTION (P1, external review of ab415be6c) — resolves
 * the `unshare`/`bwrap` binary this module actually spawns to ONE fixed,
 * absolute path, found by walking `TRUSTED_LAUNCHER_DIRECTORIES` in order,
 * rather than letting `node:child_process`'s `spawn`/`spawnSync` resolve a
 * bare command NAME through the calling process's own inherited `$PATH`.
 *
 * WHAT THIS CLOSES: before this fix, `probeUnshare()`/`probeBwrap()` (the
 * CAPABILITY CHECK) and `spawnWithNetworkIsolation` (the REAL EXECUTION)
 * both called `spawnSync("unshare", ...)`/`spawn("bwrap", ...)` — a bare
 * command name. Node resolves a bare command name by searching the
 * CALLING PROCESS's own `PATH` environment variable, entry by entry, and
 * uses the FIRST match — exactly the same "attacker prepends a directory
 * ahead of the real one" shape `TRUSTED_SETUP_PATH` already closes for the
 * commands INSIDE the isolated child's own setup script (`mount`,
 * `pivot_root`, ...), but that fix never touched the launcher itself: a
 * caller (or a compromised connector's own environment mutation, since this
 * package's own subprocess env construction is caller-controlled) could
 * still prepend a directory containing a same-named `unshare` or `bwrap` to
 * `process.env.PATH` before this module ran, and that fake binary — not the
 * real, trusted one — is what actually got spawned with this process's own
 * privileges. Both the capability PROBE and the real EXECUTION resolved the
 * bare name independently, so a caller could even see a probe report
 * `available: true` against the REAL binary, then have the real spawn moments
 * later silently run the FAKE one instead (or vice versa) if `PATH` changed
 * in between — this fix removes that gap entirely by resolving once, from a
 * `PATH`-independent source of truth, and threading the SAME resolved
 * absolute path through both call sites.
 *
 * RESOLUTION: walks `TRUSTED_LAUNCHER_DIRECTORIES` in the FIXED order given
 * — never the caller's `$PATH`, never any other environment-derived list —
 * and returns the first `${dir}/${name}` that exists and is executable
 * (`X_OK`). A symlink at that path (e.g. a merged-usr host's `/bin/unshare`
 * pointing into `/usr/bin/unshare`, or vice versa) is followed to its real
 * target via `realpathSync` before being returned, so the value callers spawn
 * is always a concrete file, not a path whose target could be swapped out
 * from under a cached lookup by re-pointing a symlink. Throws (fails closed,
 * never silently falls back to a bare, PATH-resolved name) when NO trusted
 * directory has the binary — a host missing `unshare`/`bwrap` entirely from
 * every trusted location cannot isolate, and this module must say so loudly
 * rather than let `spawn` fall through to an unaudited `$PATH` lookup as an
 * implicit fallback.
 *
 * CACHED per (name), computed once per process — the trusted directories are
 * fixed, real filesystem locations, not expected to change during a single
 * run, and this resolution runs on every probe and every isolated spawn, so
 * memoizing avoids repeating four `existsSync`+`accessSync` checks (up to
 * eight, across both binaries) on every single replay run in a scenario with
 * many runs.
 *
 * `"sh"` (P1-1, external review of ced8300be) — a THIRD name resolved through
 * this exact allowlist, for exactly the same reason as `unshare`/`bwrap`
 * themselves. WHAT THIS CLOSES: before this fix, both `unshareProcMountProbeArgv()`
 * (the probe) and `spawnWithNetworkIsolation`'s `unshare` branch (the real
 * execution) passed the bare string `"sh"` as an argv entry to the already-
 * trusted, absolute-path `unshare` binary — `unshare --map-root-user --net
 * ... -- sh -c <script>`. `unshare` itself then `execvp("sh", ...)`s that
 * argv entry, and `execvp` on a bare name (no `/`) resolves it through the
 * PATH environment variable of the process performing the exec — which, at
 * that moment, is whatever `PATH` this Node process's `spawn()` call handed
 * to the `unshare` child (this package's own subprocess-env construction,
 * fully caller-controlled), NOT `TRUSTED_SETUP_PATH`. `TRUSTED_SETUP_PATH` is
 * assigned as the FIRST STATEMENT INSIDE the shell script that bare `sh` is
 * asked to interpret — so it can only take effect once a trustworthy `sh` is
 * already running it; it does nothing to select WHICH `sh` runs it in the
 * first place. Confirmed empirically in a privileged test container: with
 * `/tmp/fakebin` (holding a fake `sh` that touches a marker file and execs
 * the real `/bin/sh`) prepended to `PATH`, `unshare --map-root-user --net
 * --mount --pid --ipc --uts --fork -- sh -c 'echo hi'` ran the FAKE `sh`
 * first (marker file present) — the exact "PATH-prepended fake sh satisfies
 * the probe sentinel, or replaces the real closure script's interpreter at
 * execution time" attack the review describes, closed by passing
 * `resolveTrustedLauncherPath("sh")`'s absolute result (e.g. `/bin/sh`) as
 * the argv entry instead of the bare string `"sh"` — same empirical test with
 * the absolute path in place: fake `sh` never runs, marker absent. Applied at
 * all three call sites that build a `sh -c` argv for a launcher to exec:
 * `unshareProcMountProbeArgv()` (the probe), `bwrapArgvForFilesystemClosure()`
 * (bwrap's own inner `sh -c` — lower risk in isolation, since it runs inside
 * bwrap's already-closed filesystem view where only `requiredFilesystemBinds()`
 * entries are visible, but the review's fix applies to "both the probe and
 * execution" without carving out bwrap, and the same PATH-inheritance
 * mechanism applies identically to bwrap's own child-argv exec), and
 * `spawnWithNetworkIsolation`'s `unshare` branch (the real execution the
 * review's repro targets).
 */
const trustedLauncherPathCache = new Map<string, string>();

/** Exported for `isolation-mechanism.test.ts`'s direct unit-level proof that
 *  resolution is `$PATH`-independent — production code never needs to call
 *  this from outside the module, every internal call site already does. */
export function resolveTrustedLauncherPath(name: "unshare" | "bwrap" | "sh"): string {
  const cached = trustedLauncherPathCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  for (const dir of TRUSTED_LAUNCHER_DIRECTORIES) {
    const candidate = join(dir, name);
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const resolved = realpathSync(candidate);
    trustedLauncherPathCache.set(name, resolved);
    return resolved;
  }
  throw new Error(
    `pdpp isolation: trusted launcher '${name}' not found in any trusted location (${TRUSTED_LAUNCHER_DIRECTORIES.join(", ")}) — refusing to fall back to a PATH-resolved lookup`
  );
}

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
  // TRUSTED SHELL (P1-1, external review of ced8300be): resolved via
  // resolveTrustedLauncherPath("sh"), never the bare string "sh" — see that
  // function's doc comment. unshare execs this argv entry via execvp, which
  // resolves a bare name through the calling process's own inherited PATH,
  // not TRUSTED_SETUP_PATH (that assignment is a statement INSIDE the script
  // this shell is asked to interpret, too late to matter here).
  return [
    "--map-root-user",
    "--net",
    "--mount",
    "--pid",
    "--ipc",
    "--uts",
    "--fork",
    "--",
    resolveTrustedLauncherPath("sh"),
    "-c",
    script,
  ];
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
  let unsharePath: string;
  try {
    unsharePath = resolveTrustedLauncherPath("unshare");
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const probe = spawnSync(unsharePath, unshareProcMountProbeArgv(), {
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
  let bwrapPath: string;
  try {
    bwrapPath = resolveTrustedLauncherPath("bwrap");
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const probeWorkspace = mkdtempSync(join(tmpdir(), "pdpp-isolation-bwrap-probe-"));
  try {
    const probe = spawnSync(bwrapPath, bwrapArgvForFilesystemClosure("true", [], probeWorkspace), {
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

/**
 * PRE-EXISTING-SOCKET SCAN — reconciles the repository-UDS exception (P1,
 * external review of ab415be6c). Recursive read-only (see
 * `recursiveReadOnlyRemountCommand`) closes writes into any `ro` bind's
 * submounts, but a `ro` bind only blocks WRITES, not reads/dials: a Unix
 * domain socket file that ALREADY EXISTS somewhere under a `ro` bind at
 * spawn time (most concretely, anywhere under `REPO_ROOT`) stays perfectly
 * DIALABLE from inside the isolated child — `connect()` to an existing UDS
 * needs no write permission on the socket or its containing directory,
 * confirmed empirically (a `curl --unix-socket` against a real
 * `REPO_ROOT`-internal socket succeeds even with both the trusted-launcher
 * and recursive-ro fixes applied). Recursive read-only genuinely closes the
 * other half of this FROM INSIDE THE SANDBOX: an isolated CONNECTOR cannot
 * CREATE a new socket anywhere under a `ro` bind once every submount is
 * genuinely read-only.
 *
 * WHAT THIS SCAN DOES NOT CLOSE — CORRECTED CLAIM (P1-2, external review of
 * ced8300be): an earlier version of this doc comment claimed "nothing new
 * can appear under a ro bind while replay runs." That OVERSTATES what
 * recursive read-only actually proves: a `ro` bind stops the SANDBOX (the
 * isolated child itself) from creating a new socket there — it says nothing
 * about the HOST. A ro BIND is a property of the isolated child's OWN mount
 * namespace; the SOURCE directory it was bound from (e.g. the real
 * `REPO_ROOT` on disk) remains an ordinary, writable directory to every
 * OTHER process on the same machine that is NOT inside this sandbox — a
 * separate host process (the calling user's own shell, a build script, a
 * completely unrelated program run by the same user) can create a socket
 * under that source directory at any time, and the isolated child would see
 * it appear the moment the host process creates it (a bind mount is a live
 * view of the same inode, not a snapshot — see `filesystemClosureShellPrelude`'s
 * own doc comment on this same property, used there to explain why the
 * SCRATCH directories don't need separate staging). So "the sandbox cannot
 * create a socket here" is proven; "no socket can appear here during this
 * run" is not — the true claim is narrower, and this scan's own TOCTOU
 * narrowing (running it AGAIN, in-namespace, at two later points — see
 * `inNamespaceSocketScanStatement`) exists specifically because this
 * function alone, run once from the host before any run starts, cannot make
 * the broader claim honest.
 *
 * That turns what was an open-ended "the closure isn't universal inside the
 * repo bind" gap into a FINITE, checkable precondition per scan: enumerate
 * every socket under a `ro` bind at the moment this function runs, and if
 * the scan finds ANY (or cannot fully enumerate a subtree — see
 * `SocketScanResult.complete` below), that specific run cannot honestly
 * claim the OS-isolation boundary is airtight — the finding is fed into the
 * `recorded_replay` eligibility decision (see
 * `bin/scenario-verify.ts`'s `isolationEvidenceBoundaryProven` wiring),
 * withholding the strong claim and naming the exact socket path (or the
 * exact unreadable path), rather than silently accepting an unbounded,
 * undocumented exception forever.
 *
 * BOUNDED, not a mask list: this is the opposite shape from the
 * `worldWritableTempDirs` mask-list architecture this module's own module
 * doc comment explains was proven unable to terminate — that list tried to
 * enumerate every directory a FOREIGN socket might live under, which is
 * unbounded in principle. This scan instead enumerates every socket that
 * ALREADY EXISTS under the module's OWN finite, derived bind set right now,
 * a concrete, checkable fact about THIS moment, not a guess about what a
 * foreign process might place somewhere in the future.
 *
 * Does not follow symlinks (`Dirent.isSymbolicLink()` entries are skipped
 * entirely, neither descended into nor stat'd as a socket themselves) —
 * matches every other traversal in this module's own filesystem-closure
 * logic, which never follows a symlink outside the bind it was found under,
 * and avoids a symlink cycle turning this bounded scan unbounded.
 *
 * FAILS CLOSED ON AN UNREADABLE SUBTREE (P1-2, external review of
 * ced8300be) — an earlier version caught `readdirSync`'s `EACCES` and simply
 * `return`ed from that subtree, silently treating "I could not see in here"
 * as "nothing here": a fail-OPEN default given this scan's entire purpose is
 * to justify a strong claim. Confirmed empirically, as an unprivileged user:
 * a directory the scanning process cannot LIST — whether `chmod 000`
 * (neither read nor search) or `chmod 311` (search/execute permitted, read
 * permission absent — a directory can be SEARCHED without being LISTABLE,
 * genuinely separate DAC bits) — makes `readdirSync` throw `EACCES`
 * identically in both cases, while a socket with a KNOWN name inside a
 * `311` directory stays fully connectable (confirmed live: a client
 * successfully dialed a socket under a `chmod 311` directory this scan
 * could not enumerate). `SocketScanResult.complete` is `false` whenever ANY
 * subtree could not be fully enumerated, distinct from `sockets` (what was
 * actually found) — a caller must treat `complete: false` as withholding
 * the strong claim exactly like a non-empty `sockets` array, never as
 * "scanned clean."
 *
 * SCOPED TO USER-WRITABLE `ro` BINDS, NOT EVERY `requiredFilesystemBinds()`
 * ENTRY: `/usr` and `/etc` are excluded — confirmed empirically, walking
 * `/usr` alone costs ~700ms (690k entries) on a typical dev host, more than
 * 4x `REPO_ROOT`'s own cost, for a check that cannot find anything real. A
 * socket under `/usr`/`/etc` requires root (or an OS package/container-build
 * step) to plant — this module's own DAC reasoning elsewhere already treats
 * that as outside its threat model ("no new privilege, since DAC still
 * applies... the isolated child runs as the same real UID as the parent" —
 * see `FilesystemBind`'s doc comment), the same way a root-capable attacker
 * could defeat this whole isolation boundary by many other means. `REPO_ROOT`
 * (the repo checkout, writable by the calling user's own build/checkout
 * process — the ACTUAL exception the external review named), `nodeDir` (a
 * per-user version-manager install, e.g. under `~/.local/share/mise/...`),
 * and the Playwright browser cache (also under the user's `$HOME`) are all
 * scanned — every bind ordinarily writable by the SAME user this process
 * itself runs as, which is the set that could plausibly have a socket
 * planted under it without root.
 */
const SOCKET_SCAN_EXCLUDED_SYSTEM_PATHS: readonly string[] = ["/usr", "/etc"];

/**
 * Result contract for `findPreexistingSocketsUnderReadOnlyBinds()` (P1-2,
 * external review of ced8300be) — replaces a bare `readonly string[]`
 * specifically so "found nothing" and "could not fully enumerate" are
 * structurally distinct, never collapsible into the same falsy-array shape.
 */
export interface SocketScanResult {
  /** `false` whenever ANY scanned subtree could not be fully enumerated
   *  (an `EACCES` on `readdirSync`, from either a `000` or a `311`
   *  directory — see this module's own doc comment above for why both fail
   *  identically here). A caller MUST treat `complete: false` as
   *  withholding the strong `recorded_replay` claim, exactly like a
   *  non-empty `sockets` array — it does NOT mean "scanned clean." */
  complete: boolean;
  /** Absolute paths of every directory the scan could not enumerate, one
   *  entry per unreadable subtree encountered — named explicitly so a
   *  withheld claim's limitation string can point at the exact path,
   *  matching this module's "fail loud, name the path" discipline
   *  elsewhere (e.g. `buildPreexistingSocketLimitation`). Empty whenever
   *  `complete` is `true`. */
  errors: readonly string[];
  /** Absolute paths of every socket the scan actually found. */
  sockets: readonly string[];
}

export function findPreexistingSocketsUnderReadOnlyBinds(): SocketScanResult {
  const sockets: string[] = [];
  const errors: string[] = [];
  for (const bind of requiredFilesystemBinds()) {
    if (SOCKET_SCAN_EXCLUDED_SYSTEM_PATHS.includes(bind.path)) {
      continue;
    }
    walkForSockets(bind.path, sockets, errors);
  }
  return { sockets, complete: errors.length === 0, errors };
}

function walkForSockets(dir: string, found: string[], errors: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // FAIL CLOSED (P1-2, external review of ced8300be): an unreadable
    // subtree — whether `EACCES` from a `000` (unsearchable) or a `311`
    // (searchable but unlistable) directory — is recorded as an
    // enumeration failure, NOT silently treated as "nothing here." See
    // this module's own doc comment above for the empirical proof that a
    // `311` directory's unlistable contents remain fully connectable.
    errors.push(dir);
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkForSockets(entryPath, found, errors);
      continue;
    }
    if (entry.isSocket()) {
      found.push(entryPath);
    }
  }
}

/**
 * Drops any bind whose path is identical to, or a filesystem descendant of,
 * ANOTHER entry in the list, regardless of which was declared first —
 * binding both would either be a harmless redundant mount or (worse) a `rw`
 * ancestor accidentally masking a narrower `ro` intent.
 *
 * SORTED BY DEPTH FIRST (P1, external review of ab415be6c's recursive-ro
 * fix): the old version was order-preserving ("first occurrence wins" —
 * whichever entry appeared EARLIER in `requiredFilesystemBinds()`'s literal
 * array kept its bind, even if a LATER, broader ancestor entry would have
 * covered it). That was harmless under the old top-level-only `remount,ro,
 * bind`, where a redundant nested bind was merely wasteful. It stopped being
 * harmless once `recursiveReadOnlyRemountCommand` started walking
 * `/proc/self/mountinfo` for submounts of each `ro` bind: a real, concrete
 * case (confirmed empirically in a privileged test container) is `nodeDir`
 * (`dirname(process.execPath)`, e.g. `/usr/local/bin` under a container's
 * default Node install) being declared BEFORE `/usr` in
 * `requiredFilesystemBinds()`'s literal array — the old dedup kept BOTH as
 * separate top-level binds, so `/usr`'s own `--rbind` then ALSO recursively
 * picked up the already-separately-staged `/usr/local/bin` mount as one of
 * its own submounts, and the new recursive-remount walk tried to remount
 * that same mount point a second time, which failed outright ("mount point
 * not mounted or bad option" — the first remount had already changed its
 * mount ID out from under the second). Sorting shortest-path-first before
 * deduping means the BROADEST ancestor (`/usr`) is always considered first
 * regardless of declaration order, so a narrower descendant (`nodeDir`) is
 * correctly absorbed into it rather than staying a separate, redundant bind
 * that the parent's own recursive walk then double-processes.
 */
function dedupeBinds(binds: readonly FilesystemBind[]): FilesystemBind[] {
  const normalized = binds.map((bind, index) => ({ ...bind, index, path: resolve(bind.path) }));
  // Depth-sorted only to DECIDE which entries survive — the broadest
  // ancestor must be considered first regardless of declaration order (see
  // this function's doc comment). The final return value is re-sorted back
  // to original declaration order below, which is what every caller
  // (the bind loop in filesystemClosureShellPrelude, bwrap's argv builder)
  // expects for stable, readable generated output.
  const sortedByDepth = [...normalized].sort((a, b) => a.path.length - b.path.length);
  const kept: typeof normalized = [];
  for (const bind of sortedByDepth) {
    const alreadyCovered = kept.some(
      (existing) => bind.path === existing.path || bind.path.startsWith(`${existing.path}${sep}`)
    );
    if (!alreadyCovered) {
      kept.push(bind);
    }
  }
  return kept.sort((a, b) => a.index - b.index).map(({ path, mode }) => ({ path, mode }));
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
 * The single fixed exit code the IN-NAMESPACE socket scan
 * (`inNamespaceSocketScanStatement`) uses on failure — distinct from `90`
 * (a setup step), `91` (post-pivot verification), and `97` (the procfs
 * gate), so a caller can tell this specific failure class apart from the
 * others by exit code alone. Covers BOTH failure shapes the scan reports:
 * a genuine pre-existing socket found, or a subtree the scan could not
 * fully enumerate (P1-2, external review of ced8300be — see
 * `inNamespaceSocketScanStatement`'s doc comment).
 */
const IN_NAMESPACE_SOCKET_SCAN_FAILURE_EXIT_CODE = 92;

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
 *
 * RECURSIVE READ-ONLY (P1, external review of ab415be6c): `--rbind` pulls in
 * every submount under a `ro` bind's source directory, but the classic
 * `mount -o remount,ro,bind <staged>` step that follows it ONLY remounts the
 * TOP mount at `<staged>` — Linux does not apply `remount,ro,bind`
 * recursively to the submounts `--rbind` carried along, confirmed
 * empirically: a nested bind mount created under a source directory (e.g.
 * Docker's own `/etc/resolv.conf`-style injected submounts, or any other
 * mount point that happens to exist under a `ro` bind's real path) stays
 * WRITABLE after the parent's remount succeeds and reports `available: true`
 * — the exact false-success shape this hardening closes. See
 * `recursiveReadOnlyRemountCommand` below for the fix: after each `ro`
 * bind's top-level remount, walk `/proc/self/mountinfo` (still readable at
 * this point — it's pre-pivot, so this reads the CURRENT namespace's own
 * view) for every mount point that is a descendant of that bind's staged
 * path, and remount each ONE individually. Wrapped in `req` like every
 * other mandatory step, so a submount that refuses to go read-only halts
 * the whole prelude rather than silently leaving it writable.
 */

/**
 * POSIX-awk function DEFINITION (not a full program) that decodes
 * `/proc/self/mountinfo`'s octal path escapes (`\040`=space, `\011`=tab,
 * `\012`=newline, `\134`=backslash — the four bytes `proc(5)` documents the
 * kernel escaping in a mountinfo path field, confirmed empirically against
 * a real `\040`-space bind mount on this host) back to their literal bytes.
 * Embedded via string concatenation into every awk INVOCATION below
 * (`MOUNTINFO_DECODE_AWK_PROGRAM`) rather than kept as a separate `-f` file
 * this module would need to ship and locate on disk — awk programs compose
 * by string concatenation exactly like SQL or shell fragments do elsewhere
 * in this file, and keeping it inline avoids a new filesystem dependency.
 * Written and tested standalone (see this fix's own commit message for the
 * live proof: a `\040`-escaped mountinfo field for a real space-containing
 * bind mount was correctly decoded back to a literal space) before being
 * embedded, matching this module's `REQ_FUNCTION_DEFINITION` discipline.
 */
const MOUNTINFO_OCTAL_DECODE_AWK_FUNCTION = [
  "function pdpp_decode_mountinfo_path(s,    result, i, n, c1, c2, code, j) {",
  '  result = "";',
  "  n = length(s);",
  "  i = 1;",
  "  while (i <= n) {",
  "    c1 = substr(s, i, 1);",
  '    if (c1 == "\\\\" && i + 3 <= n) {',
  "      c2 = substr(s, i + 1, 3);",
  "      if (c2 ~ /^[0-7][0-7][0-7]$/) {",
  "        code = 0;",
  "        for (j = 1; j <= 3; j++) { code = code * 8 + (substr(c2, j, 1) + 0) }",
  '        result = result sprintf("%c", code);',
  "        i += 4;",
  "        continue;",
  "      }",
  "    }",
  "    result = result c1;",
  "    i += 1;",
  "  }",
  "  return result;",
  "}",
].join(" ");

/**
 * The name of the shell function `submountEnumeratorFunctionDefinition()`
 * defines and `forEachSubmountStatement()` invokes. Named once here so the
 * definition and its call sites cannot drift apart.
 */
const SUBMOUNT_ENUMERATOR_FUNCTION_NAME = "pdpp_for_each_submount";

/**
 * The exit code the submount enumerator uses when it cannot PROVE it
 * enumerated `/proc/self/mountinfo` — the parser exited nonzero, or the file
 * could not be read/parsed at all (P1-2, external review of 2a134e153).
 * Distinct from the exit code a caller's own per-submount ACTION returns, so
 * "I could not enumerate" is never confusable with "I enumerated fine and
 * your action failed" — the exact indistinguishability the review found.
 */
const SUBMOUNT_ENUMERATION_FAILURE_EXIT_CODE = 93;

/**
 * A shell function definition that invokes a caller-supplied command once per
 * mount point strictly UNDER a given path, passing the mount point's DECODED
 * absolute path as a direct argv entry. Shared by BOTH
 * `recursiveReadOnlyRemountCommand` (the setup-time remount) and
 * `postPivotVerificationStatements`'s submount check (the post-pivot
 * verification), so neither can drift from the other — the previous version's
 * common-mode failure was exactly that both callers shared one defective
 * enumerator.
 *
 * BYTE-SAFE: NO DECODED PATH EVER CROSSES A NEWLINE CHANNEL (P1-1, external
 * review of 2a134e153). The prior version had awk decode `\012` into a
 * literal newline byte and then `print` the decoded path, one per line, into
 * a pipe its callers consumed with `while IFS= read -r`. A mount point whose
 * name legitimately CONTAINS a newline therefore arrived as TWO records,
 * neither of which is a real path — confirmed live in a privileged container
 * (see this fix's commit message): a single real bind mount at `<dir>/a\nb`
 * produced the two records `<dir>/a` and `b`, and `[ -d ... ]` reports
 * neither exists. In the setup-time remount that turns into a `mount
 * -o remount,ro,bind` against a nonexistent path; in the post-pivot verifier
 * it is worse than that — `probe_ro` against a nonexistent path prints
 * nothing, which the verifier reads as "this submount is confirmed
 * read-only," so a genuinely WRITABLE submount is reported clean. That is the
 * false-success shape this whole verification exists to prevent.
 *
 * THE FIX inverts what the newline channel carries. The RAW mountinfo record
 * is newline-free BY CONSTRUCTION — the kernel escapes a literal newline in a
 * mount point as `\012` precisely so a record occupies exactly one line
 * (`proc(5)`; confirmed live: a real `<dir>/a\nb` mount appears as the single
 * raw field `<dir>/a\012b`). So the line-oriented stage now carries only RAW,
 * still-escaped records — where a newline cannot appear — and the DECODE
 * happens inside the consuming shell loop, after the record boundary has
 * already been established. The decoded path then goes to the caller's
 * command as a direct argv entry (`"$@" "$__decoded"`), never through another
 * pipe, another `echo`, or another line-split. A path containing any byte —
 * newline, tab, space, backslash — survives intact because after decoding it
 * is only ever passed, never re-serialized.
 *
 * DECODING IS NOT IDEMPOTENT, SO IT HAPPENS EXACTLY ONCE. A mount point whose
 * name contains the literal four-character text `\012` escapes to `\134012`
 * (backslash itself escapes to `\134`), which decodes back to the literal
 * text `\012` — NOT to a newline. Confirmed live alongside the newline case
 * above: the two are distinct in the raw field (`a\012b` vs `lit\134012eral`)
 * and only stay distinct if the raw text is decoded exactly once, left to
 * right, with each decoded byte emitted directly rather than rescanned. The
 * decoder below consumes the four input characters of an escape and advances
 * past them, so a `\134` that decodes to a backslash is never re-examined as
 * the start of the following `012` — which is what keeps a mount point
 * literally named `\012` from being mistaken for one containing a newline.
 *
 * FAIL-CLOSED ENUMERATION (P1-2, external review of 2a134e153). The prior
 * version was `awk ... /proc/self/mountinfo | while read ...; done`: if awk
 * exited nonzero, or `/proc/self/mountinfo` was absent/unreadable, the
 * pipeline still exited 0 having run the loop body zero times — confirmed
 * live, both shapes exit 0 — so "I could not enumerate" was byte-identical to
 * "there are no submounts," and setup proceeded / verification passed. This
 * version STAGES the parser's output to a temporary file and refuses to
 * iterate until it has POSITIVE evidence of a successful parse:
 *
 *   1. the parser's own exit status is 0 (captured directly, not through a
 *      pipeline that discards it), AND
 *   2. the parser reports it actually READ AND PARSED mountinfo — it emits a
 *      trailing `#` sentinel line carrying the number of records it saw, and
 *      that count must be present and nonzero. A zero-record mountinfo is
 *      impossible for a live process (the root mount alone is always there),
 *      so "parsed zero records" is itself proof of a truncated or malformed
 *      read rather than a legitimate empty result.
 *
 * Only when both hold does it iterate; otherwise it exits
 * `SUBMOUNT_ENUMERATION_FAILURE_EXIT_CODE` with a diagnostic. This is what
 * makes an unreadable, absent, empty, malformed, or partially-written
 * mountinfo BLOCK the child rather than silently look clean. Note that
 * "found zero SUBMOUNTS" remains a perfectly legitimate result (most binds
 * have none) and is distinguished from "parsed zero RECORDS" — only the
 * latter is a failure.
 *
 * ORDER: newest mounts appear later in `/proc/self/mountinfo`, so a mount
 * nested two levels deep (a submount of a submount) is naturally processed
 * AFTER its own parent submount, in the same top-to-bottom order the file
 * already lists them — unchanged from the prior version's reasoning, and
 * preserved here because the staging file keeps the parser's original order.
 */
export function submountEnumeratorFunctionDefinition(): string {
  // The parser emits RAW (still-escaped) field-5 tokens, one per line, for
  // every record whose DECODED path is strictly under `staged` — plus a
  // trailing `#<count>` sentinel proving it read and parsed the file. The
  // descendant comparison happens INSIDE awk, on decoded values, so the
  // caller never has to compare decoded paths itself (and so a misleading
  // prefix like `/p/pre-fix` is correctly excluded from `/p/pre`'s
  // descendants: the `staged "/"` prefix test requires a real path
  // separator, which `pre-fix` does not have after `pre`).
  // VALIDATES RECORD SHAPE, NOT JUST LINE COUNT. Counting lines is NOT
  // evidence of a successful parse — confirmed empirically against a
  // deliberately malformed mountinfo (`not mountinfo at all\njunk`) and a
  // byte-truncated one: both yield a nonzero line count, so a line-count
  // sentinel alone would have let the caller iterate on garbage. A real
  // `/proc/self/mountinfo` record (`proc(5)`) is: numeric mount ID, numeric
  // parent ID, `major:minor`, root, mount point, then optional fields
  // terminated by a literal `-` separator, then at least fs type and source
  // after it. Any line failing that shape makes this parser exit nonzero, so
  // a malformed or partially-written file BLOCKS instead of being silently
  // treated as "no submounts here".
  //
  // A TRUNCATED FINAL RECORD is caught separately, by the caller comparing
  // the bytes the parser consumed against the source's real size — a partial
  // read leaves the last line without its terminating newline. This is NOT
  // done with gawk's `RT` record-terminator variable: the target shell
  // environment ships `mawk` (confirmed: `mawk 1.3.4`, which has no `RT` and
  // silently yields an empty string for it, so an `RT`-based check would
  // pass vacuously on every input). A byte-truncated mountinfo can cut in a
  // place where the surviving prefix still satisfies the field-shape test
  // above (confirmed empirically: truncating to 60 bytes left a first line
  // that passed shape validation), so shape alone is not sufficient to catch
  // a partial read.
  const awkProgram =
    `${MOUNTINFO_OCTAL_DECODE_AWK_FUNCTION} ` +
    "{ sep = 0; " +
    'for (f = 7; f <= NF; f++) { if ($f == "-") { sep = f; break } } ' +
    "if (NF < 10 || sep == 0 || NF - sep < 2 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+:[0-9]+$/) { " +
    'printf "pdpp isolation: malformed /proc/self/mountinfo record at line %d\\n", NR > "/dev/stderr"; ' +
    "malformed = 1; exit 1 } " +
    "valid++; mp = pdpp_decode_mountinfo_path($5); " +
    "if (mp != staged && index(mp, stagedslash) == 1) print $5 } " +
    'END { if (malformed) { exit 1 } printf "#%d\\n", valid }';
  return [
    `${SUBMOUNT_ENUMERATOR_FUNCTION_NAME}() {`,
    // `$1` is the parent path to enumerate under; everything after `--` is
    // the caller's command, invoked once per submount with the decoded path
    // appended as a direct argv entry.
    '  __sm_parent="$1"; shift;',
    // STAGED IN A VARIABLE, NOT A TEMP FILE. An earlier revision of this fix
    // staged to `mktemp`, which broke every real caller: neither context this
    // runs in is guaranteed to have a writable temp directory — the bwrap
    // sandbox builds a bare `tmpfs` root with no `/tmp` at all, and the
    // unshare prelude's post-pivot root likewise provides none (confirmed:
    // `mktemp` failed with "No such file or directory" in both, which failed
    // the check closed for an incidental reason having nothing to do with
    // the mount table). Staging in a variable removes the filesystem
    // dependency entirely.
    //
    // This is byte-safe HERE specifically because the staged content is RAW,
    // still-escaped mountinfo records, which the kernel guarantees are
    // newline-free — the same property the whole design rests on. Command
    // substitution strips trailing newlines and the `while read` below splits
    // on them, and neither can corrupt a record that cannot contain one. A
    // DECODED path would NOT be safe to stage this way, which is exactly why
    // the decode happens per-record inside the loop instead.
    //
    // SOURCE: `PDPP_MOUNTINFO_PATH` when set, else the real
    // `/proc/self/mountinfo`. This exists so the forced-failure controls
    // (parser nonzero, unreadable, absent, empty, malformed, partial) can be
    // exercised against a REAL fixture file: `mount --bind` over
    // `/proc/self/mountinfo` reports success but the kernel keeps serving
    // live content (confirmed empirically — `/proc/self` is a magic symlink
    // resolved per read), so pointing the parser at an unparsable file is
    // the only honest way to test an unparsable mountinfo. The variable is
    // set only by this module's own tests; the production prelude never sets
    // or exports it, and it is read before `exec <target>`, so the isolated
    // child cannot influence it. Written as a template literal because the
    // shell's `${VAR:-default}` expansion is spelled identically to a JS
    // template placeholder, which the linter rejects inside a plain string.
    `  __sm_source="\${PDPP_MOUNTINFO_PATH:-/proc/self/mountinfo}";`,
    // Parser exit status captured DIRECTLY — assigned from a command
    // substitution rather than read after a pipeline, which is what made the
    // prior version's failure invisible.
    `  __sm_staged=$(awk -v staged="$__sm_parent" -v stagedslash="$__sm_parent/" ${shQuote(awkProgram)} ` +
      '"$__sm_source" 2>/dev/null); __sm_rc=$?;',
    '  if [ "$__sm_rc" -ne 0 ]; then ' +
      'echo "pdpp isolation: submount enumeration parser failed (exit $__sm_rc) for [$__sm_parent]" 1>&2; ' +
      `exit ${SUBMOUNT_ENUMERATION_FAILURE_EXIT_CODE}; fi;`,
    // A partially-written source ends without a terminating newline. `tail
    // -c 1` inside a command substitution yields that final byte for a
    // truncated file and the empty string for a properly terminated one
    // (command substitution strips the trailing newline) — a portable
    // truncation test that does not need gawk's `RT`, which mawk lacks.
    // An empty source has no final byte and is caught by the sentinel check
    // below instead.
    '  if [ -s "$__sm_source" ] && [ -n "$(tail -c 1 "$__sm_source" 2>/dev/null)" ]; then ' +
      'echo "pdpp isolation: mountinfo source [$__sm_source] ends mid-record (partial read)" 1>&2; ' +
      `exit ${SUBMOUNT_ENUMERATION_FAILURE_EXIT_CODE}; fi;`,
    // Evidence that mountinfo was actually read and parsed: the sentinel must
    // be present AND report a nonzero valid-record count.
    '  __sm_sentinel=$(printf "%s\\n" "$__sm_staged" | sed -n "s/^#\\([0-9][0-9]*\\)$/\\1/p" | tail -n 1);',
    '  if [ -z "$__sm_sentinel" ] || [ "$__sm_sentinel" -eq 0 ]; then ' +
      'echo "pdpp isolation: submount enumeration could not prove mountinfo was read and parsed ' +
      'for [$__sm_parent] (records=[$__sm_sentinel])" 1>&2; ' +
      `exit ${SUBMOUNT_ENUMERATION_FAILURE_EXIT_CODE}; fi;`,
    // Only now iterate. The line channel carries RAW records only; the decode
    // happens here, per record, and the decoded path goes out as direct argv.
    //
    // The loop body runs in a SUBSHELL under dash, so a failing per-submount
    // action cannot set a variable the caller would see — instead the
    // subshell `exit`s with the action's own status, and the pipeline's
    // status (which equals its last command's, i.e. the subshell's) becomes
    // this function's. That is the same exit-status-propagation property the
    // prior version relied on, kept deliberately: it is what lets `req` and
    // the post-pivot check fail closed on a submount that refuses its
    // remount or probe.
    '  printf "%s\\n" "$__sm_staged" | while IFS= read -r __sm_raw; do',
    '    [ -n "$__sm_raw" ] || continue;',
    '    case "$__sm_raw" in "#"*) continue ;; esac;',
    '    __sm_decoded=$(printf "%s" "$__sm_raw" | ' +
      `awk ${shQuote(`${MOUNTINFO_OCTAL_DECODE_AWK_FUNCTION} { printf "%s", pdpp_decode_mountinfo_path($0) }`)}` +
      ') || { echo "pdpp isolation: submount path decode failed for [$__sm_raw]" 1>&2; ' +
      `exit ${SUBMOUNT_ENUMERATION_FAILURE_EXIT_CODE}; };`,
    '    "$@" "$__sm_decoded" || exit $?;',
    "  done;",
    "}",
  ].join(" ");
}

/**
 * Builds the shell statement that runs `command` (a command NAME plus any
 * fixed leading argv entries) once per submount of `parentPathShQuoted`, with
 * the submount's decoded path appended as the final argv entry.
 *
 * Command substitution is deliberately NOT used to carry the path: the whole
 * point of `submountEnumeratorFunctionDefinition()` is that a decoded path is
 * only ever PASSED as argv, never re-serialized into a string a shell would
 * then have to re-split.
 */
function forEachSubmountStatement(parentPathShQuoted: string, command: string): string {
  return `${SUBMOUNT_ENUMERATOR_FUNCTION_NAME} ${parentPathShQuoted} ${command}`;
}

/**
 * Builds a shell command that finds every mount point strictly UNDER
 * `stagedPathShQuoted` (the already-quoted staged path of a `ro` bind whose
 * OWN top mount was just remounted read-only) via `findDecodedSubmountsShellFragment`
 * (see that function's doc comment for the mountinfo-parsing fix this round
 * closes), and remounts EACH ONE, individually, `ro,bind` — closing the gap
 * `--rbind` (recursive bind) plus a single top-level `remount,ro,bind`
 * leaves open: Linux does not propagate a `remount` operation to submounts
 * the way `--rbind`/`--rprivate` propagate at BIND/PROPAGATION time, so any
 * mount point that existed under a `ro` bind's source directory at bind time
 * (e.g. Docker's own `/etc/resolv.conf`-style injected submounts under
 * `/etc`, or any other nested mount a future derived bind might carry) stays
 * writable unless remounted on its own.
 *
 * FAILS CLOSED: the caller wraps this in `reqStatement`, so if EVEN ONE
 * submount refuses `remount,ro,bind` (a filesystem type that genuinely
 * cannot be remounted read-only, a kernel refusal, or the path awk parsed
 * simply not existing as a real mountpoint) the whole prelude halts before
 * `exec <target>` is ever reached — never silently leaves that one submount
 * writable and proceeds.
 */
function recursiveReadOnlyRemountCommand(stagedPathShQuoted: string): string {
  // `mount -o remount,ro,bind` is invoked with the submount's decoded path as
  // a DIRECT argv entry appended by the enumerator — not interpolated into a
  // string, so a path containing a newline/tab/space/backslash reaches
  // `mount(8)` byte-for-byte as the single argument it is.
  // Joined with `;`, not a bare space: a shell function definition's closing
  // `}` is a reserved word that needs a command separator before whatever
  // follows it, or dash rejects the next word ("Syntax error: word
  // unexpected") — confirmed against `/bin/sh` -> dash, the shell this
  // prelude actually runs under.
  const body = [
    submountEnumeratorFunctionDefinition(),
    forEachSubmountStatement(stagedPathShQuoted, "mount -o remount,ro,bind"),
  ].join("; ");
  // `req` (see REQ_FUNCTION_DEFINITION's doc comment) executes its wrapped
  // command as `"$@"` — a single command name plus argv entries, not a
  // shell snippet — so a compound statement like this must be handed to
  // `req` as ONE argv entry, itself run via `sh -c`, rather than being split
  // on whitespace the way a plain `mount ...` command is. The enumerator's
  // own `exit` (on an enumeration failure, or on a submount that refuses the
  // remount) becomes this `sh -c`'s exit status, which `req` then reports and
  // fails the whole prelude on.
  return `${shQuote(resolveTrustedLauncherPath("sh"))} -c ${shQuote(body)}`;
}

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
    // `probe_ro` is NOT defined here — `postPivotVerificationStatements`
    // (appended at the end of this prelude, post-pivot) initializes its own
    // trusted PATH and defines it, keeping that function's output
    // self-contained for its other real caller (isolation-mechanism.test.ts's
    // standalone sandbox harness, which builds a script from ONLY that
    // function's return value, no prelude). See that function's own doc
    // comment.
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
      statements.push(
        reqStatement(`remount ${bind.path} submounts read-only`, recursiveReadOnlyRemountCommand(staged))
      );
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
 * IN-NAMESPACE SOCKET SCAN (P1-2, external review of ced8300be) — the
 * host-side pre-flight scan (`findPreexistingSocketsUnderReadOnlyBinds()`)
 * runs from the CALLING Node process, before any isolated child's mount
 * namespace even exists — it sees the real host filesystem, not the
 * isolated child's own pivoted view, and it runs only ONCE, before ANY
 * run's subprocess spawns. The external review's TOCTOU objection: a HOST
 * process (a separate, non-sandboxed process on the same machine, with
 * ordinary write access to a `ro` bind's SOURCE directory on the real
 * filesystem — recursive read-only only stops the SANDBOX from creating a
 * new socket there, not the host) can create a socket under a scanned path
 * at any point between that one early scan and the target command's actual
 * `exec` — a gap of however long every earlier run in the scenario took.
 * This closes that gap by running the SAME kind of check TWICE more,
 * IN-NAMESPACE: once as part of `postPivotVerificationStatements` (right
 * after every `ro` bind's top-level AND submount remounts have completed —
 * the earliest point at which the isolated child's own view of those paths
 * is both final and read-only), and once again immediately before `exec
 * <target>` in `spawnWithNetworkIsolation`'s unshare branch (the LAST
 * possible point before the target command could dial anything). Narrows
 * the race window on every run to "however long this run's own setup takes
 * between the two scan points," not "however long the whole scenario's
 * prior runs took" — genuinely smaller, but NOT zero: a host process could
 * still plant a socket in the interval between this function's second call
 * and the target's first `connect()`, however short. See this function's
 * own TERMINAL-ARCHITECTURE note below for the fix that actually closes the
 * remaining gap.
 *
 * `find <path> -type s` (GNU findutils, present in every trusted directory
 * this module's `TRUSTED_SETUP_PATH`/`TRUSTED_LAUNCHER_DIRECTORIES` already
 * trust) rather than a hand-rolled shell walk — confirmed empirically it
 * does NOT follow symlinks by default (no `-L` flag given), matching the
 * host-side scanner's own symlink-avoidance, and does not hang against a
 * self-referential symlink loop.
 *
 * FAILS CLOSED ON AN UNREADABLE SUBTREE (P1-2, the review's OTHER half of
 * this finding) — `find`'s own exit status distinguishes "fully enumerated,
 * found nothing" from "could not fully enumerate": confirmed empirically,
 * as an unprivileged user, `find <root>` against a subtree it cannot LIST
 * (`chmod 000`, or `chmod 311` — SEARCHABLE but not LISTABLE, a genuinely
 * separate permission bit from readability, see next paragraph) exits `1`
 * and prints `find: '<path>': Permission denied` to stderr, while still
 * printing every path it COULD enumerate before hitting the blocked
 * subtree. This function captures that exit status and treats ANY nonzero
 * exit from `find` as "could not prove this subtree clean," not "found
 * nothing" — the same fail-closed posture `req`/`SETUP_STEP_FAILURE_EXIT_CODE`
 * already applies to every OTHER mandatory setup step, extended here to an
 * enumeration failure rather than a command failure.
 *
 * DIRECTORY READ VS SEARCH ARE SEPARATE PERMISSIONS (confirmed empirically,
 * unprivileged user, both this module's own scan AND a real socket dial):
 * a directory with mode `311` (search/execute bit set, read bit NOT set)
 * cannot be LISTED — `find`/`readdir` against it fails `EACCES`, so a
 * socket with an UNKNOWN name inside it is invisible to enumeration — but a
 * socket with a KNOWN name inside it stays fully STAT-able and CONNECTABLE
 * (confirmed live: a client successfully connected to a socket under a
 * `chmod 311` directory whose contents `find`/`readdirSync` could not list).
 * This means a `311` subtree is not merely "harder to see into" than a
 * `000` one — both fail identically at the enumeration step (`find` exits
 * nonzero for either), so both correctly fall into the SAME fail-closed
 * branch here; the distinction matters for WHY the scan must fail closed on
 * an unreadable subtree at all (an attacker does not need read+write on a
 * directory to make a socket inside it reachable — only the ability to
 * create the socket once, before locking the directory down to `311` or
 * `000`), not for how this function's own logic branches.
 *
 * TERMINAL ARCHITECTURE (documented follow-up, not built this round, same
 * pattern this module already uses for the CGROUP/TIME namespace residuals
 * — see this module's own doc comment, "WHAT THIS BOUNDARY DOES AND DOES
 * NOT ISOLATE"): re-scanning immediately before spawn (what this function
 * does) REDUCES the TOCTOU race window but does not ELIMINATE it — a
 * verifier-owned IMMUTABLE snapshot of every required input (taken once,
 * before the scenario's first run, and never re-read from the live host
 * filesystem again) would close the window entirely rather than narrowing
 * it. Not built this round: it is a substantially larger architectural
 * change (the isolated child's binds would need to come from the snapshot
 * itself, not `requiredFilesystemBinds()`'s live paths) than this bounded
 * repair's scope covers.
 *
 * Returns a shell statement, NOT wrapped in `req` — `req`'s own diagnostic
 * wording ("setup step [...] failed") doesn't fit a scan finding a REAL
 * socket (not a setup command failing), so this builds its own message and
 * exit using `IN_NAMESPACE_SOCKET_SCAN_FAILURE_EXIT_CODE` directly, matching
 * `postPivotVerificationStatements`'s own pattern of a bespoke diagnostic
 * rather than `req`'s generic one.
 */
function inNamespaceSocketScanStatement(roBindPaths: readonly string[]): string {
  const scannedPaths = roBindPaths.filter((path) => !SOCKET_SCAN_EXCLUDED_SYSTEM_PATHS.includes(path));
  if (scannedPaths.length === 0) {
    return "true";
  }
  const quotedPaths = scannedPaths.map((path) => shQuote(path)).join(" ");
  // ONE `find` invocation, combined `2>&1` capture (matches `req`'s own
  // established pattern) — then split the captured lines by whether they
  // start with `find: ` (every diagnostic `find` itself emits uses this
  // exact prefix; a matched socket PATH, printed by `-type s`'s default
  // action, never does, since a scanned bind path is never itself prefixed
  // with the literal string `find: `). Two separate `find` calls were
  // considered and rejected: querying stdout and stderr via independent
  // invocations doubles the traversal cost AND opens its own TOCTOU window
  // between the two calls, defeating the point of this scan.
  //
  // ENOENT-DURING-TRAVERSAL IS NOT A SECURITY SIGNAL: `REPO_ROOT` (and
  // every other scanned bind) is a LIVE bind-mounted view of the real host
  // directory — a HOST-side process can create AND remove a path under it
  // at any time, entirely independent of anything this scan is checking
  // for. `find` walking into a directory whose entry vanishes between
  // being listed and being stat'd exits nonzero and prints "No such file or
  // directory" for that one path — confirmed empirically (concurrent
  // mkdir/rmdir churn under a shared directory reliably reproduces this;
  // this exact race was hit live by this repair's own test suite, two
  // isolated replay subprocesses from unrelated tests both scanning
  // REPO_ROOT while a third test's scratch directory was mid-teardown) — a
  // NORMAL filesystem race, not evidence of anything reachable or hidden.
  // Confirmed the wording is reliably distinct from a genuine permission
  // failure: `find` against an unreadable/unsearchable directory instead
  // prints "Permission denied" for that path. This function filters OUT
  // diagnostic lines matching "No such file or directory" before deciding
  // whether to fail — any OTHER diagnostic content (Permission denied, or
  // anything this reasoning did not anticipate) still fails closed exactly
  // as before; only the specific, verified-benign "the path is simply gone"
  // case is treated as informational, never silently dropped from the
  // reasoning (still visible in the raw combined capture if this ever needs
  // to be re-diagnosed, just not treated as fatal). The failure decision is
  // driven by the FILTERED diagnostic lines and found-socket lines, not
  // `find`'s raw exit code alone, precisely because that raw code cannot
  // distinguish "found a real hazard" from "a sibling process's scratch
  // directory disappeared mid-walk."
  return (
    `__socket_scan_combined=$(find ${quotedPaths} -type s 2>&1); ` +
    '__socket_scan_errors=$(echo "$__socket_scan_combined" | grep "^find: " | grep -v "No such file or directory"); ' +
    '__socket_scan_sockets=$(echo "$__socket_scan_combined" | grep -v "^find: "); ' +
    'if [ -n "$__socket_scan_errors" ] || [ -n "$__socket_scan_sockets" ]; then ' +
    'echo "pdpp isolation: in-namespace socket scan failed - sockets=[$__socket_scan_sockets] errors=[$__socket_scan_errors]" 1>&2; ' +
    `exit ${IN_NAMESPACE_SOCKET_SCAN_FAILURE_EXIT_CODE}; fi`
  );
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
/**
 * The `probe_ro` shell function definition (P1-3, external review of
 * ced8300be) — a single write-probe usable against EITHER a directory OR a
 * FILE bind mount, echoing the path if it's still writable (the false-
 * success shape every caller of this function checks for) and nothing if
 * genuinely read-only.
 *
 * FILE SUBMOUNTS COULD NOT BE VERIFIED (P1-3, the review's second half of
 * this finding): the prior probe was `touch <path>/.pdpp-isolation-ro-probe`
 * — creating a NEW file INSIDE the probed path, which only makes sense for
 * a DIRECTORY target. Confirmed empirically against a real file bind mount
 * (e.g. the shape Docker's own `/etc/resolv.conf` injection produces — a
 * single FILE bind-mounted onto another single file, not a directory):
 * `touch <file-mount>/.probe` fails with `ENOTDIR` ("Not a directory")
 * REGARDLESS of whether the file mount is actually read-only or not — so
 * the old probe reported EVERY file submount as "confirmed read-only" even
 * when a separate, direct write proved it was still genuinely writable
 * (reproduced live: `echo x > <file-mount>` succeeded while the old
 * `touch <file-mount>/.probe` probe simultaneously reported "read-only" for
 * the exact same still-writable target) — a false negative, the "confirmed
 * clean when it is not" shape this whole verification exists to prevent.
 *
 * FIX: branch on `[ -d "$path" ]`. For a directory, keep the original
 * create-a-file-inside probe (a file bind mount has no "inside" to probe
 * this way, but a directory's own write permission is exactly what creating
 * an entry inside it tests). For anything else (a file, confirmed via `-d`
 * being false rather than asserting `-f` — matches this module's existing
 * "test the property that matters, not a narrower assumption about what
 * else the path could be" discipline elsewhere), open the path itself
 * for write in append mode via shell redirection (`exec 3>>"$path"`). This
 * asks the kernel for write access without `O_TRUNC` and performs no write,
 * so a host-backed file submount keeps its exact bytes. It correctly fails
 * with `EROFS`/a shell-level "Read-only file system" error for a genuinely
 * read-only file bind mount, and correctly SUCCEEDS (proving writability,
 * the false-success case) for a writable one — unlike the old
 * `ENOTDIR`-always probe, this actually depends on the mount's real
 * read-only state rather than failing unconditionally for the wrong reason.
 */
const PROBE_RO_FUNCTION_DEFINITION =
  'probe_ro() { __p="$1"; if [ -d "$__p" ]; then ' +
  '__probe="$__p/.pdpp-isolation-ro-probe-$$"; ' +
  'if touch "$__probe" 2>/dev/null; then rm -f "$__probe" 2>/dev/null; echo "$__p"; fi; ' +
  'else if sh -c "exec 3>>\\"\\$1\\"" _ "$__p" 2>/dev/null; then echo "$__p"; fi; fi; }';

export function postPivotVerificationStatements(binds: readonly FilesystemBind[]): string[] {
  // `probe_ro` is defined HERE, after this function initializes its own
  // trusted PATH, rather than relying on a caller to have already defined it
  // (P1-3, external review of ced8300be) — `filesystemClosureShellPrelude`
  // defines it again, earlier, before calling this function, which is
  // harmless (dash allows redefining a shell function), but this function's
  // OWN output must be self-contained: it is called directly, standalone,
  // by `isolation-mechanism.test.ts`'s own sandbox test harness (a script
  // built from ONLY this function's returned statements, no prelude), and
  // that is a legitimate, real calling shape this function's own contract
  // must support without a caller needing to know its internal
  // implementation detail of using a shell function.
  // The submount enumerator is defined here for the same self-containment
  // reason `probe_ro` is (see the comment above): this function's returned
  // statements are run standalone by `isolation-mechanism.test.ts`'s sandbox
  // harness, with no prelude to have defined it.
  const statements: string[] = [
    `PATH=${TRUSTED_SETUP_PATH}`,
    PROBE_RO_FUNCTION_DEFINITION,
    submountEnumeratorFunctionDefinition(),
  ];
  const roBindPaths = binds.filter((b) => b.mode === "ro").map((b) => b.path);
  // Property 3 checks the TOP of each ro bind, at its real, post-pivot path
  // (`/usr`, `/etc`, ... — the new root's OWN view, not the pre-pivot
  // staging prefix `postPivotVerificationStatements`'s caller uses).
  // FILE-VS-DIRECTORY (P1-3, external review of ced8300be): uses the shared
  // `probe_ro` function (see `PROBE_RO_FUNCTION_DEFINITION`'s doc comment)
  // rather than the old directory-only touch-inside probe, so a top-level
  // `ro` bind that happens to be a FILE (not currently produced by
  // `requiredFilesystemBinds()`, which only declares directories today, but
  // not guaranteed to stay that way, and the review's finding applies to
  // the verification LOGIC, not just today's concrete bind set) is
  // correctly verifiable too, not silently mis-probed the way the old
  // ENOTDIR-always shape would.
  const topLevelRoCheck = roBindPaths.map((path) => `probe_ro ${shQuote(path)}`).join("; ");
  // RECURSIVE READ-ONLY, property 3 EXTENDED (P1, external review of
  // ab415be6c): the top-level check above only proves the PARENT mount of
  // each ro bind is read-only — it says nothing about a nested submount
  // `--rbind` carried along underneath it (see `recursiveReadOnlyRemountCommand`'s
  // doc comment for the full defect this closes). This verification must
  // catch the same class of false-success the setup-time fix targets: if a
  // FUTURE edit reintroduces the old single-level remount (or the
  // recursive-remount loop silently skips a submount added after this
  // function was written), the top-level-only check above would still
  // report every ro bind's PARENT correctly read-only while a submount
  // stayed writable — exactly invisible to that check alone. This walks
  // `/proc/self/mountinfo` (POST-pivot, so it reflects the NEW root's own
  // mount table — the real, live view the isolated child actually has, not
  // the pre-pivot staging tree) for every mount point strictly under each ro
  // bind's real path, via `findDecodedSubmountsShellFragment` (P1-3,
  // external review of ced8300be — see that function's doc comment for the
  // mountinfo-decode and newline-safe-iteration fixes shared with the
  // setup-time remount), and probes each one with the SAME `probe_ro`
  // function as the top-level check, now also handling FILE submounts
  // correctly (see `PROBE_RO_FUNCTION_DEFINITION`'s doc comment) — the exact
  // Docker-injected `/etc/resolv.conf`-style shape this module's own doc
  // comments elsewhere already cite as the concrete, real-world case this
  // must catch.
  // BYTE-SAFE + FAIL-CLOSED (P1-1/P1-2, external review of 2a134e153): the
  // submount walk now goes through the shared enumerator, which passes each
  // decoded path to `probe_ro` as a DIRECT argv entry (so a newline- or
  // tab-containing submount is probed as the single path it really is,
  // instead of being split into non-existent fragments that probe silently
  // clean) and REFUSES to iterate unless it can prove it read and parsed
  // `/proc/self/mountinfo`. See `submountEnumeratorFunctionDefinition()`.
  const submountRoCheck = roBindPaths.map((path) => forEachSubmountStatement(shQuote(path), "probe_ro")).join("; ");
  const roCheck = [topLevelRoCheck, submountRoCheck].filter(Boolean).join("; ");
  // The ro-check runs inside a command substitution, so an enumeration
  // failure's `exit` would otherwise only kill the SUBSHELL — its status has
  // to be captured explicitly and turned into a verification failure here,
  // or "could not enumerate" would once again read as "nothing writable
  // found." `__ro_rc` is that capture; any nonzero value fails the check.
  statements.push(
    "__canary_ok=1; [ -e /pdpp-isolation-canary ] || __canary_ok=0; " +
      `__oldroot_leftover=$(set -- /oldroot/*; if [ -e "$1" ]; then echo "$1"; fi); ` +
      `__writable_ro=$(${roCheck || "true"}); __ro_rc=$?; ` +
      `if [ "$__canary_ok" -ne 1 ] || [ -n "$__oldroot_leftover" ] || [ -n "$__writable_ro" ] || ` +
      `[ "$__ro_rc" -ne 0 ]; then ` +
      `echo "pdpp isolation: post-pivot verification failed — new-root-active=$__canary_ok oldroot-leftover=[$__oldroot_leftover] writable-ro-binds=[$__writable_ro] ro-check-status=$__ro_rc" 1>&2; ` +
      `exit ${POST_PIVOT_VERIFICATION_FAILURE_EXIT_CODE}; fi`
  );
  // IN-NAMESPACE SOCKET SCAN, POINT A (P1-2, external review of ced8300be):
  // run immediately after the ro-bind checks above (which prove every
  // submount is genuinely read-only) — this is the earliest point at which
  // the isolated child's own view of every scanned path is both final
  // (every bind/remount step has completed) and read-only, so a scan here
  // reflects the real, live post-pivot mount table, not the pre-pivot
  // staging tree the setup steps built. See `inNamespaceSocketScanStatement`'s
  // doc comment for the full TOCTOU-narrowing rationale and why a second
  // scan (POINT B, immediately before `exec` — see
  // `spawnWithNetworkIsolation`'s unshare branch) is also needed.
  statements.push(inNamespaceSocketScanStatement(roBindPaths));
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
  // IN-NAMESPACE SOCKET SCAN (P1-2, external review of ced8300be): bwrap has
  // no separate pre-pivot/post-pivot phases the way unshare's shell prelude
  // does — every `--ro-bind`/remount bwrap declares is already final and
  // read-only the INSTANT this inner `sh -c` begins running (bwrap builds
  // the whole mount table itself, before exec'ing anything into it), so
  // POINT A and POINT B (see `inNamespaceSocketScanStatement`'s doc comment)
  // collapse to the same single moment here — one scan, run as the first
  // statement in this inner shell, immediately before `exec`.
  const socketScan = inNamespaceSocketScanStatement(
    requiredFilesystemBinds()
      .filter((b) => b.mode === "ro")
      .map((b) => b.path)
  );
  // TRUSTED SHELL (P1-1, external review of ced8300be): resolved via
  // resolveTrustedLauncherPath("sh"), never the bare string "sh" — bwrap
  // execs this argv entry the same way unshare does (execvp against the
  // spawning Node process's own inherited PATH, fully caller-controlled),
  // so the same PATH-prepended-fake risk applies even though this shell runs
  // inside bwrap's own already-closed filesystem view.
  return [
    "--unshare-net",
    ...bwrapFilesystemClosureArgs(filesystemBindPath),
    "--",
    resolveTrustedLauncherPath("sh"),
    "-c",
    `PATH=${TRUSTED_SETUP_PATH}; ${socketScan}; exec ${innerCommand}`,
  ];
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
    // TRUSTED LAUNCHER (P1, external review of ab415be6c): resolved via
    // resolveTrustedLauncherPath, never a bare "bwrap" name that node:
    // child_process would otherwise resolve through this process's own
    // inherited $PATH — see that function's doc comment.
    return spawn(
      resolveTrustedLauncherPath("bwrap"),
      bwrapArgvForFilesystemClosure(cmd, args, filesystemBindPath),
      spawnOpts
    );
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
  // IN-NAMESPACE SOCKET SCAN, POINT B (P1-2, external review of ced8300be):
  // a second scan, run as the LAST statement before `exec <target>` — the
  // latest possible point at which a host process could have planted a
  // socket under a scanned path since POINT A ran (inside
  // `filesystemClosureShellPrelude`'s own `postPivotVerificationStatements`
  // call) narrows the TOCTOU window this module's own doc comment
  // describes to the smallest gap this repair can practically close. See
  // `inNamespaceSocketScanStatement`'s doc comment for the full rationale
  // and the documented terminal-architecture follow-up this does not
  // attempt to build.
  const socketScanPointB = inNamespaceSocketScanStatement(
    requiredFilesystemBinds()
      .filter((b) => b.mode === "ro")
      .map((b) => b.path)
  );
  const shScript = `PATH=${TRUSTED_SETUP_PATH}; ip link set lo up >/dev/null 2>&1; ${closurePrelude}; ${socketScanPointB}; exec ${innerCommand}`;
  // TRUSTED LAUNCHER (P1, external review of ab415be6c): resolved via
  // resolveTrustedLauncherPath, never a bare "unshare" name — see that
  // function's doc comment. Note this is the LAUNCHER binary itself; the
  // commands INSIDE the shell script it runs (mount, pivot_root, ...) are
  // separately trusted via TRUSTED_SETUP_PATH above.
  //
  // TRUSTED SHELL (P1-1, external review of ced8300be): the shell `unshare`
  // execs the closure script INTO is ALSO resolved via
  // resolveTrustedLauncherPath("sh"), never the bare string "sh" — this is
  // the exact call site the review's repro targets. `unshare` performs
  // `execvp("sh", [...])` on this argv entry; execvp resolves a bare name
  // through the PATH environment variable of the process performing the
  // exec at THAT moment — which is whatever `spawnOpts.env`/inherited
  // `process.env.PATH` this spawn() call carries, fully caller-controlled,
  // NOT `TRUSTED_SETUP_PATH` (that assignment is the FIRST STATEMENT INSIDE
  // `shScript`, so it can only protect commands the script itself later
  // runs — it cannot select which `sh` interprets the script in the first
  // place). Confirmed empirically: with a fake `sh` (touches a marker file,
  // then execs the real `/bin/sh` to still "work") prepended to PATH, the
  // bare-string version invoked the fake before `TRUSTED_SETUP_PATH` could
  // ever matter; the absolute-path version never does — see
  // `resolveTrustedLauncherPath`'s own doc comment and
  // `isolation-mechanism.test.ts`'s poisoned-PATH tests for both mechanisms.
  return spawn(
    resolveTrustedLauncherPath("unshare"),
    [
      "--map-root-user",
      "--net",
      "--mount",
      "--pid",
      "--ipc",
      "--uts",
      "--fork",
      "--",
      resolveTrustedLauncherPath("sh"),
      "-c",
      shScript,
    ],
    spawnOpts
  );
}
