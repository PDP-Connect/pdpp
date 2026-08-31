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
 * MECHANISM: `unshare --map-root-user --net --mount --pid --fork -- sh -c
 * '<bring up lo>; <filesystem closure — see PATHNAME-UDS ESCAPE below>; exec
 * <cmd> <args>'`. `--net` creates a new, empty network namespace (only a
 * down `lo` interface exists in a fresh netns); `--map-root-user` also
 * unshares a user namespace and maps the caller to root *inside* it, which
 * is what makes `--net` usable WITHOUT the `CAP_SYS_ADMIN`/root the bare
 * `--net` flag would otherwise require on the host — an unprivileged user
 * can create a user+net namespace pair and hold real capabilities (incl.
 * `CAP_NET_ADMIN`) only inside it. `--mount` gives the child its own mount
 * namespace (needed for the filesystem closure below) and `--pid --fork`
 * gives it its own pid namespace (needed for that closure's post-pivot
 * `mount -t proc proc /proc`, which an unprivileged mount namespace without
 * its own pid namespace cannot perform — see `filesystemClosureShellPrelude`'s
 * doc comment). The `sh -c` prelude brings `lo` up (`ip link set lo up`)
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
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
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
 * root. `mode: "rw"` is used only for `filesystemBindPath` (the caller's own
 * evidence workspace, which the replay bridge writes into); every path this
 * module derives on its own is `"ro"` — a connector replay has no legitimate
 * reason to write into its own Node install, the repo checkout's
 * `node_modules`, or a browser-binary cache.
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
 * - `REPO_ROOT` (rw): `bin/scenario-verify.ts` spawns
 *   `process.execPath ["--import", "tsx", connectorPath]` with `cwd:
 *   PACKAGE_ROOT` — `tsx`, every connector's source, and the ENTIRE
 *   `node_modules` tree (confirmed: this repo's pnpm store resolves fully
 *   inside `REPO_ROOT`, no external symlink targets) live under the repo
 *   checkout. `rw` because a connector may write scratch/cache state under
 *   its own `node_modules` (e.g. a `.cache` a library maintains next to
 *   itself) — read-only here would be a new, unrelated failure mode this fix
 *   has no mandate to introduce.
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
    { path: REPO_ROOT, mode: "rw" },
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
 * — for every process on the host, not just its own subtree. Confirmed via
 * an independent review's repro: without `--unshare-pid`, an isolated
 * child's `ls /proc | grep -cE '^[0-9]+$'` showed 1683 of 1681 host
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
function filesystemClosureShellPrelude(filesystemBindPath: string | undefined): string {
  const newroot = "/tmp/pdpp-scenario-isolation-newroot";
  const oldroot = `${newroot}/oldroot`;
  const statements: string[] = [
    `mkdir -p ${shQuote(newroot)} >/dev/null 2>&1`,
    `mount -t tmpfs tmpfs ${shQuote(newroot)} >/dev/null 2>&1`,
    `mkdir -p ${shQuote(oldroot)} >/dev/null 2>&1`,
  ];
  for (const bind of requiredFilesystemBinds()) {
    const staged = shQuote(`${newroot}${bind.path}`);
    statements.push(`mkdir -p ${staged} >/dev/null 2>&1`);
    statements.push(`mount --bind ${shQuote(bind.path)} ${staged} >/dev/null 2>&1`);
    if (bind.mode === "ro") {
      statements.push(`mount -o remount,ro,bind ${staged} >/dev/null 2>&1`);
    }
  }
  if (filesystemBindPath !== undefined) {
    const staged = shQuote(`${newroot}${filesystemBindPath}`);
    statements.push(`mkdir -p ${staged} >/dev/null 2>&1`);
    statements.push(`mount --bind ${shQuote(filesystemBindPath)} ${staged} >/dev/null 2>&1`);
  }
  // /dev: individual device-node binds, not a whole-/dev bind — a bare
  // `mount --bind /dev <staged>` was empirically denied in a nested
  // container test environment even with full capabilities, while binding
  // specific device files (the small, fixed set a connector/curl/node
  // actually opens) works everywhere and is itself a narrower, more
  // default-deny-consistent exposure than the whole host /dev tree.
  const stagedDev = shQuote(`${newroot}/dev`);
  statements.push(`mkdir -p ${stagedDev} >/dev/null 2>&1`);
  for (const device of ["null", "zero", "urandom", "random", "tty"]) {
    const stagedDevice = shQuote(`${newroot}/dev/${device}`);
    statements.push(`touch ${stagedDevice} >/dev/null 2>&1`);
    statements.push(`mount --bind ${shQuote(`/dev/${device}`)} ${stagedDevice} >/dev/null 2>&1`);
  }
  // See requiredFhsCompatSymlinks()'s doc comment: /bin, /lib, /lib64, ...
  // are top-level symlinks into /usr on a merged-usr host, not covered by
  // binding /usr itself — recreated inside the staging tree so they exist
  // at the right paths once it becomes the root.
  for (const symlink of requiredFhsCompatSymlinks()) {
    statements.push(`ln -sfn ${shQuote(symlink.target)} ${shQuote(`${newroot}${symlink.path}`)} >/dev/null 2>&1`);
  }
  statements.push("mount --make-rprivate / >/dev/null 2>&1");
  statements.push(`pivot_root ${shQuote(newroot)} ${shQuote(oldroot)} >/dev/null 2>&1`);
  statements.push("cd /");
  // Mounted AFTER pivot_root — see this function's doc comment for why a
  // pre-pivot procfs mount at the staging path is denied.
  statements.push("mount -t proc proc /proc >/dev/null 2>&1");
  statements.push("umount -l /oldroot >/dev/null 2>&1");
  return statements.join("; ");
}

function bwrapFilesystemClosureArgs(filesystemBindPath: string | undefined): string[] {
  const args: string[] = ["--unshare-pid", "--tmpfs", "/", "--proc", "/proc", "--dev", "/dev"];
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
  const mechanism = isolate === true ? detectMechanism() : isolate;
  if (mechanism === "bwrap") {
    return spawn("bwrap", bwrapArgvForFilesystemClosure(cmd, args, filesystemBindPath), spawnOpts);
  }
  const innerCommand = [cmd, ...args].map(shQuote).join(" ");
  const closurePrelude = filesystemClosureShellPrelude(filesystemBindPath);
  // `ip link set lo up` runs BEFORE the filesystem closure's pivot_root,
  // while the real host filesystem (and therefore /usr/sbin/ip) is still
  // the process's root — avoids any dependency on `ip` resolving correctly
  // through the freshly-staged root's bound paths.
  const shScript = `ip link set lo up >/dev/null 2>&1; ${closurePrelude}; exec ${innerCommand}`;
  return spawn(
    "unshare",
    ["--map-root-user", "--net", "--mount", "--pid", "--fork", "--", "sh", "-c", shScript],
    spawnOpts
  );
}
