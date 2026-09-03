// The pilot reported "host capability gap: `unshare -r -n true` fails" and
// stopped there. On this class of host that conclusion is wrong: Ubuntu
// 24.04+ sets apparmor_restrict_unprivileged_userns=1, which denies a bare
// `unshare` while the shipped `bwrap-userns-restrict` AppArmor profile still
// grants bubblewrap the same capability. So the host CAN isolate; only the
// mechanism the harness reached for was blocked.
//
// These tests pin that the probe reports a usable mechanism wherever one
// exists, and — the property that actually matters — that a process spawned
// under it has no outbound network.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bwrapArgvForFilesystemClosure,
  findPreexistingSocketsUnderReadOnlyBinds,
  isNamespaceIsolationAvailable,
  postPivotVerificationStatements,
  requiredFilesystemBinds,
  resolveTrustedLauncherPath,
  spawnWithNetworkIsolation,
} from "./isolation.ts";

const bwrapUsable =
  process.platform === "linux" &&
  spawnSync("bwrap", ["--unshare-net", "--dev-bind", "/", "/", "true"], { stdio: "ignore", timeout: 5000 }).status ===
    0;

const unshareUsable =
  process.platform === "linux" &&
  spawnSync("unshare", ["-r", "-n", "-m", "true"], { stdio: "ignore", timeout: 5000 }).status === 0;

/** True when this test process can actually shadow a real trusted-path
 *  binary via a host-level bind mount (root or an equivalent capability) —
 *  the injection mechanism the test below needs now that the prelude
 *  resolves its setup commands through a fixed `TRUSTED_SETUP_PATH`
 *  (P1-1, ninth review) rather than the caller's inherited `$PATH`. Probed
 *  by attempting the exact bind-then-unbind sequence the real test performs,
 *  against a scratch file, so the skip condition matches the test's actual
 *  requirement rather than a proxy for it (e.g. `process.getuid() === 0`
 *  would be wrong inside a rootless-but-capable container). */
function canBindMountOverAFile(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  const probeSource = mkdtempSync(join(tmpdir(), "pdpp-bindmount-probe-src-"));
  const probeTarget = mkdtempSync(join(tmpdir(), "pdpp-bindmount-probe-dst-"));
  const srcFile = join(probeSource, "a");
  const dstFile = join(probeTarget, "b");
  writeFileSync(srcFile, "");
  writeFileSync(dstFile, "");
  const bound = spawnSync("mount", ["--bind", srcFile, dstFile], { stdio: "ignore" }).status === 0;
  if (bound) {
    spawnSync("umount", [dstFile], { stdio: "ignore" });
  }
  rmSync(probeSource, { recursive: true, force: true });
  rmSync(probeTarget, { recursive: true, force: true });
  return bound;
}

const bindMountCapable = unshareUsable && canBindMountOverAFile();

test("a host that denies `unshare` but ships a working bwrap still reports isolation AVAILABLE", {
  skip: !bwrapUsable,
}, () => {
  const cap = isNamespaceIsolationAvailable();
  assert.equal(cap.available, true, "bwrap works here, so the probe must not declare the host incapable");
  if (cap.available) {
    assert.ok(
      cap.mechanism === "bwrap" || cap.mechanism === "unshare",
      `mechanism must name how isolation is achieved; got ${String(cap.mechanism)}`
    );
  }
});

test("an isolated child has NO outbound network — the property, not the mechanism", {
  skip: !bwrapUsable,
}, async () => {
  const cap = isNamespaceIsolationAvailable();
  assert.equal(cap.available, true);
  const exitCode = await new Promise<number | null>((resolve) => {
    // process.execPath, not a bare "node" — the real caller
    // (bin/scenario-verify.ts) always spawns via the absolute path; a bare
    // command name depends on PATH resolving inside the default-deny root,
    // which is a property of the CALLER's PATH layout, not of isolation
    // itself, and out of scope for what this test exists to prove.
    const child = spawnWithNetworkIsolation(
      process.execPath,
      [
        "-e",
        'require("http").get("http://1.1.1.1",()=>process.exit(9)).on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),4000)',
      ],
      { isolate: true, stdio: "ignore" }
    );
    child.on("close", resolve);
  });
  assert.equal(exitCode, 0, "exit 9 would mean the child reached the network — isolation is not real");
});

// ─── Bubblewrap probe production-equivalence (P2-1, ninth review) ─────────
//
// The OLD probeBwrap() ran a bare `bwrap --unshare-net --dev-bind / / true`
// — the MOST PERMISSIVE root shape bwrap can be given, sharing almost
// nothing with the derived, default-deny argv `bwrapArgvForFilesystemClosure`
// actually builds for production (empty --tmpfs / root, --unshare-pid/-ipc/
// -uts, fresh --proc/--dev, every requiredFilesystemBinds() entry, FHS
// symlinks, workspace bind). A host could satisfy the bare check while being
// unable to satisfy the far narrower real one. This test proves the FIXED
// probe actually invokes bwrap with THAT SAME real argv shape — captured via
// a logging shim (same technique the double-probe regression tests below
// use) rather than trusted by reading the source, so a future edit that
// reverts to a bare/simplified probe argv is caught mechanically.

// INJECTION MECHANISM (P1, external review of ab415be6c — trusted launcher
// resolution): this test used to shadow `bwrap` via a PATH-prepended shim
// directory. Now that the probe resolves the launcher through
// `resolveTrustedLauncherPath` (a fixed allowlist of trusted directories,
// never the caller's inherited `$PATH`), a PATH-prepended shim is no longer
// selected — proving the fix works, but also meaning a test that still
// relied on PATH-shadowing to intercept the launcher would silently stop
// exercising anything. The injection is done the only way that still
// reaches a trusted-path binary: bind-mounting the logging shim DIRECTLY
// OVER the real trusted-path `bwrap` binary for the duration of the test,
// via `withShimmedTrustedBinary` (defined below — a hoisted function
// declaration, callable here despite the later textual position).
test("[bwrap] the fixed probeBwrap() invokes bwrap with the SAME production argv shape bwrapArgvForFilesystemClosure builds — not a bare --dev-bind / / check", {
  skip: !(bwrapUsable && bindMountCapable),
}, async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-probe-argv-log-"));
  const logPath = join(logDir, "invocations.log");
  writeFileSync(logPath, "");
  try {
    await withShimmedTrustedBinary(
      "bwrap",
      (realBwrapPath) =>
        ["#!/bin/sh", `echo "$*" >> ${JSON.stringify(logPath)}`, `exec ${realBwrapPath} "$@"`].join("\n"),
      () => {
        const cap = isNamespaceIsolationAvailable();
        // Only meaningful when bwrap is genuinely what got selected (on a
        // host where unshare is denied but bwrap works — this suite's own
        // AppArmor-restricted dev sandbox is exactly that shape); skip the
        // argv assertion (but still ran the probe) otherwise.
        const invocations = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
        if (cap.available && cap.mechanism === "bwrap") {
          assert.equal(
            invocations.length,
            1,
            `expected exactly one bwrap probe invocation; got ${JSON.stringify(invocations)}`
          );
          const probeArgv = invocations[0] ?? "";
          assert.ok(
            probeArgv.includes("--tmpfs") && !probeArgv.includes("--dev-bind"),
            `probe argv must use the empty --tmpfs / root, never --dev-bind / /; got ${JSON.stringify(probeArgv)}`
          );
          assert.ok(
            probeArgv.includes("--unshare-pid"),
            `probe argv must include --unshare-pid, matching production's derived closure; got ${JSON.stringify(probeArgv)}`
          );
          assert.ok(
            probeArgv.includes("--ro-bind") || probeArgv.includes("--bind"),
            `probe argv must include the derived requiredFilesystemBinds() entries, not just namespace flags; got ${JSON.stringify(probeArgv)}`
          );
        }
        return Promise.resolve();
      }
    );
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

// ─── Probe-honesty: advertise-vs-honor (forced PID-ns procfs-mount refusal) ─
//
// An independent review found a concrete host shape — Docker `--cap-add=
// SYS_ADMIN` granted without full `--privileged`, so Docker's default
// procfs-subpath masking is still active — where `unshare -r -n true`
// (the OLD probe's entire check) succeeds, but the PID-namespace's own
// `mount -t proc proc /proc` is refused by the kernel's "too revealing"
// check. Under the old probe, that host reported `available: true`,
// `unshare` got selected over `bwrap`, and the real spawn then ran to
// completion with `/proc` silently mounted-but-empty. Reproducing that
// exact container shape here (a real Docker container with real kernel
// behavior) isn't practical inside this fast test suite, so these tests
// simulate the SAME two-part failure signature (namespace creation exits 0,
// procfs mount then fails) with a fake `unshare` shim on PATH — proving the
// PROBE's own logic correctly turns that signature into `available: false`
// with a diagnostic naming the refusal, and that the runtime then falls back
// to bwrap (or fails closed) rather than silently proceeding. This is a
// logic-level proof of the fix, complementary to (not a replacement for) the
// live container reproduction recorded in the review notes.

// INJECTION MECHANISM (P1, external review of ab415be6c — trusted launcher
// resolution): these two tests used to shadow `unshare`/`bwrap` via a
// PATH-prepended fake-bin directory. Now that both the probe and the real
// execution resolve the launcher through `resolveTrustedLauncherPath` (a
// fixed allowlist, never the caller's `$PATH`), that injection no longer
// reaches anything — proving the fix, but also meaning a test still relying
// on it would silently stop exercising the fallback logic. Both fakes are
// now installed via bind-mounting DIRECTLY OVER the real trusted-path
// `unshare`/`bwrap` binaries (`withShimmedTrustedBinary`, same technique the
// setup-command forced-failure tests below already use), nested so both
// binaries are shimmed for the duration of each test.

/** Shim body mimicking the exact advertise-vs-honor failure shape: any
 *  invocation whose argv contains `mount -t proc proc /proc` (the probe's
 *  own mount-and-verify dry run, or the real prelude's) exits 32 with a
 *  stderr line matching the real kernel refusal, `mount: /proc: permission
 *  denied.` — every other invocation shape (a bare capability probe like
 *  `-r -n true`) exits 0, so namespace CREATION still looks available; only
 *  the procfs mount specifically is refused, mirroring the CAP_SYS_ADMIN
 *  -only container shape exactly. Ignores `realUnsharePath` (unlike the
 *  setup-command shims elsewhere in this file, this fake never delegates —
 *  the whole point is to mimic the OLD probe's blind spot, not to actually
 *  run real `unshare`). */
function unshareShimRefusingProcMount(_realUnsharePath: string): string {
  return [
    "#!/bin/sh",
    'case "$*" in',
    '  *"mount -t proc proc /proc"*)',
    '    echo "mount: /proc: permission denied." 1>&2',
    "    exit 32",
    "    ;;",
    "  *)",
    "    exit 0",
    "    ;;",
    "esac",
  ].join("\n");
}

/** Shim body that always succeeds — used to prove the fallback path is
 *  taken (not just that `unshare` was correctly rejected). */
function bwrapShimAlwaysAvailable(_realBwrapPath: string): string {
  return "#!/bin/sh\nexit 0\n";
}

/** Shim body that always fails — used so the "no fallback available" test
 *  is not accidentally rescued by a real, working bwrap. */
function bwrapShimAlwaysUnavailable(_realBwrapPath: string): string {
  return '#!/bin/sh\necho "bwrap: Creating new namespace failed: Operation not permitted" 1>&2\nexit 1\n';
}

test("probe reports UNAVAILABLE (not available-then-crash) when unshare's PID-ns procfs mount is refused, with no working bwrap fallback", {
  skip: !bindMountCapable,
}, async () => {
  await withShimmedTrustedBinary("unshare", unshareShimRefusingProcMount, () =>
    withShimmedTrustedBinary("bwrap", bwrapShimAlwaysUnavailable, () => {
      const cap = isNamespaceIsolationAvailable();
      assert.equal(
        cap.available,
        false,
        "a host where namespace creation succeeds but the PID-namespace procfs mount is refused must report UNAVAILABLE, not available-then-crash-later"
      );
      if (!cap.available) {
        assert.ok(
          /permission denied|mount/i.test(cap.reason),
          `the diagnostic must name the kernel-level mount refusal, not just 'unavailable'; got ${JSON.stringify(cap.reason)}`
        );
      }
      return Promise.resolve();
    })
  );
});

test("probe falls back to bwrap when unshare's procfs mount is refused but bwrap genuinely works", {
  skip: !bindMountCapable,
}, async () => {
  await withShimmedTrustedBinary("unshare", unshareShimRefusingProcMount, () =>
    withShimmedTrustedBinary("bwrap", bwrapShimAlwaysAvailable, () => {
      const cap = isNamespaceIsolationAvailable();
      assert.equal(
        cap.available,
        true,
        "a host where unshare's procfs mount is refused but bwrap genuinely works must still report AVAILABLE — the fallback exists precisely for this shape"
      );
      if (cap.available) {
        assert.equal(
          cap.mechanism,
          "bwrap",
          "must select bwrap, not unshare — unshare demonstrably cannot honor the isolation it would advertise on this (simulated) host"
        );
      }
      return Promise.resolve();
    })
  );
});

test("a forced PID-ns procfs-mount refusal inside the real unshare-mechanism prelude fails the spawn closed, never silently proceeds", {
  skip: !bindMountCapable,
}, async () => {
  // Complementary to the probe-level tests above: this proves the SECOND,
  // independent gate — filesystemClosureShellPrelude's own fail-loud check —
  // actually fires, for a caller that bypasses isNamespaceIsolationAvailable()
  // and passes a hardcoded isolate: "unshare" directly.
  //
  // INJECTION MECHANISM (P1-1, ninth review): the prelude now resolves every
  // setup command — including `mount` — through a fixed `TRUSTED_SETUP_PATH`
  // rather than the caller's inherited `$PATH`, specifically so a PATH-based
  // shim (this test's OLD mechanism) can no longer shadow it — that sanitized
  // PATH is itself part of what this hardening closes, so a test that still
  // relied on PATH-shadowing to force this failure would be proving the
  // opposite of what it claims once the fix landed correctly (it would
  // silently stop exercising the fail-closed path at all, always seeing the
  // REAL mount succeed). The forced failure is now injected the only way
  // that still reaches a trusted-path binary: bind-mounting a fake `mount`
  // shim DIRECTLY OVER the real trusted-path `mount` binary on the host
  // (`/usr/bin/mount` or wherever it resolves), for the duration of this
  // test only, unbound in `finally`. The shim delegates to the REAL binary
  // (copied aside first) for every invocation shape except the PID-namespace
  // procfs mount, which it fails with the real kernel's own error text —
  // everything else the prelude needs (mkdir, mount --bind, pivot_root)
  // keeps working via the real binary.
  const realMountPath = spawnSync("which", ["mount"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/mount";
  const scratchDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-fake-mount-fail-"));
  const mountBackupPath = join(scratchDir, "mount.real");
  const shimPath = join(scratchDir, "mount.shim");
  cpSync(realMountPath, mountBackupPath);
  writeFileSync(
    shimPath,
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"-t proc proc /proc"*)',
      '    echo "mount: /proc: permission denied." 1>&2',
      "    exit 32",
      "    ;;",
      "  *)",
      `    exec ${mountBackupPath} "$@"`,
      "    ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 }
  );
  const bindResult = spawnSync("mount", ["--bind", shimPath, realMountPath], { stdio: "inherit" });
  assert.equal(
    bindResult.status,
    0,
    `sanity check: bind-mounting the shim over the real ${realMountPath} must itself succeed for this test's injection to mean anything`
  );
  try {
    const { exitCode, stderrText } = await new Promise<{ exitCode: number | null; stderrText: string }>(
      (resolveResult) => {
        let capturedStderr = "";
        const child = spawnWithNetworkIsolation(process.execPath, ["-e", "process.exit(0)"], {
          isolate: "unshare",
          stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          capturedStderr += chunk.toString("utf8");
        });
        child.on("close", (code) => resolveResult({ exitCode: code, stderrText: capturedStderr }));
      }
    );
    assert.notEqual(
      exitCode,
      0,
      "the spawn must NOT exit 0 when the PID-namespace procfs mount fails — exit 0 here would mean the target command ran despite a broken /proc, the exact silent-proceed failure this hardening closes"
    );
    assert.ok(
      /procfs mount failed/i.test(stderrText) || /permission denied/i.test(stderrText),
      `expected a diagnostic naming the procfs mount failure on stderr; got ${JSON.stringify(stderrText)}`
    );
  } finally {
    spawnSync("umount", [realMountPath], { stdio: "ignore" });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

// ─── Trusted launcher resolution (P1, external review of ab415be6c) ───────
//
// The review's exact finding: `probeUnshare()`/`probeBwrap()` and
// `spawnWithNetworkIsolation`'s real execution both spawned the launcher via
// a BARE command name (`spawnSync("unshare", ...)`, `spawn("bwrap", ...)`),
// which `node:child_process` resolves through the CALLING process's own
// inherited `$PATH` — so a PATH-prepended fake `unshare`/`bwrap` earlier in
// `$PATH` than the real, trusted one gets selected instead. These tests
// prove the fix: (1) at the unit level, `resolveTrustedLauncherPath` finds
// the REAL binary regardless of what `$PATH` says, even with a fake
// prepended; (2) at the end-to-end level, a PATH-prepended fake `unshare`
// is never invoked by either the probe or a real isolated spawn.

test("resolveTrustedLauncherPath: resolves the real trusted-location binary, ignoring a fake earlier in $PATH", {
  skip: process.platform !== "linux",
}, () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-fake-launcher-path-"));
  const fakeMarkerPath = join(fakeBinDir, "fake-unshare-ran");
  writeFileSync(
    join(fakeBinDir, "unshare"),
    ["#!/bin/sh", `touch ${JSON.stringify(fakeMarkerPath)}`, "exit 0"].join("\n"),
    { mode: 0o755 }
  );
  const realPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${realPath ?? ""}`;
  try {
    const resolved = resolveTrustedLauncherPath("unshare");
    assert.ok(
      !resolved.startsWith(fakeBinDir),
      `resolveTrustedLauncherPath must never return the PATH-prepended fake; got ${JSON.stringify(resolved)}`
    );
    assert.ok(
      ["/usr/sbin/unshare", "/usr/bin/unshare", "/sbin/unshare", "/bin/unshare"].includes(resolved),
      `expected a real trusted-directory path; got ${JSON.stringify(resolved)}`
    );
    // Actually running the resolved binary must not be the fake — the fake
    // would touch its own marker file the instant it started.
    spawnSync(resolved, ["-r", "-n", "true"], { stdio: "ignore" });
    assert.ok(
      !existsSync(fakeMarkerPath),
      "the fake unshare's marker file must NOT exist — resolveTrustedLauncherPath's return value must never invoke the fake"
    );
  } finally {
    process.env.PATH = realPath;
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("a PATH-prepended fake `unshare` is never selected by the probe or by a real isolated spawn", {
  skip: !unshareUsable,
}, async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-fake-launcher-e2e-"));
  const fakeMarkerPath = join(fakeBinDir, "fake-unshare-ran");
  // The fake always "succeeds" instantly (exit 0, no real namespace, no real
  // isolation) — if it were ever selected, both the probe and a real spawn
  // would misreport success while providing NO isolation at all. Also
  // touches its own marker so this test can prove, directly, that the fake
  // was never invoked (not just that isolation happened to still work).
  writeFileSync(
    join(fakeBinDir, "unshare"),
    ["#!/bin/sh", `touch ${JSON.stringify(fakeMarkerPath)}`, "exit 0"].join("\n"),
    { mode: 0o755 }
  );
  const realPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${realPath ?? ""}`;
  try {
    const cap = isNamespaceIsolationAvailable();
    assert.ok(
      !existsSync(fakeMarkerPath),
      "the fake unshare's marker must NOT exist after the capability probe — the probe must resolve the real trusted-path binary, never the PATH-prepended fake"
    );
    if (cap.available && cap.mechanism === "unshare") {
      // Only meaningful when the probe genuinely selected unshare (true on
      // this suite's own host, where unshare works natively) — prove a real
      // spawn under `isolate: true` (which re-derives the mechanism itself,
      // exercising the SAME resolution path as production) also never
      // touches the fake, and that the child is genuinely isolated (no
      // outbound network) rather than the fake's instant, unisolated exit 0.
      const exitCode = await new Promise<number | null>((resolveExit) => {
        const child = spawnWithNetworkIsolation(
          process.execPath,
          [
            "-e",
            'require("http").get("http://1.1.1.1",()=>process.exit(9)).on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),4000)',
          ],
          { isolate: true, stdio: "ignore" }
        );
        child.on("close", resolveExit);
      });
      assert.ok(
        !existsSync(fakeMarkerPath),
        "the fake unshare's marker must NOT exist after a real isolated spawn — spawnWithNetworkIsolation must resolve the real trusted-path binary, never the PATH-prepended fake"
      );
      assert.equal(
        exitCode,
        0,
        "the spawn must still be genuinely network-isolated (exit 9 would mean the fake ran instead and no real isolation happened)"
      );
    }
  } finally {
    process.env.PATH = realPath;
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

// ─── Trusted shell resolution (P1-1, external review of ced8300be) ────────
//
// The review's exact finding: the trusted-launcher fix above closes how
// `unshare`/`bwrap` THEMSELVES are resolved, but never touched the `sh` those
// launchers exec their closure script into — both `unshareProcMountProbeArgv()`
// (the probe) and `spawnWithNetworkIsolation`'s `unshare` branch (the real
// execution) passed the bare string `"sh"` as an argv entry to the
// already-trusted `unshare` binary (`unshare ... -- sh -c <script>`).
// `unshare` performs `execvp("sh", ...)` on that argv entry, and `execvp`
// resolves a bare name through the PATH environment variable of the process
// PERFORMING THE EXEC at that moment — the calling Node process's own
// `spawn()` env, fully caller-controlled — NOT `TRUSTED_SETUP_PATH` (that
// assignment is the FIRST STATEMENT INSIDE the very script the fake `sh`
// would be asked to interpret, too late to matter: a fake `sh` can ignore it,
// skip straight to running the connector unisolated, and still report
// success).
//
// A trivial marker-touch-and-exit-0 fake would only prove the fake was never
// invoked — it would NOT prove the specific exploit this closes, because a
// naive test could pass by coincidence (e.g. if isolation still worked via
// some other path). These fakes are FUNCTIONING substitutes instead: the
// probe fake prints the real success sentinel and exits 0 WITHOUT performing
// the actual `--map-root-user --net --mount --pid --ipc --uts --fork` mount
// sequence a real `sh` would (it can't, since only a real trusted `sh` would
// even receive namespace capabilities in a way that matters — the fake just
// unconditionally claims success), and the execution fake execs the target
// command directly with no filesystem closure or network isolation at all —
// exactly what "a fake sh silently reports success and skips real
// containment" looks like if this fix were absent. Each still touches its
// own marker file so the test can assert, directly, that it was never
// invoked at all — not merely that the outward-visible behavior happened to
// look correct.

test("resolveTrustedLauncherPath('sh'): resolves the real trusted-location shell, ignoring a fake earlier in $PATH", {
  skip: process.platform !== "linux",
}, () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-fake-sh-path-"));
  const fakeMarkerPath = join(fakeBinDir, "fake-sh-ran");
  writeFileSync(join(fakeBinDir, "sh"), ["#!/bin/sh", `touch ${JSON.stringify(fakeMarkerPath)}`, "exit 0"].join("\n"), {
    mode: 0o755,
  });
  const realPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${realPath ?? ""}`;
  try {
    const resolved = resolveTrustedLauncherPath("sh");
    assert.ok(
      !resolved.startsWith(fakeBinDir),
      `resolveTrustedLauncherPath('sh') must never return the PATH-prepended fake; got ${JSON.stringify(resolved)}`
    );
    // Unlike `unshare`/`bwrap` (real binaries at their own name), `/bin/sh`
    // is commonly a symlink to a DIFFERENTLY-NAMED real shell on a
    // merged-usr host (e.g. Debian/Ubuntu's `/bin/sh` -> `dash`) —
    // `resolveTrustedLauncherPath` follows that symlink via `realpathSync`
    // (same as it does for `unshare`/`bwrap`, see that function's doc
    // comment), so the resolved path's BASENAME need not be `sh`. Assert the
    // trust boundary that actually matters instead: an absolute path,
    // rooted under one of the fixed trusted directories, executable.
    assert.ok(resolved.startsWith("/"), `expected an absolute path; got ${JSON.stringify(resolved)}`);
    assert.ok(
      ["/usr/sbin/", "/usr/bin/", "/sbin/", "/bin/"].some((dir) => resolved.startsWith(dir)),
      `expected a path under a trusted directory; got ${JSON.stringify(resolved)}`
    );
    spawnSync(resolved, ["-c", "true"], { stdio: "ignore" });
    assert.ok(
      !existsSync(fakeMarkerPath),
      "the fake sh's marker file must NOT exist — resolveTrustedLauncherPath('sh')'s return value must never invoke the fake"
    );
  } finally {
    process.env.PATH = realPath;
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

/** Builds a FUNCTIONING fake `sh` for the probe path: prints the exact
 *  success sentinel `unshareProcMountProbeArgv()` looks for and exits 0
 *  WITHOUT running any of the real mount-and-verify sequence — the shape
 *  that would make `probeUnshare()` misreport `available: true` off a fake
 *  shell doing none of the real work, if the bare `"sh"` bug were still
 *  present. Also touches `markerPath` so the test can assert directly that
 *  this fake was never invoked, independent of what the probe result was. */
function functioningFakeProbeShellScript(markerPath: string): string {
  return ["#!/bin/sh", `touch ${JSON.stringify(markerPath)}`, "echo PDPP_PROC_MOUNT_OK", "exit 0"].join("\n");
}

/** Builds a FUNCTIONING fake `sh` for the real-execution path: execs
 *  whatever command was passed to `-c` DIRECTLY, with no mount, no
 *  pivot_root, no filesystem closure, no network-isolation setup at all —
 *  the exact "silently skip real containment and just run the connector
 *  unisolated" shape the review's repro describes. Also touches `markerPath`
 *  so the test can assert directly that this fake was never invoked. */
function functioningFakeExecutionShellScript(markerPath: string): string {
  return [
    "#!/bin/sh",
    `touch ${JSON.stringify(markerPath)}`,
    // $2 is the script text passed after `-c` — hand it straight to the
    // REAL /bin/sh so a caller that (incorrectly) believes this fake still
    // ran the closure keeps getting a plausible exit code, but with zero
    // containment actually applied (no namespace setup ran before this).
    'exec /bin/sh -c "$2"',
  ].join("\n");
}

test("a PATH-prepended FUNCTIONING fake `sh` is never invoked by the unshare capability probe", {
  skip: !unshareUsable,
}, () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-fake-sh-probe-"));
  const fakeMarkerPath = join(fakeBinDir, "fake-sh-probe-ran");
  writeFileSync(join(fakeBinDir, "sh"), functioningFakeProbeShellScript(fakeMarkerPath), { mode: 0o755 });
  const realPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${realPath ?? ""}`;
  try {
    const cap = isNamespaceIsolationAvailable();
    assert.ok(
      !existsSync(fakeMarkerPath),
      "the fake sh's marker must NOT exist after the capability probe — the probe must resolve the real trusted-path shell, never the PATH-prepended fake, even though the fake prints the exact success sentinel and would otherwise make the probe misreport success"
    );
    // The probe's own verdict is unaffected by the fake either way (it never
    // ran) — this is a secondary sanity check, not the load-bearing
    // assertion above.
    assert.ok(typeof cap.available === "boolean", "sanity: probe still returns a real verdict");
  } finally {
    process.env.PATH = realPath;
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("a PATH-prepended FUNCTIONING fake `sh` is never invoked by a real isolated unshare spawn — the child stays genuinely network-isolated", {
  skip: !unshareUsable,
}, async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-fake-sh-exec-"));
  const fakeMarkerPath = join(fakeBinDir, "fake-sh-exec-ran");
  writeFileSync(join(fakeBinDir, "sh"), functioningFakeExecutionShellScript(fakeMarkerPath), { mode: 0o755 });
  const realPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${realPath ?? ""}`;
  try {
    const exitCode = await new Promise<number | null>((resolveExit) => {
      const child = spawnWithNetworkIsolation(
        process.execPath,
        [
          "-e",
          'require("http").get("http://1.1.1.1",()=>process.exit(9)).on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),4000)',
        ],
        { isolate: "unshare", stdio: "ignore" }
      );
      child.on("close", resolveExit);
    });
    assert.ok(
      !existsSync(fakeMarkerPath),
      "the fake sh's marker must NOT exist after a real isolated spawn — spawnWithNetworkIsolation must resolve the real trusted-path shell, never the PATH-prepended fake, even though the fake would have execed the target directly with zero containment if it had run"
    );
    assert.equal(
      exitCode,
      0,
      "the spawn must still be genuinely network-isolated (exit 9 would mean the fake sh ran instead and skipped the real filesystem/network closure entirely)"
    );
  } finally {
    process.env.PATH = realPath;
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

// bwrap's own filesystem view is default-deny (`--tmpfs /` plus only
// `requiredFilesystemBinds()`), so a PATH-prepended fake living OUTSIDE that
// view (e.g. a bare `mkdtemp(tmpdir())` scratch dir) is simply unreachable
// from inside the sandbox's own `execvp` — proven empirically (see this
// finding's commit message): bwrap does inherit the caller's PATH env var,
// but `execvp("sh", ...)` inside the sandbox can only find a candidate that
// actually EXISTS in the sandbox's own mount table. That does NOT mean
// bwrap's inner `sh` is safe, though: `filesystemBindPath` (the caller's own
// evidence workspace) is the ONE path every isolated child gets `rw`
// AND — being the caller's own writable directory before the spawn even
// starts — is exactly where an attacker (a compromised connector's own
// setup step, or a caller constructing this path) could plant a same-named
// `sh`. Confirmed empirically: a fake `sh` placed inside `filesystemBindPath`
// and prepended to PATH WAS reached and exec'd by bwrap's old bare-`"sh"`
// argv (its own `touch` failed only because the FIRST version of this repro
// placed the marker under `/usr`, itself `ro`-bound — moving the marker
// inside the same `rw` workspace made the exec visible). This test uses that
// realistic vector, not an unbound scratch dir.
test("a FUNCTIONING fake `sh` planted inside filesystemBindPath (the one rw path a caller/attacker controls) is never invoked by bwrap's inner sh -c wrapper", {
  skip: !bwrapUsable,
}, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pdpp-isolation-fake-sh-bwrap-workspace-"));
  const fakeMarkerPath = join(workspace, "fake-sh-bwrap-ran");
  writeFileSync(join(workspace, "sh"), functioningFakeExecutionShellScript(fakeMarkerPath), { mode: 0o755 });
  const realPath = process.env.PATH;
  // Prepend the WORKSPACE itself (not an unrelated scratch dir) — this is
  // the one location the isolated child's own filesystem view actually
  // contains as `rw`, so a fake placed here is the realistic threat, not a
  // vacuous one bwrap's default-deny root would reject before ever reaching
  // `execvp`.
  process.env.PATH = `${workspace}:${realPath ?? ""}`;
  try {
    const exitCode = await new Promise<number | null>((resolveExit) => {
      const child = spawnWithNetworkIsolation(
        process.execPath,
        [
          "-e",
          'require("http").get("http://1.1.1.1",()=>process.exit(9)).on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),4000)',
        ],
        { isolate: "bwrap", stdio: "ignore", filesystemBindPath: workspace }
      );
      child.on("close", resolveExit);
    });
    assert.ok(
      !existsSync(fakeMarkerPath),
      "the fake sh's marker must NOT exist after a real isolated bwrap spawn — bwrapArgvForFilesystemClosure must resolve the real trusted-path shell, never the PATH-prepended fake planted inside the one rw path (filesystemBindPath) an attacker actually controls"
    );
    assert.equal(
      exitCode,
      0,
      "the spawn must still be genuinely network-isolated (exit 9 would mean the fake sh ran instead and skipped containment)"
    );
  } finally {
    process.env.PATH = realPath;
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ─── Fail-closed setup — forced-failure controls for every mandatory step ──
//
// P1-1 (ninth review): the OLD `filesystemClosureShellPrelude` discarded the
// exit status of EVERY mandatory setup step (staging tmpfs create+mount,
// oldroot dir creation, every required bind, every ro remount,
// `mount --make-rprivate /`, `pivot_root`, `umount -l /oldroot`) via
// `>/dev/null 2>&1` and joined them with `;` — so ANY of these failing left
// the isolated child executing the target command anyway, against a
// filesystem closure that silently never took effect. The fix wraps every
// one of these in `req` (isolation.ts's `reqStatement`/`REQ_FUNCTION_DEFINITION`),
// which halts the whole prelude — never reaching `exec <target>` — the
// instant any ONE of them fails.
//
// Each test below forces exactly one of these steps to fail (via the same
// bind-mount-over-the-real-trusted-binary injection `canBindMountOverAFile`
// proved works, now that PATH-shadowing no longer reaches these commands —
// see the previous test's doc comment) and proves the TARGET COMMAND NEVER
// RAN: the target writes a marker file to a location OUTSIDE the isolated
// child's own view (the real host's `os.tmpdir()`, reachable from this test
// process directly) the instant it starts — if that marker exists after the
// spawn closes, the target ran despite the forced failure, which is exactly
// the silent-proceed defect this hardening closes. A nonzero exit code alone
// is not accepted as proof (a real target crash for an unrelated reason
// would also exit nonzero); only the marker's absence is.

/** Runs `spawnWithNetworkIsolation` under the `unshare` mechanism with a
 *  target command that writes `markerPath` (a real host path, created OUTSIDE
 *  any isolated child's view) the moment it starts, then reports whether that
 *  marker exists after the child closes — the authoritative "did the target
 *  command actually run" signal every forced-failure test below checks. */
/**
 * `markerPath` for the FORCED-FAILURE tests below is deliberately left
 * unreachable inside the isolated child's own view (a plain `os.tmpdir()`
 * path, not inside any `filesystemBindPath`) — for those tests this is
 * immaterial: a forced setup-step failure means the write is never even
 * ATTEMPTED (the whole prelude halts before `exec <target>`), so
 * `markerWritten` staying `false` proves the same thing regardless of
 * whether `/tmp` itself would have been reachable. The ONE happy-path test
 * (`"a genuinely successful filesystem closure ... DOES run"`) needs the
 * opposite proof — that a successful run's marker WRITE actually lands — so
 * it must pass a `filesystemBindPath` the marker lives inside (see that
 * test's own call site): without one, the marker write would fail with
 * ENOENT for the CORRECT reason (the default-deny root has no `/tmp` at
 * all — proving the closure works, not that it's broken) and this helper
 * would misreport that as `markerWritten: false` either way, indistinguishable
 * from a real forced-failure result.
 */
async function spawnAndCheckMarkerWritten(
  markerPath: string,
  filesystemBindPath?: string
): Promise<{ exitCode: number | null; markerWritten: boolean }> {
  const exitCode = await new Promise<number | null>((resolveExit) => {
    const child = spawnWithNetworkIsolation(
      process.execPath,
      ["-e", `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "ran"); process.exit(0);`],
      { isolate: "unshare", stdio: "ignore", ...(filesystemBindPath === undefined ? {} : { filesystemBindPath }) }
    );
    child.on("close", resolveExit);
    child.on("error", () => resolveExit(-1));
  });
  return { exitCode, markerWritten: existsSync(markerPath) };
}

/** Bind-mounts a shell-script shim OVER the real trusted-path binary named
 *  `binaryName` (resolved via `which`, matching `TRUSTED_SETUP_PATH`'s own
 *  entries — `/usr/sbin`, `/usr/bin`, `/sbin`, `/bin`) for the duration of
 *  `fn`, then unmounts it — same technique the procfs-mount forced-failure
 *  test above uses, generalized to any trusted binary and any shim body so
 *  each test below only needs to supply its own argv-matching failure
 *  condition. The shim ALWAYS falls through to the real binary (copied aside
 *  first) for any invocation it doesn't specifically intend to fail, so every
 *  OTHER step in the prelude keeps working via the genuine tool. */
// A PRIVATE, PERMANENT copy of the real `umount` binary's BYTES, made once at
// module load — before any test has had a chance to shim anything. Every
// `withShimmedTrustedBinary` cleanup execs THIS copy, never a freshly
// `which`-resolved `umount` path. Load-bearing, and subtly different from
// just capturing the PATH string once: a test that shims `umount` ITSELF
// (the oldroot-unmount forced-failure test below) bind-mounts a shim
// directly OVER `/usr/bin/umount` — so even a `umount` path resolved before
// that shim went up would, by the time cleanup runs, resolve to the SAME
// now-shimmed inode at that path; only a separate, independently-backed-up
// COPY of the binary (not just a remembered path to it) survives that.
// Confirmed empirically: with only a captured path (no separate copy), the
// oldroot test's own cleanup tried to run the shim to undo the shim (always
// exits 1), leaving the bind-mount permanently in place and corrupting every
// later test in the same process (the "genuinely successful filesystem
// closure" test, and several unrelated PID/IPC/UTS/UDS tests after it, all
// failed with exit 90 — the real prelude's own legitimate `umount -l
// /oldroot` step kept hitting the leftover shim).
const REAL_UMOUNT_BACKUP_DIR = mkdtempSync(join(tmpdir(), "pdpp-isolation-umount-backup-"));
const REAL_UMOUNT_BACKUP_PATH = join(REAL_UMOUNT_BACKUP_DIR, "umount.real");
cpSync(spawnSync("which", ["umount"], { encoding: "utf8" }).stdout.trim(), REAL_UMOUNT_BACKUP_PATH);

async function withShimmedTrustedBinary<T>(
  binaryName: string,
  shimBody: (realBinaryPath: string) => string,
  fn: () => Promise<T>
): Promise<T> {
  const realBinaryPath = spawnSync("which", [binaryName], { encoding: "utf8" }).stdout.trim();
  assert.ok(realBinaryPath, `expected to resolve a real ${binaryName} via which`);
  const scratchDir = mkdtempSync(join(tmpdir(), `pdpp-isolation-shim-${binaryName}-`));
  const backupPath = join(scratchDir, `${binaryName}.real`);
  const shimPath = join(scratchDir, `${binaryName}.shim`);
  cpSync(realBinaryPath, backupPath);
  writeFileSync(shimPath, shimBody(backupPath), { mode: 0o755 });
  const bindResult = spawnSync("mount", ["--bind", shimPath, realBinaryPath], { stdio: "inherit" });
  assert.equal(
    bindResult.status,
    0,
    `sanity check: bind-mounting the shim over the real ${realBinaryPath} must itself succeed`
  );
  try {
    return await fn();
  } finally {
    const unmountResult = spawnSync(REAL_UMOUNT_BACKUP_PATH, [realBinaryPath], { stdio: "inherit" });
    assert.equal(
      unmountResult.status,
      0,
      `cleanup: unmounting the ${binaryName} shim must itself succeed, or a leftover bind-mount corrupts every later test in this process`
    );
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

/** Builds a `mount` shim body that fails ONLY when the invocation's argv
 *  contains `argvSubstring`, with `stderrLine` as the forced failure's
 *  message — every other invocation shape delegates to the real `mount`
 *  binary at `realMountPath`, so the rest of the closure keeps working. */
function mountShimFailingOn(argvSubstring: string, stderrLine: string): (realMountPath: string) => string {
  return (realMountPath: string) =>
    [
      "#!/bin/sh",
      'case "$*" in',
      `  *${JSON.stringify(argvSubstring)}*)`,
      `    echo ${JSON.stringify(stderrLine)} 1>&2`,
      "    exit 1",
      "    ;;",
      "  *)",
      `    exec ${realMountPath} "$@"`,
      "    ;;",
      "esac",
    ].join("\n");
}

test("[unshare] forced staging-tmpfs-mount failure — the target command never runs", {
  skip: !bindMountCapable,
}, async () => {
  const markerPath = join(tmpdir(), `pdpp-isolation-marker-tmpfs-${String(process.pid)}`);
  rmSync(markerPath, { force: true });
  try {
    await withShimmedTrustedBinary(
      "mount",
      mountShimFailingOn("-t tmpfs tmpfs", "mount: staging tmpfs mount forced failure (test)"),
      async () => {
        const { exitCode, markerWritten } = await spawnAndCheckMarkerWritten(markerPath);
        assert.notEqual(exitCode, 0, "spawn must not exit 0 when the staging tmpfs mount fails");
        assert.equal(
          markerWritten,
          false,
          "the target command must NEVER run when the staging tmpfs mount fails — this is the exact false-success shape P1-1 closes"
        );
      }
    );
  } finally {
    rmSync(markerPath, { force: true });
  }
});

test("[unshare] forced required-bind failure (binding /usr into the staging tree) — the target command never runs", {
  skip: !bindMountCapable,
}, async () => {
  const markerPath = join(tmpdir(), `pdpp-isolation-marker-bind-${String(process.pid)}`);
  rmSync(markerPath, { force: true });
  try {
    // Matches the FIRST required bind's mountpoint pattern specifically
    // (`--rbind /usr <staged>/usr`) rather than every `--rbind` invocation,
    // so the workspace bind and every OTHER required bind still succeed —
    // proving this ONE bind's failure alone halts the whole prelude, not
    // that binds fail categorically.
    await withShimmedTrustedBinary(
      "mount",
      mountShimFailingOn("--rbind /usr", "mount: /usr bind forced failure (test)"),
      async () => {
        const { exitCode, markerWritten } = await spawnAndCheckMarkerWritten(markerPath);
        assert.notEqual(exitCode, 0, "spawn must not exit 0 when a required bind fails");
        assert.equal(markerWritten, false, "the target command must NEVER run when a required filesystem bind fails");
      }
    );
  } finally {
    rmSync(markerPath, { force: true });
  }
});

test("[unshare] forced read-only-remount failure — the target command never runs (P1-1 scenario (b): a preceding bind stays writable and nothing verifies)", {
  skip: !bindMountCapable,
}, async () => {
  const markerPath = join(tmpdir(), `pdpp-isolation-marker-roremount-${String(process.pid)}`);
  rmSync(markerPath, { force: true });
  try {
    await withShimmedTrustedBinary(
      "mount",
      mountShimFailingOn("remount,ro,bind", "mount: ro remount forced failure (test)"),
      async () => {
        const { exitCode, markerWritten } = await spawnAndCheckMarkerWritten(markerPath);
        assert.notEqual(exitCode, 0, "spawn must not exit 0 when a ro remount fails");
        assert.equal(
          markerWritten,
          false,
          "the target command must NEVER run when a declared ro bind's remount fails — under the OLD prelude this left the bind silently writable with no verification"
        );
      }
    );
  } finally {
    rmSync(markerPath, { force: true });
  }
});

test("[unshare] forced make-rprivate failure — the target command never runs", {
  skip: !bindMountCapable,
}, async () => {
  const markerPath = join(tmpdir(), `pdpp-isolation-marker-rprivate-${String(process.pid)}`);
  rmSync(markerPath, { force: true });
  try {
    await withShimmedTrustedBinary(
      "mount",
      mountShimFailingOn("--make-rprivate", "mount: make-rprivate forced failure (test)"),
      async () => {
        const { exitCode, markerWritten } = await spawnAndCheckMarkerWritten(markerPath);
        assert.notEqual(exitCode, 0, "spawn must not exit 0 when make-rprivate fails");
        assert.equal(
          markerWritten,
          false,
          "the target command must NEVER run when detaching root mount propagation fails — a failure here means pivot_root could propagate back to the real host mount namespace"
        );
      }
    );
  } finally {
    rmSync(markerPath, { force: true });
  }
});

test("[unshare] forced pivot_root failure — the target command never runs (P1-1 scenario (a): the ORIGINAL false-success shape)", {
  skip: !bindMountCapable,
}, async () => {
  const markerPath = join(tmpdir(), `pdpp-isolation-marker-pivotroot-${String(process.pid)}`);
  rmSync(markerPath, { force: true });
  try {
    await withShimmedTrustedBinary(
      "pivot_root",
      // pivot_root has no argv shape worth distinguishing (this prelude only
      // ever calls it once, with the staging/oldroot paths) — the shim fails
      // unconditionally.
      () => ["#!/bin/sh", 'echo "pivot_root: forced failure (test)" 1>&2', "exit 1"].join("\n"),
      async () => {
        const { exitCode, markerWritten } = await spawnAndCheckMarkerWritten(markerPath);
        assert.notEqual(
          exitCode,
          0,
          "spawn must not exit 0 when pivot_root fails — under the OLD prelude this is scenario (a): cd / then succeeded against the ORIGINAL host root, the procfs sentinel could still pass, and the target ran against the unmodified host filesystem"
        );
        assert.equal(
          markerWritten,
          false,
          "the target command must NEVER run when pivot_root fails — this is the single most severe false-success shape P1-1 closes: the child would otherwise execute against the REAL HOST ROOT while network/PID/IPC namespaces still isolated it, so the isolation looked entirely healthy"
        );
      }
    );
  } finally {
    rmSync(markerPath, { force: true });
  }
});

test("[unshare] forced oldroot-unmount failure — the target command never runs (P1-1 scenario (c): the entire host root stays reachable under /oldroot)", {
  skip: !bindMountCapable,
}, async () => {
  const markerPath = join(tmpdir(), `pdpp-isolation-marker-umount-${String(process.pid)}`);
  rmSync(markerPath, { force: true });
  try {
    await withShimmedTrustedBinary(
      "umount",
      () => ["#!/bin/sh", 'echo "umount: forced failure (test)" 1>&2', "exit 1"].join("\n"),
      async () => {
        const { exitCode, markerWritten } = await spawnAndCheckMarkerWritten(markerPath);
        assert.notEqual(exitCode, 0, "spawn must not exit 0 when the oldroot lazy-unmount fails");
        assert.equal(
          markerWritten,
          false,
          "the target command must NEVER run when detaching /oldroot fails — under the OLD prelude this failure was silently ignored and the entire host root stayed reachable under /oldroot for the isolated child's whole lifetime"
        );
      }
    );
  } finally {
    rmSync(markerPath, { force: true });
  }
});

// ─── Post-pivot verification — proves the properties, not just the gate ───
//
// Complementary to the forced-STEP-failure tests above: those prove a failed
// SETUP step halts the prelude. This section proves the separate, LAST gate
// (`postPivotVerificationStatements` — P1-1 requirement (c)) actually
// verifies what it claims: new root active, /oldroot unreachable, every
// declared ro bind genuinely read-only. Since every scenario that would make
// this gate's own checks fail is ALSO caught by one of the forced-step
// failures above (a broken pivot_root, a broken ro remount, a broken oldroot
// unmount all halt at the `req`-wrapped step itself before this gate is even
// reached), this section instead proves the gate's OWN LOGIC is correct by
// running it standalone against both a genuinely-successful closure (must
// pass) and a hand-constructed failing shape (must fail) — a mutation-style
// proof of the verification code itself, the same discipline the bwrap argv
// guard's own mutation tests already apply.

/**
 * Runs `postPivotVerificationStatements(binds)` (the REAL source, not a
 * hand-copied string — so this test tracks the actual generated shell logic)
 * inside a lightweight `bwrap` sandbox standing in for a post-pivot root —
 * bwrap needs no elevated privilege beyond what this suite's `bwrapUsable`
 * check already requires, so this runs on every host the bwrap-mechanism
 * tests already run on, not just inside the `unshareUsable`-gated privileged
 * container. `writableBindTarget`, if given, is bind-mounted `rw` at
 * `/writable-fake-bind` (simulating a `ro`-declared bind whose remount
 * silently never took effect — this test's caller passes it as one of
 * `binds` too, with `mode: "ro"`, so the verification snippet's OWN ro-write
 * probe is what's under test, not this harness's bwrap setup). Creates
 * `/pdpp-isolation-canary` and `/oldroot` (both real, matching what the real
 * unshare-mechanism prelude leaves in place before running this same
 * verification) so the "happy path" shape is the default; a test wanting the
 * canary-missing or oldroot-nonempty failure shape passes `skipCanary`/
 * `leaveOldrootNonempty`.
 */
function runPostPivotVerificationInSandbox(options: {
  binds: readonly { path: string; mode: "ro" | "rw" }[];
  leaveOldrootNonempty?: boolean;
  skipCanary?: boolean;
  writableBindTarget?: string;
}): { exitCode: number | null; stderrText: string } {
  const setup = [
    options.skipCanary ? "true" : "touch /pdpp-isolation-canary",
    "mkdir -p /oldroot",
    options.leaveOldrootNonempty ? "touch /oldroot/leftover-file" : "true",
  ].join("; ");
  const script = `${setup}; ${postPivotVerificationStatements(options.binds).join("; ")}; echo PDPP_VERIFY_PASSED`;
  const args = [
    "--unshare-net",
    "--tmpfs",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/etc",
    "/etc",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
  ];
  if (options.writableBindTarget !== undefined) {
    args.push("--bind", options.writableBindTarget, "/writable-fake-bind");
  }
  args.push("--", "sh", "-c", script);
  const result = spawnSync("bwrap", args, { encoding: "utf8" });
  return { exitCode: result.status, stderrText: result.stderr };
}

test("[bwrap sandbox] postPivotVerificationStatements PASSES a genuinely-closed filesystem (canary present, oldroot empty, ro binds actually read-only)", {
  skip: !bwrapUsable,
}, () => {
  const { exitCode, stderrText } = runPostPivotVerificationInSandbox({ binds: [{ path: "/etc", mode: "ro" }] });
  assert.equal(exitCode, 0, `expected the happy-path shape to pass verification; stderr: ${stderrText}`);
  assert.equal(stderrText, "", "a passing verification must not print a diagnostic");
});

test("[bwrap sandbox] postPivotVerificationStatements FAILS when a declared ro bind is actually writable (P1-1 scenario (b))", {
  skip: !bwrapUsable,
}, () => {
  const writableDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-writable-ro-probe-"));
  try {
    const { exitCode, stderrText } = runPostPivotVerificationInSandbox({
      binds: [{ path: "/writable-fake-bind", mode: "ro" }],
      writableBindTarget: writableDir,
    });
    assert.equal(
      exitCode,
      91,
      `expected POST_PIVOT_VERIFICATION_FAILURE_EXIT_CODE (91) when a declared ro bind is genuinely writable; stderr: ${stderrText}`
    );
    assert.ok(
      /writable-ro-binds=\[\/writable-fake-bind\]/.test(stderrText),
      `expected the diagnostic to name the specific writable path; got ${JSON.stringify(stderrText)}`
    );
  } finally {
    rmSync(writableDir, { recursive: true, force: true });
  }
});

test("[bwrap sandbox] postPivotVerificationStatements FAILS when the root-active canary is missing (P1-1 scenario (a))", {
  skip: !bwrapUsable,
}, () => {
  const { exitCode, stderrText } = runPostPivotVerificationInSandbox({
    binds: [{ path: "/etc", mode: "ro" }],
    skipCanary: true,
  });
  assert.equal(exitCode, 91, `expected failure when the canary is absent; stderr: ${stderrText}`);
  assert.ok(
    /new-root-active=0/.test(stderrText),
    `expected the diagnostic to report new-root-active=0; got ${JSON.stringify(stderrText)}`
  );
});

test("[bwrap sandbox] postPivotVerificationStatements FAILS when /oldroot is non-empty (P1-1 scenario (c))", {
  skip: !bwrapUsable,
}, () => {
  const { exitCode, stderrText } = runPostPivotVerificationInSandbox({
    binds: [{ path: "/etc", mode: "ro" }],
    leaveOldrootNonempty: true,
  });
  assert.equal(exitCode, 91, `expected failure when /oldroot still has a leftover entry; stderr: ${stderrText}`);
  assert.ok(
    /oldroot-leftover=\[\/oldroot\/leftover-file\]/.test(stderrText),
    `expected the diagnostic to name the leftover oldroot entry; got ${JSON.stringify(stderrText)}`
  );
});

test("[bwrap sandbox] postPivotVerificationStatements FAILS when a NESTED submount under a genuinely-read-only ro bind is writable (P1, external review of ab415be6c)", {
  skip: !(bwrapUsable && bindMountCapable),
}, () => {
  // Unlike scenario (b) above (a bind whose OWN top mount never went
  // read-only), this proves the EXTENDED property: the top-level bind IS
  // genuinely read-only, but a real, separate mount point nested underneath
  // it is not — the exact gap --rbind + a single top-level remount,ro,bind
  // leaves open (see recursiveReadOnlyRemountCommand's doc comment).
  const roDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-ro-parent-"));
  const nestedSource = mkdtempSync(join(tmpdir(), "pdpp-isolation-nested-source-"));
  const nestedMountPoint = join(roDir, "nested");
  try {
    mkdirSync(nestedMountPoint, { recursive: true });
    const mountResult = spawnSync("mount", ["--bind", nestedSource, nestedMountPoint], { stdio: "inherit" });
    assert.equal(mountResult.status, 0, "sanity check: creating the real nested mount point must itself succeed");
    try {
      // The sandbox's OWN --ro-bind of roDir is genuinely read-only (bwrap's
      // own mechanism, proven elsewhere in this file to close this
      // specific case) — so this test targets the VERIFICATION FUNCTION's
      // own submount-probing logic directly, independent of which
      // mechanism's setup produced the nested mount.
      const setup = ["touch /pdpp-isolation-canary", "mkdir -p /oldroot"].join("; ");
      const script = `${setup}; ${postPivotVerificationStatements([{ path: "/ro-parent", mode: "ro" }]).join("; ")}; echo PDPP_VERIFY_PASSED`;
      const result = spawnSync(
        "bwrap",
        [
          "--unshare-net",
          "--tmpfs",
          "/",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--ro-bind",
          "/usr",
          "/usr",
          "--ro-bind",
          "/etc",
          "/etc",
          "--ro-bind",
          roDir,
          "/ro-parent",
          "--bind",
          nestedMountPoint,
          "/ro-parent/nested",
          "--symlink",
          "usr/bin",
          "/bin",
          "--symlink",
          "usr/sbin",
          "/sbin",
          "--symlink",
          "usr/lib",
          "/lib",
          "--symlink",
          "usr/lib64",
          "/lib64",
          "--",
          "sh",
          "-c",
          script,
        ],
        { encoding: "utf8" }
      );
      assert.equal(
        result.status,
        91,
        `expected POST_PIVOT_VERIFICATION_FAILURE_EXIT_CODE (91) when a nested submount under a ro bind is genuinely writable; stderr: ${result.stderr}`
      );
      assert.ok(
        /writable-ro-binds=\[[\s\S]*\/ro-parent\/nested[\s\S]*\]/.test(result.stderr),
        `expected the diagnostic to name the specific writable NESTED path; got ${JSON.stringify(result.stderr)}`
      );
    } finally {
      spawnSync("umount", ["-l", nestedMountPoint], { stdio: "ignore" });
    }
  } finally {
    rmSync(roDir, { recursive: true, force: true });
    rmSync(nestedSource, { recursive: true, force: true });
  }
});

// ─── Mountinfo parsing fix (P1-3, external review of ced8300be) ───────────
//
// /proc/self/mountinfo octal-escapes space/tab/newline/backslash bytes IN a
// mount point path (e.g. `\040` for a literal space). The prior submount
// walk compared awk's RAW (still-escaped) field-5 token directly against a
// PLAIN (unescaped) staged path — a raw `/tmp/x\040y` token never equals or
// prefix-matches the plain string `/tmp/x y`, so a real, space-containing
// submount was silently OMITTED from both the setup-time remount and this
// post-pivot verification. Separately, the old verification probed a
// submount by `touch <path>/.probe` — creating a file INSIDE it — which is
// meaningless for a FILE bind mount (no "inside" to touch); confirmed
// empirically this makes `touch` fail with ENOTDIR regardless of the file
// mount's actual read-only state, a false negative that reports a still-
// writable file submount as "confirmed read-only."

test("[bwrap sandbox] postPivotVerificationStatements FAILS when a nested submount at a SPACE-containing path is writable — the fixed mountinfo decode finds it", {
  skip: !(bwrapUsable && bindMountCapable),
}, () => {
  const roDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-ro-space-parent-"));
  const nestedSource = mkdtempSync(join(tmpdir(), "pdpp-isolation-nested-space-source-"));
  // The space in the mount point's basename is the load-bearing part of
  // this test — mountinfo encodes it as `\040` in the raw field the old
  // code compared unescaped, causing it to never match and silently skip
  // this submount entirely.
  const nestedMountPoint = join(roDir, "nested with space");
  try {
    mkdirSync(nestedMountPoint, { recursive: true });
    const mountResult = spawnSync("mount", ["--bind", nestedSource, nestedMountPoint], { stdio: "inherit" });
    assert.equal(mountResult.status, 0, "sanity check: creating the real nested mount point must itself succeed");
    try {
      const setup = ["touch /pdpp-isolation-canary", "mkdir -p /oldroot"].join("; ");
      const script = `${setup}; ${postPivotVerificationStatements([{ path: "/ro-parent", mode: "ro" }]).join("; ")}; echo PDPP_VERIFY_PASSED`;
      const result = spawnSync(
        "bwrap",
        [
          "--unshare-net",
          "--tmpfs",
          "/",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--ro-bind",
          "/usr",
          "/usr",
          "--ro-bind",
          "/etc",
          "/etc",
          "--ro-bind",
          roDir,
          "/ro-parent",
          "--bind",
          nestedMountPoint,
          "/ro-parent/nested with space",
          "--symlink",
          "usr/bin",
          "/bin",
          "--symlink",
          "usr/sbin",
          "/sbin",
          "--symlink",
          "usr/lib",
          "/lib",
          "--symlink",
          "usr/lib64",
          "/lib64",
          "--",
          "sh",
          "-c",
          script,
        ],
        { encoding: "utf8" }
      );
      assert.equal(
        result.status,
        91,
        `expected POST_PIVOT_VERIFICATION_FAILURE_EXIT_CODE (91) — the space-containing submount must be found and reported writable, not silently skipped; stderr: ${result.stderr}`
      );
      assert.ok(
        /writable-ro-binds=\[[\s\S]*\/ro-parent\/nested with space[\s\S]*\]/.test(result.stderr),
        `expected the diagnostic to name the specific writable space-containing path; got ${JSON.stringify(result.stderr)}`
      );
    } finally {
      spawnSync("umount", ["-l", nestedMountPoint], { stdio: "ignore" });
    }
  } finally {
    rmSync(roDir, { recursive: true, force: true });
    rmSync(nestedSource, { recursive: true, force: true });
  }
});

test("[bwrap sandbox] postPivotVerificationStatements detects a writable nested FILE submount without changing its host-backed bytes", {
  skip: !(bwrapUsable && bindMountCapable),
}, () => {
  const roDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-ro-file-parent-"));
  const nestedSourceDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-nested-file-source-"));
  const nestedSourceFile = join(nestedSourceDir, "source-file");
  // This is the real host file whose bind-mounted sandbox view `probe_ro`
  // opens. The regression oracle reads it after that probe: `>` used to
  // truncate it merely to establish writability.
  const originalContents = Buffer.from([0x00, 0x70, 0x64, 0x70, 0xff, 0x0a]);
  writeFileSync(nestedSourceFile, originalContents);
  const nestedMountPoint = join(roDir, "nested-file");
  writeFileSync(nestedMountPoint, "");
  try {
    const mountResult = spawnSync("mount", ["--bind", nestedSourceFile, nestedMountPoint], { stdio: "inherit" });
    assert.equal(mountResult.status, 0, "sanity check: creating the real nested FILE mount point must itself succeed");
    try {
      // Deliberately left WITHOUT a read-only remount — this file submount
      // stays genuinely writable, the false-negative case the old
      // touch-inside probe could never detect.
      const setup = ["touch /pdpp-isolation-canary", "mkdir -p /oldroot"].join("; ");
      const script = `${setup}; ${postPivotVerificationStatements([{ path: "/ro-parent", mode: "ro" }]).join("; ")}; echo PDPP_VERIFY_PASSED`;
      const result = spawnSync(
        "bwrap",
        [
          "--unshare-net",
          "--tmpfs",
          "/",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--ro-bind",
          "/usr",
          "/usr",
          "--ro-bind",
          "/etc",
          "/etc",
          "--ro-bind",
          roDir,
          "/ro-parent",
          "--bind",
          nestedMountPoint,
          "/ro-parent/nested-file",
          "--symlink",
          "usr/bin",
          "/bin",
          "--symlink",
          "usr/sbin",
          "/sbin",
          "--symlink",
          "usr/lib",
          "/lib",
          "--symlink",
          "usr/lib64",
          "/lib64",
          "--",
          "sh",
          "-c",
          script,
        ],
        { encoding: "utf8" }
      );
      assert.equal(
        result.status,
        91,
        `expected POST_PIVOT_VERIFICATION_FAILURE_EXIT_CODE (91) — a genuinely writable FILE submount must be detected via a non-truncating append-mode open, not silently reported clean via a meaningless touch-inside-a-file attempt; stderr: ${result.stderr}`
      );
      assert.deepEqual(
        readFileSync(nestedSourceFile),
        originalContents,
        "probing a writable file submount must not change any bytes in its host-backed source file"
      );
      assert.ok(
        /writable-ro-binds=\[[\s\S]*\/ro-parent\/nested-file[\s\S]*\]/.test(result.stderr),
        `expected the diagnostic to name the specific writable file submount path; got ${JSON.stringify(result.stderr)}`
      );
    } finally {
      spawnSync("umount", ["-l", nestedMountPoint], { stdio: "ignore" });
    }
  } finally {
    rmSync(roDir, { recursive: true, force: true });
    rmSync(nestedSourceDir, { recursive: true, force: true });
  }
});

test("[bwrap sandbox] postPivotVerificationStatements PASSES a genuinely read-only FILE submount (negative control — the append-mode probe isn't vacuously always failing)", {
  skip: !(bwrapUsable && bindMountCapable),
}, () => {
  const roDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-ro-file-clean-parent-"));
  const nestedSourceDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-nested-file-clean-source-"));
  const nestedSourceFile = join(nestedSourceDir, "source-file");
  writeFileSync(nestedSourceFile, "original content");
  const nestedMountPoint = join(roDir, "nested-file");
  writeFileSync(nestedMountPoint, "");
  try {
    const mountResult = spawnSync("mount", ["--bind", nestedSourceFile, nestedMountPoint], { stdio: "inherit" });
    assert.equal(mountResult.status, 0, "sanity check: creating the real nested FILE mount point must itself succeed");
    const remountResult = spawnSync("mount", ["-o", "remount,ro,bind", nestedMountPoint], { stdio: "inherit" });
    assert.equal(remountResult.status, 0, "sanity check: remounting the file submount read-only must itself succeed");
    try {
      const setup = ["touch /pdpp-isolation-canary", "mkdir -p /oldroot"].join("; ");
      const script = `${setup}; ${postPivotVerificationStatements([{ path: "/ro-parent", mode: "ro" }]).join("; ")}; echo PDPP_VERIFY_PASSED`;
      const result = spawnSync(
        "bwrap",
        [
          "--unshare-net",
          "--tmpfs",
          "/",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--ro-bind",
          "/usr",
          "/usr",
          "--ro-bind",
          "/etc",
          "/etc",
          "--ro-bind",
          roDir,
          "/ro-parent",
          "--ro-bind",
          nestedMountPoint,
          "/ro-parent/nested-file",
          "--symlink",
          "usr/bin",
          "/bin",
          "--symlink",
          "usr/sbin",
          "/sbin",
          "--symlink",
          "usr/lib",
          "/lib",
          "--symlink",
          "usr/lib64",
          "/lib64",
          "--",
          "sh",
          "-c",
          script,
        ],
        { encoding: "utf8" }
      );
      assert.equal(
        result.stdout.trim(),
        "PDPP_VERIFY_PASSED",
        `expected verification to PASS for a genuinely read-only file submount; stderr: ${result.stderr}`
      );
      assert.equal(result.status, 0, `expected exit 0; stderr: ${result.stderr}`);
    } finally {
      spawnSync("umount", ["-l", nestedMountPoint], { stdio: "ignore" });
    }
  } finally {
    rmSync(roDir, { recursive: true, force: true });
    rmSync(nestedSourceDir, { recursive: true, force: true });
  }
});

test("[unshare] a genuinely successful filesystem closure passes post-pivot verification and the target command DOES run", {
  skip: !unshareUsable,
}, async () => {
  // Unlike the forced-failure tests above, this positive control needs the
  // marker write to actually succeed inside the isolated child — so the
  // marker must live under a `filesystemBindPath`, the one path the
  // default-deny root re-exposes as writable (see `spawnAndCheckMarkerWritten`'s
  // doc comment: a plain `os.tmpdir()` path is NOT reachable inside the
  // isolated child at all, and using one here would make this test fail for
  // the wrong reason — proving the closure works, not that it's broken).
  const workspaceDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-happy-workspace-"));
  const markerPath = join(workspaceDir, "marker");
  try {
    const { exitCode, markerWritten } = await spawnAndCheckMarkerWritten(markerPath, workspaceDir);
    assert.equal(exitCode, 0, "an un-shimmed, genuine filesystem closure must let the target command run and exit 0");
    assert.equal(markerWritten, true, "the target command must actually have run and written its marker");
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ─── Double-probe / non-atomic mechanism selection regression ─────────────
//
// A caller that already ran `isNamespaceIsolationAvailable()` once and
// passes `opts.isolate` as a bare `true` (a boolean) instead of the
// resolved `capability.mechanism` makes `spawnWithNetworkIsolation` call
// `detectMechanism()`, which re-runs the ENTIRE probe (spawning `unshare`,
// and — if that's denied — `bwrap`) from scratch on every single spawn,
// contradicting the "probe once, reuse everywhere" contract callers rely
// on. This test proves that contract mechanically: with logging shims
// covering both trusted-path binaries, passing the already-known mechanism
// directly must invoke the probe binaries ZERO times, while passing a bare
// `true` must invoke them (the regression this test exists to catch if a
// caller — or this function itself — regresses back to re-probing).
//
// INJECTION MECHANISM (P1, external review of ab415be6c — trusted launcher
// resolution): these two tests used to PATH-prepend fake `unshare`/`bwrap`
// binaries. Now that both the probe and the real execution resolve the
// launcher through `resolveTrustedLauncherPath` (never the caller's `$PATH`),
// that no longer reaches anything — both binaries are shimmed via
// bind-mount-over-the-real-trusted-path binary instead
// (`withShimmedTrustedBinary`, nested so both are covered at once).

/** Shim body that appends its full argv (one line, space-joined) to
 *  `logPath` and exits 0 WITHOUT delegating to the real binary — unlike
 *  the setup-command shims elsewhere in this file, these two tests need to
 *  observe exactly which binary/argv shape `spawnWithNetworkIsolation`
 *  invokes, not exercise a real isolated spawn. */
function loggingShim(name: string, logPath: string): (realBinaryPath: string) => string {
  return (_realBinaryPath: string) => `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(logPath)}\nexit 0\n`;
}

function withBothLaunchersLoggingShimmed<T>(logPath: string, fn: () => Promise<T>): Promise<T> {
  return withShimmedTrustedBinary("unshare", loggingShim("unshare", logPath), () =>
    withShimmedTrustedBinary("bwrap", loggingShim("bwrap", logPath), fn)
  );
}

test("spawnWithNetworkIsolation given an already-resolved mechanism does NOT re-probe (no unshare/bwrap probe invocation)", {
  skip: !bindMountCapable,
}, async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-probe-log-"));
  const logPath = join(logDir, "invocations.log");
  writeFileSync(logPath, "");

  try {
    await withBothLaunchersLoggingShimmed(logPath, async () => {
      const exitCode = await new Promise<number | null>((resolveExit) => {
        const child = spawnWithNetworkIsolation("node", ["-e", "process.exit(0)"], {
          isolate: "bwrap",
          stdio: "ignore",
        });
        child.on("close", resolveExit);
      });
      assert.equal(exitCode, 0);

      const invocations = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      // Exactly one bwrap call: the ACTUAL wrapped spawn (`bwrap --unshare-net
      // ... -- <trusted-absolute-sh> -c ...`), never a probe call (`bwrap
      // --unshare-net --dev-bind / / true`, no trailing `-- <sh> -c`) and
      // never an `unshare` call at all — proving detectMechanism()'s
      // `isNamespaceIsolationAvailable()` re-probe path was never taken when
      // the mechanism was already known. The inner shell is asserted by
      // PATTERN (`-- /<trusted-dir>/<shell-basename> -c`), not the literal
      // string `"-- sh -c"` — P1-1 (external review of ced8300be) resolves
      // that shell through `resolveTrustedLauncherPath("sh")`'s absolute,
      // symlink-followed path (e.g. `/usr/bin/dash` on a merged-usr host
      // where `/bin/sh` -> `dash`), never the bare name `"sh"`.
      assert.equal(
        invocations.length,
        1,
        `expected exactly one fake-binary invocation (the real spawn, no probe); got ${JSON.stringify(invocations)}`
      );
      assert.ok(
        invocations[0]?.startsWith("bwrap "),
        `expected the one invocation to be bwrap; got ${JSON.stringify(invocations)}`
      );
      assert.ok(
        /-- \/\S+ -c/.test(invocations[0] ?? ""),
        `expected the real wrapped-spawn argv shape (an absolute-path shell after "--"), not a probe; got ${JSON.stringify(invocations)}`
      );
      assert.ok(
        !invocations[0]?.includes("-- sh -c"),
        `the inner shell must be an absolute trusted path, never the bare string "sh" (P1-1, external review of ced8300be); got ${JSON.stringify(invocations)}`
      );
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("spawnWithNetworkIsolation given a bare `true` DOES re-probe (documents the boolean fallback path's cost, for contrast)", {
  skip: !bindMountCapable,
}, async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-probe-log-"));
  const logPath = join(logDir, "invocations.log");
  writeFileSync(logPath, "");

  try {
    await withBothLaunchersLoggingShimmed(logPath, async () => {
      const exitCode = await new Promise<number | null>((resolveExit) => {
        const child = spawnWithNetworkIsolation("node", ["-e", "process.exit(0)"], {
          isolate: true,
          stdio: "ignore",
        });
        child.on("close", resolveExit);
      });
      assert.equal(exitCode, 0);

      const invocations = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      // A bare `true` forces detectMechanism() to call isNamespaceIsolationAvailable(),
      // which probes `unshare` first (the fake shim reports success, so the
      // probe reports mechanism "unshare" without ever trying bwrap — but the
      // point is a probe call happens AT ALL, unlike the resolved-mechanism
      // case above) before the real wrapped spawn.
      assert.ok(
        invocations.length >= 2,
        `expected at least a probe call plus the real spawn call; got ${JSON.stringify(invocations)}`
      );
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

// ─── PID namespace — full host process-list + argv disclosure ─────────────
//
// An independent review found that bwrap's isolated child was NEVER given
// its own PID namespace: only `--unshare-net` was passed, so `--proc /proc`
// mounted a fresh procfs INSTANCE that still reflected the HOST's PID
// namespace (procfs is a view keyed by the mounting process's PID namespace
// membership, independent of the mount being freshly created). Reproduced:
// an isolated child's `ls /proc | grep -cE '^[0-9]+$'` showed 1683 of 1681
// host processes — essentially the entire host process table — and could
// read `/proc/<pid>/cmdline` (full argv, which routinely carries secrets:
// `--token=...`, connection strings) for an arbitrary unrelated live host
// process, including PID 1. `unshare --pid --fork` already avoided this
// (same probe: 7, only the child's own tiny subtree).
//
// This section proves the fix (`--unshare-pid` added to the bwrap argv,
// composing with the pre-existing `--unshare-net`) with the SAME two-part
// signature the reviewer's repro used: a small process-count bound AND a
// failed foreign-cmdline read — either alone is weaker evidence (a low count
// with a readable foreign cmdline would mean the count is deceptive; a
// failed single read with no count check wouldn't prove the isolated child
// can't see anything ELSE on the host).

/** Runs `code` (a JS expression string) inside a `spawnWithNetworkIsolation`-
 *  wrapped child under `mechanism` and returns its stdout, trimmed. Uses
 *  `console.log` inside the child so the value crosses the process boundary
 *  as plain stdout text, not an exit code (which can't carry a count). */
function runIsolatedProbe(
  mechanism: "bwrap" | "unshare",
  code: string
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawnWithNetworkIsolation(process.execPath, ["-e", code], {
      isolate: mechanism,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", (exitCode) => resolve({ stdout: stdout.trim(), exitCode }));
  });
}

for (const mechanism of ["bwrap", "unshare"] as const) {
  const usable = mechanism === "bwrap" ? bwrapUsable : unshareUsable;

  test(`[${mechanism}] an isolated child sees only its own tiny PID-namespace subtree, not the host's full process list`, {
    skip: !usable,
  }, async () => {
    const hostProcessCount = readFileSync("/proc/stat", "utf8"); // sanity: /proc is readable from here at all
    assert.ok(hostProcessCount.length > 0);

    const { stdout, exitCode } = await runIsolatedProbe(
      mechanism,
      'const fs=require("fs");const n=fs.readdirSync("/proc").filter(e=>/^[0-9]+$/.test(e)).length;console.log(n);'
    );
    assert.equal(exitCode, 0, `probe child must exit cleanly; stdout was ${JSON.stringify(stdout)}`);
    // A non-empty /proc listing at all is the load-bearing sanity check this
    // test's count-bound implicitly depends on: readdirSync("/proc") throwing
    // ENOENT (a bug that once existed under the `unshare` mechanism — see
    // isolation.ts's filesystemClosureShellPrelude doc comment) would make
    // the probe child exit non-zero, which the assertion above already
    // catches — but a REAL, mounted-but-somehow-empty /proc is a distinct
    // failure this test must also reject rather than silently accept as "0
    // processes, must be isolated."
    const isolatedCount = Number(stdout);
    assert.ok(Number.isFinite(isolatedCount), `expected a numeric PID count on stdout, got ${JSON.stringify(stdout)}`);
    assert.ok(
      isolatedCount > 0,
      `isolated child under ${mechanism} reported ${isolatedCount} processes under /proc — a real procfs must show at least the probe's own process; zero means /proc is not a genuine mounted proc filesystem`
    );
    // Single digits: the isolated child, the node process itself, and at
    // most a couple of short-lived helpers (sh, fork scaffolding) — NOT
    // anywhere near the host's real process count (this host: 1000+).
    // Matches the independent review's own bound ("7" under unshare).
    assert.ok(
      isolatedCount < 10,
      `isolated child under ${mechanism} sees ${isolatedCount} processes under /proc — expected single digits (own PID-namespace subtree only); a high count means the host's PID namespace leaked in`
    );
  });

  test(`[${mechanism}] an isolated child cannot read a foreign host PID's /proc/<pid>/cmdline`, {
    skip: !usable,
  }, async () => {
    // The foreign target must be a REAL, live host process OUTSIDE the
    // isolated child's own PID namespace. PID 1 does not work for this: with
    // `--unshare-pid`, the isolated child's OWN init process becomes PID 1
    // INSIDE the new namespace, so `/proc/1/cmdline` reads the isolated
    // child's own cmdline, not a foreign one — confirmed empirically. This
    // test process's own `process.pid` is a real, live, host-namespace PID
    // that is unambiguously foreign to whatever fresh PID namespace the
    // isolated child gets, and stays alive for the whole test (it's what's
    // running this assertion).
    //
    // FAILURE-MODE DISTINCTION (the point of this hardening): a foreign
    // cmdline read can fail two ways that look identical if you only check
    // "did it fail" — a genuine PID-namespace block (the foreign PID simply
    // doesn't resolve to anything inside the child's own namespace: ESRCH/
    // ENOENT against a /proc/<pid> directory that itself does not exist
    // because there is no such PID in THIS namespace) versus /proc being
    // completely absent as a filesystem (ENOENT because /proc itself was
    // never mounted — the pre-existing bug isolation.ts's
    // filesystemClosureShellPrelude doc comment describes, where the `unshare`
    // mechanism's post-pivot `mount -t proc proc /proc` silently no-op'd
    // because the mountpoint was never created). Both produced the exact
    // same "BLOCKED:ENOENT" string, which is why the review that found this
    // called it a test passing for the wrong reason: it would keep passing
    // even if isolation were completely broken, as long as /proc also
    // happened to be absent. The probe below reads its OWN /proc/self/cmdline
    // FIRST — that must succeed (proving /proc exists, is a real procfs, and
    // is mounted and readable in general) before the foreign-PID read is even
    // attempted; if the foreign-PID read then also fails with ENOENT, that
    // ENOENT is now known to mean "this specific PID doesn't exist in my
    // namespace," not "there is no /proc at all."
    const foreignPid = process.pid;
    const { stdout, exitCode } = await runIsolatedProbe(
      mechanism,
      `const fs=require("fs");` +
        `let ownCmdline;try{ownCmdline=fs.readFileSync("/proc/self/cmdline","utf8");}catch(e){console.log("PROC_ABSENT:"+e.code);process.exit(0);}` +
        `if(!ownCmdline||ownCmdline.length===0){console.log("PROC_EMPTY");process.exit(0);}` +
        `try{const out=fs.readFileSync("/proc/${String(foreignPid)}/cmdline","utf8");console.log("LEAKED:"+JSON.stringify(out));}catch(e){console.log("BLOCKED:"+e.code);}`
    );
    assert.equal(exitCode, 0, `probe child must exit cleanly; stdout was ${JSON.stringify(stdout)}`);
    assert.notEqual(
      stdout.startsWith("PROC_ABSENT:") || stdout === "PROC_EMPTY",
      true,
      `/proc is not a genuine, readable procfs under ${mechanism} (own /proc/self/cmdline was unreadable) — a foreign-cmdline "BLOCKED" result under this condition would not be evidence of PID-namespace isolation; got ${JSON.stringify(stdout)}`
    );
    assert.ok(
      stdout.startsWith("BLOCKED:"),
      `isolated child under ${mechanism} read a foreign host PID's cmdline — PID-namespace isolation is not real; got ${JSON.stringify(stdout)}`
    );
    // The BLOCKED error code itself must name a real access-denial reason
    // (the foreign PID's /proc/<pid> subtree not existing/not being visible
    // in this namespace — ENOENT here is now known-good because own-cmdline
    // already proved /proc is real), not merely "some error happened."
    // Explicitly reject codes that would indicate /proc itself is broken.
    const blockedCode = stdout.slice("BLOCKED:".length);
    assert.ok(
      ["ENOENT", "EACCES", "EPERM", "ESRCH"].includes(blockedCode),
      `expected a genuine permission/nonexistence error blocking the foreign PID read under ${mechanism}, got code ${JSON.stringify(blockedCode)}`
    );
  });
}

// ─── SysV IPC namespace — shared memory/semaphore/message-queue isolation ─
//
// Symmetric gap to the PID-namespace finding above, found by the same
// independent review while sweeping for new escapes the PID-namespace change
// might introduce: neither mechanism unshared the SysV IPC namespace, so
// `/proc/sysvipc/shm` (and the semaphore/message-queue equivalents) enumerate
// every live host IPC object's key/owner/perms from inside an isolated
// child — the same reconnaissance shape `/proc/<pid>/cmdline` had before
// `--unshare-pid`. Reproduced by the review on this class of host: real,
// live SysV shared-memory segments exist, including one with `606`
// (world-readable/writable) permissions, and `/proc/self/ns/ipc` reported
// the IDENTICAL namespace inode inside and outside an isolated child before
// the fix.
//
// This proves the fix the same way: the isolated child's IPC namespace
// inode (from its own `/proc/self/ns/ipc`) must differ from this test
// process's — a real host process live for the whole test, exactly the
// same "must be a real, live, external identity" shape the PID-namespace
// foreign-cmdline test above uses.
for (const mechanism of ["bwrap", "unshare"] as const) {
  const usable = mechanism === "bwrap" ? bwrapUsable : unshareUsable;

  test(`[${mechanism}] an isolated child gets its own SysV IPC namespace, not the host's`, {
    skip: !usable,
  }, async () => {
    const { stdout, exitCode } = await runIsolatedProbe(
      mechanism,
      'const fs=require("fs");console.log(fs.readlinkSync("/proc/self/ns/ipc"));'
    );
    assert.equal(exitCode, 0, `probe child must exit cleanly; stdout was ${JSON.stringify(stdout)}`);
    const isolatedIpcNs = stdout;
    const parentIpcNs = readlinkSync("/proc/self/ns/ipc");
    assert.notEqual(
      isolatedIpcNs,
      parentIpcNs,
      `isolated child under ${mechanism} reports the SAME IPC namespace as the parent (${parentIpcNs}) — SysV IPC objects (shared memory, semaphores, message queues) are not isolated; a compromised connector could enumerate every live host IPC object via /proc/sysvipc/shm`
    );
    assert.ok(
      /^ipc:\[\d+\]$/.test(isolatedIpcNs),
      `expected a real ipc:[<inode>] namespace identifier, got ${JSON.stringify(isolatedIpcNs)}`
    );
  });
}

// ─── UTS namespace — hostname/domainname isolation ─────────────────────────
//
// Same test-parity gap the IPC section above closed for SysV IPC: the R5
// commit unshared `--unshare-uts`/`--uts` on both mechanisms but added no
// dedicated regression test for it, unlike PID and IPC, which both got a
// `/proc/self/ns/<x>` inode-comparison test in that same commit. A future
// regression that dropped the UTS flag would pass the entire suite silently.
// Hostname disclosure isn't treated as sensitive by this module's threat
// model (see the doc comment at the top of isolation.ts), so this is Low
// severity — but the asymmetry with PID/IPC is cheap to close and this test
// directly mirrors the IPC test's shape, swapping `ns/ipc` for `ns/uts`.
for (const mechanism of ["bwrap", "unshare"] as const) {
  const usable = mechanism === "bwrap" ? bwrapUsable : unshareUsable;

  test(`[${mechanism}] an isolated child gets its own UTS namespace, not the host's`, {
    skip: !usable,
  }, async () => {
    const { stdout, exitCode } = await runIsolatedProbe(
      mechanism,
      'const fs=require("fs");console.log(fs.readlinkSync("/proc/self/ns/uts"));'
    );
    assert.equal(exitCode, 0, `probe child must exit cleanly; stdout was ${JSON.stringify(stdout)}`);
    const isolatedUtsNs = stdout;
    const parentUtsNs = readlinkSync("/proc/self/ns/uts");
    assert.notEqual(
      isolatedUtsNs,
      parentUtsNs,
      `isolated child under ${mechanism} reports the SAME UTS namespace as the parent (${parentUtsNs}) — hostname/domainname are not isolated; a future regression dropping --unshare-uts/--uts would pass the rest of this suite silently`
    );
    assert.ok(
      /^uts:\[\d+\]$/.test(isolatedUtsNs),
      `expected a real uts:[<inode>] namespace identifier, got ${JSON.stringify(isolatedUtsNs)}`
    );
  });
}

// ─── Pathname-UDS filesystem escape — default-deny negative controls ──────
//
// Two independent review passes on the earlier mask-list repair:
//
// Pass 1 (external review): `--net`/`--unshare-net` only constrains the
// NETWORK namespace. A native descendant the isolated child spawns — `curl
// --unix-socket <path>`, never routed through this package's JS-layer
// fetch/http/net patching at all — could dial ANY pathname UDS reachable on
// the shared filesystem, because the isolated child's filesystem view was
// left completely unrestricted. Reported repro: `unshare -r -n -- curl
// --unix-socket /tmp/foreign.sock http://localhost/probe`.
//
// Pass 2 (independent second review, against the mask-list repair for pass
// 1): proved mask-listing cannot terminate. With `--dev-bind / /` still in
// place, the reachable set was always "every path not yet added to the
// list" — the reviewer reached a real ssh-agent socket under
// `$HOME/.ssh/agent/`, a real `/run/user/<uid>` socket, and an arbitrary
// `$HOME`-rooted path, none of them ever addressable by growing a mask
// list. The reviewer ALSO proved the negative controls that existed at the
// time were a false-pass mechanism: `startForeignUdsServer` called
// `server.listen()` without awaiting the `'listening'` event, so on a
// slower filesystem/loaded CI runner the isolated child's curl could lose
// the race against the socket actually being bound — and an UNBOUND socket
// produces curl_exit=7 (connection refused, "no such file") + hits()==0,
// EXACTLY the signature the assertions accept as "escape closed." Green in
// that world proved nothing.
//
// This section fixes both: `startForeignUdsServer` now resolves only after
// `'listening'` fires (and rejects on `'error'`), so every test below
// awaits a REAL bound socket before the isolated child ever attempts to
// connect — no race window to lose. And the isolation under test is now
// `isolation.ts`'s default-deny root (see that module's doc comment),
// tested against the exact three real-world locations the reviewer
// reproduced: an arbitrary `$HOME`-rooted path (P1.1), an ssh-agent-shaped
// path under `$HOME/.ssh/agent/` (P1.2 — the socket that actually matters,
// since the earlier `/run/user/<uid>` fix closed a DIFFERENT, unused
// agent socket), and `/run/user/<uid>` itself (regression coverage for the
// fix that preceded this one). A POSITIVE control (below) proves a
// non-isolated child CAN reach each of these sockets, so a passing negative
// control is meaningful rather than vacuous (e.g. curl not being on PATH).
//
// Passing (closing the escape) requires BOTH: the curl connect attempt
// fails, AND the foreign server's own hit counter — the authoritative
// signal, since a compromised/malicious child could lie about its own exit
// code — stays at zero.

/** Starts a plain (non-preloaded, not this module's code) HTTP server on a
 *  pathname UDS and resolves ONLY after the `'listening'` event fires (or
 *  rejects on `'error'`) — never synchronously. This is the race fix:
 *  the prior version returned immediately after calling `server.listen()`,
 *  which is asynchronous, so a caller could launch a client against the
 *  socket path before the OS had actually bound it. An unbound socket path
 *  produces the SAME success signature (`curl` fails to connect, hit count
 *  stays 0) that a genuinely-isolated child produces, so an unawaited
 *  `listen()` makes every negative control below able to pass for the
 *  wrong reason. Deliberately NOT `startFetchBridgeServer` from
 *  subprocess-fetch-preloads.ts, so these tests prove the OS-layer
 *  closure, not anything about the bridge being well-behaved. */
function startForeignUdsServer(socketPath: string): Promise<{ close: () => Promise<void>; hits: () => number }> {
  let hitCount = 0;
  const server = createServer((_req, res) => {
    hitCount += 1;
    res.writeHead(200);
    res.end("should never be reached by an isolated child");
  });
  rmSync(socketPath, { force: true });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve({
        hits: () => hitCount,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => {
              rmSync(socketPath, { force: true });
              resolveClose();
            });
          }),
      });
    });
  });
}

/** Runs `curl --unix-socket <foreignSocketPath> http://localhost/probe`
 *  inside a `spawnWithNetworkIsolation`-wrapped child, with `workspaceDir`
 *  (a directory that does NOT contain `foreignSocketPath`) passed as
 *  `filesystemBindPath` — the exact shape a real scenario-verify.ts run
 *  uses (its own evidence workspace re-exposed, everything else absent).
 *  Resolves curl's exit code (0 only on a successful connect+response). */
function runIsolatedCurlAgainstForeignSocket(
  mechanism: "bwrap" | "unshare",
  foreignSocketPath: string,
  workspaceDir: string
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawnWithNetworkIsolation(
      "curl",
      ["-s", "-o", "/dev/null", "--max-time", "3", "--unix-socket", foreignSocketPath, "http://localhost/probe"],
      { isolate: mechanism, filesystemBindPath: workspaceDir, stdio: "ignore" }
    );
    child.on("close", resolve);
    child.on("error", () => resolve(-1));
  });
}

/** Runs the SAME curl probe with NO isolation at all — a plain
 *  `child_process.spawn`. This is the positive control: it must succeed
 *  (exit 0, hits()===1) against every socket location the negative
 *  controls below claim is unreachable FROM AN ISOLATED CHILD, proving the
 *  foreign server is real and dialable in principle — so a negative
 *  control's "curl failed" is evidence of isolation, not evidence the
 *  socket was never listening or curl was never on PATH. */
function runUnisolatedCurlAgainstForeignSocket(foreignSocketPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "curl",
      ["-s", "-o", "/dev/null", "--max-time", "3", "--unix-socket", foreignSocketPath, "http://localhost/probe"],
      { stdio: "ignore" }
    );
    child.on("close", resolve);
    child.on("error", () => resolve(-1));
  });
}

for (const mechanism of ["bwrap", "unshare"] as const) {
  const usable = mechanism === "bwrap" ? bwrapUsable : unshareUsable;
  test(`[${mechanism}] a native descendant (curl --unix-socket) cannot dial a foreign pathname UDS outside filesystemBindPath`, {
    skip: !usable,
  }, async () => {
    const foreignDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-foreign-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-workspace-"));
    const foreignSocketPath = join(foreignDir, "foreign.sock");
    const foreign = await startForeignUdsServer(foreignSocketPath);
    try {
      const exitCode = await runIsolatedCurlAgainstForeignSocket(mechanism, foreignSocketPath, workspaceDir);
      assert.notEqual(
        exitCode,
        0,
        `curl must NOT succeed dialing a foreign UDS from inside ${mechanism} isolation — exit 0 means the escape is still open`
      );
      assert.equal(
        foreign.hits(),
        0,
        `the foreign server's own hit counter is authoritative — any nonzero count means the isolated child reached it, regardless of curl's reported exit code`
      );
    } finally {
      await foreign.close();
      rmSync(foreignDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test(`[${mechanism}] the isolated child's OWN bridge socket, inside filesystemBindPath, stays reachable`, {
    skip: !usable,
  }, async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-workspace-"));
    const bridgeSocketPath = join(workspaceDir, "bridge.sock");
    const bridge = await startForeignUdsServer(bridgeSocketPath);
    try {
      const exitCode = await runIsolatedCurlAgainstForeignSocket(mechanism, bridgeSocketPath, workspaceDir);
      assert.equal(
        exitCode,
        0,
        `curl must succeed dialing the bridge's own socket inside filesystemBindPath under ${mechanism} isolation — the default-deny closure must not break the legitimate bridge path`
      );
      assert.equal(bridge.hits(), 1, "the bridge server must have received exactly the one legitimate request");
    } finally {
      await bridge.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
}

// ─── Real-socket-location negative controls (independent review, R2/R3) ───
//
// The generic-tmpdir controls above prove the escape is closed for a socket
// under `os.tmpdir()`. The independent reviewer's exact repro targeted
// three specific real-world locations on a real host, in order of
// escalating severity:
//
//   P1.1 — an arbitrary `$HOME`-rooted path (the general case: literally
//          anywhere outside the derived allowlist)
//   P1.2 — an ssh-agent-SHAPED path under `$HOME/.ssh/agent/` (the sharpest
//          finding: the earlier `/run`-masking fix closed a real but UNUSED
//          `/run/user/<uid>` agent socket while the actual in-use agent,
//          `$SSH_AUTH_SOCK -> $HOME/.ssh/agent/s.*`, stayed open — an agent
//          socket is a signing oracle, letting a compromised connector
//          authenticate as the owner without ever reading a key file)
//   /run/user/<uid> — regression coverage: the fix that preceded this one
//          closed this specific directory via a mask-list entry; the
//          default-deny rewrite must not reopen it as a side effect of
//          restructuring the mechanism.
//
// Each location gets: a POSITIVE control (non-isolated child reaches it,
// proving the socket is real and the probe methodology is sound) and a
// NEGATIVE control per mechanism (isolated child must not).

const homeDir = homedir();
const runtimeDir = process.getuid ? `/run/user/${String(process.getuid())}` : undefined;

function writableProbe(dir: string): boolean {
  try {
    const probePath = join(dir, `pdpp-isolation-writable-probe-${String(process.pid)}`);
    writeFileSync(probePath, "");
    rmSync(probePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

const REAL_SOCKET_LOCATIONS: Array<{ name: string; dir: string; usable: boolean }> = [
  {
    name: "an arbitrary $HOME-rooted path",
    dir: homeDir,
    usable: writableProbe(homeDir),
  },
  {
    name: "an ssh-agent-shaped path under $HOME/.ssh/agent",
    dir: join(homeDir, ".ssh", "agent"),
    usable: (() => {
      const dir = join(homeDir, ".ssh", "agent");
      try {
        return writableProbe(dir);
      } catch {
        return false;
      }
    })(),
  },
  ...(runtimeDir === undefined
    ? []
    : [{ name: "/run/user/<uid>", dir: runtimeDir, usable: writableProbe(runtimeDir) }]),
];

for (const location of REAL_SOCKET_LOCATIONS) {
  test(`[positive control] a non-isolated child CAN dial a foreign pathname UDS under ${location.name}`, {
    skip: !location.usable,
  }, async () => {
    const foreignSocketPath = join(location.dir, `pdpp-isolation-realloc-positive-${String(process.pid)}.sock`);
    const foreign = await startForeignUdsServer(foreignSocketPath);
    try {
      const exitCode = await runUnisolatedCurlAgainstForeignSocket(foreignSocketPath);
      assert.equal(
        exitCode,
        0,
        `sanity check: an UN-isolated child must reach a real socket under ${location.name} — if this fails, the probe methodology itself is broken, independent of isolation`
      );
      assert.equal(foreign.hits(), 1, "the foreign server must have received exactly the one un-isolated request");
    } finally {
      await foreign.close();
    }
  });

  for (const mechanism of ["bwrap", "unshare"] as const) {
    const usable = (mechanism === "bwrap" ? bwrapUsable : unshareUsable) && location.usable;
    test(`[${mechanism}] a native descendant (curl --unix-socket) cannot dial a foreign pathname UDS under ${location.name}`, {
      skip: !usable,
    }, async () => {
      const workspaceDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-workspace-"));
      const foreignSocketPath = join(location.dir, `pdpp-isolation-realloc-${String(process.pid)}.sock`);
      const foreign = await startForeignUdsServer(foreignSocketPath);
      try {
        const exitCode = await runIsolatedCurlAgainstForeignSocket(mechanism, foreignSocketPath, workspaceDir);
        assert.notEqual(
          exitCode,
          0,
          `curl must NOT succeed dialing a foreign UDS under ${location.name} from inside ${mechanism} isolation — exit 0 means the escape is still open`
        );
        assert.equal(
          foreign.hits(),
          0,
          `the foreign server's own hit counter is authoritative — any nonzero count means the isolated child reached a live socket under ${location.name}`
        );
      } finally {
        await foreign.close();
        rmSync(workspaceDir, { recursive: true, force: true });
      }
    });

    test(`[${mechanism}] a foreign pathname UDS under ${location.name} is masked even when filesystemBindPath is NOT passed at all`, {
      skip: !usable,
    }, async () => {
      const foreignSocketPath = join(location.dir, `pdpp-isolation-realloc-nobindpath-${String(process.pid)}.sock`);
      const foreign = await startForeignUdsServer(foreignSocketPath);
      try {
        const exitCode = await new Promise<number | null>((resolveExit) => {
          const child = spawnWithNetworkIsolation(
            "curl",
            ["-s", "-o", "/dev/null", "--max-time", "3", "--unix-socket", foreignSocketPath, "http://localhost/probe"],
            { isolate: mechanism, stdio: "ignore" }
          );
          child.on("close", resolveExit);
          child.on("error", () => resolveExit(-1));
        });
        assert.notEqual(
          exitCode,
          0,
          `curl must NOT succeed dialing a UDS under ${location.name} under ${mechanism} isolation even with no filesystemBindPath passed`
        );
        assert.equal(
          foreign.hits(),
          0,
          `the foreign server's hit counter must stay 0 — closure under ${location.name} must not depend on filesystemBindPath being set`
        );
      } finally {
        await foreign.close();
      }
    });
  }
}

// ─── Guard: no future edit may reintroduce --dev-bind / / ─────────────────
//
// The whole point of the default-deny rewrite is that the bwrap argv never
// contains a bind of the real host root, and never binds anything outside
// `requiredFilesystemBinds()` plus the one caller-supplied
// `filesystemBindPath`. This test asserts that MECHANICALLY, independent of
// whether any specific foreign-socket probe above happens to catch a
// regression — so a future edit that widens the bind set (e.g. reverting to
// `--dev-bind / /`, or adding a new bind without updating this test) fails
// here even if no test author remembers to add a new location above.
//
// An independent review of an earlier version of this guard found it too
// narrow: it asserted every --bind/--ro-bind SOURCE it found was a member of
// the allowlist, but never checked the argv's bind set was EXACTLY the
// allowlist — so an extra, undeclared bind whose source happened to collide
// with an allowlisted path (or a widened MODE on an allowlisted path, e.g.
// flipping a `--ro-bind` to `--bind`) could slip through uncaught. This
// version instead extracts every (flag, source, dest) bind triple from the
// argv and asserts that SET, as a whole, equals the derived allowlist plus
// filesystemBindPath — nothing missing, nothing extra, no flag substituted —
// via a symmetric-difference check rather than a one-directional `.every()`.
function extractBwrapBinds(argv: readonly string[]): Array<{ flag: string; source: string; dest: string }> {
  const binds: Array<{ flag: string; source: string; dest: string }> = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== "--bind" && flag !== "--ro-bind" && flag !== "--dev-bind") {
      continue;
    }
    binds.push({ flag, source: argv[i + 1] ?? "", dest: argv[i + 2] ?? "" });
  }
  return binds;
}

function expectedBwrapBinds(workspaceDir: string): Array<{ flag: string; source: string; dest: string }> {
  const expected = requiredFilesystemBinds().map((bind) => ({
    flag: bind.mode === "ro" ? "--ro-bind" : "--bind",
    source: bind.path,
    dest: bind.path,
  }));
  expected.push({ flag: "--bind", source: workspaceDir, dest: workspaceDir });
  return expected;
}

function bindKey(bind: { flag: string; source: string; dest: string }): string {
  return `${bind.flag} ${bind.source} ${bind.dest}`;
}

// ─── Runtime negative controls: repo read-only, workspace still writable ──
//
// P1-2 (ninth review), requirement (f): "negative controls: connector source
// not writable, node_modules not writable, evidence workspace still
// writable, a source-mutation attempt cannot win the strong claim". The
// zero-rw-binds tests below prove this at the ARGV level (the generated bwrap
// argv structurally cannot produce a writable REPO_ROOT bind); these tests
// prove the same property at RUNTIME — a real spawned isolated child
// actually attempting a write against these real paths — since an argv-shape
// check alone doesn't prove the KERNEL actually enforces what the argv
// declares (the same "advertise vs. honor" distinction this module's own
// probe-honesty history is built around).
//
// REPO_ROOT is derived the same way isolation.ts derives it (four `dirname`
// levels up from a file in this same directory) — not exported from
// isolation.ts itself, so recomputed here identically rather than adding a
// test-only export for a single path derivation.
const TEST_REPO_ROOT = resolvePath(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", ".."));

for (const mechanism of ["bwrap", "unshare"] as const) {
  const usable = mechanism === "bwrap" ? bwrapUsable : unshareUsable;

  test(`[${mechanism}] an isolated child CANNOT write into REPO_ROOT (connector source is not writable)`, {
    skip: !usable,
  }, async () => {
    const probeFileName = `.pdpp-repo-root-write-probe-${String(process.pid)}-${String(Date.now())}`;
    const probePath = join(TEST_REPO_ROOT, probeFileName);
    assert.ok(!existsSync(probePath), "sanity: the probe path must not already exist");
    const { stdout, exitCode } = await runIsolatedProbe(
      mechanism,
      `const fs=require("fs");try{fs.writeFileSync(${JSON.stringify(probePath)},"x");console.log("WRITE_SUCCEEDED");}catch(e){console.log("WRITE_BLOCKED:"+e.code);}`
    );
    // Belt-and-suspenders cleanup: if the write somehow DID succeed (the
    // exact regression this test exists to catch), remove the evidence
    // immediately so a real regression doesn't leave a stray file sitting in
    // the repo checkout on top of failing the assertion below.
    if (existsSync(probePath)) {
      rmSync(probePath, { force: true });
    }
    assert.equal(exitCode, 0, `probe child must exit cleanly; stdout was ${JSON.stringify(stdout)}`);
    assert.ok(
      stdout.startsWith("WRITE_BLOCKED:"),
      `an isolated child under ${mechanism} must NOT be able to write into REPO_ROOT — got ${JSON.stringify(stdout)}`
    );
    assert.ok(
      ["EROFS", "EACCES", "EPERM"].includes(stdout.slice("WRITE_BLOCKED:".length)),
      `expected a genuine read-only-filesystem error, got ${JSON.stringify(stdout)}`
    );
  });

  test(`[${mechanism}] an isolated child CANNOT write into node_modules`, {
    skip: !usable,
  }, async () => {
    const nodeModulesDir = join(TEST_REPO_ROOT, "node_modules");
    assert.ok(
      existsSync(nodeModulesDir),
      "sanity: node_modules must exist at REPO_ROOT for this probe to mean anything"
    );
    const probeFileName = `.pdpp-node-modules-write-probe-${String(process.pid)}-${String(Date.now())}`;
    const probePath = join(nodeModulesDir, probeFileName);
    const { stdout, exitCode } = await runIsolatedProbe(
      mechanism,
      `const fs=require("fs");try{fs.writeFileSync(${JSON.stringify(probePath)},"x");console.log("WRITE_SUCCEEDED");}catch(e){console.log("WRITE_BLOCKED:"+e.code);}`
    );
    if (existsSync(probePath)) {
      rmSync(probePath, { force: true });
    }
    assert.equal(exitCode, 0, `probe child must exit cleanly; stdout was ${JSON.stringify(stdout)}`);
    assert.ok(
      stdout.startsWith("WRITE_BLOCKED:"),
      `an isolated child under ${mechanism} must NOT be able to write into node_modules — got ${JSON.stringify(stdout)}`
    );
  });

  test(`[${mechanism}] an isolated child CAN still write into filesystemBindPath (the evidence workspace stays writable)`, {
    skip: !usable,
  }, async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-workspace-still-writable-"));
    try {
      const probePath = join(workspaceDir, "probe-file");
      const exitCode = await new Promise<number | null>((resolveExit) => {
        const child = spawnWithNetworkIsolation(
          process.execPath,
          ["-e", `require("fs").writeFileSync(${JSON.stringify(probePath)}, "x"); process.exit(0);`],
          { isolate: mechanism, filesystemBindPath: workspaceDir, stdio: "ignore" }
        );
        child.on("close", resolveExit);
      });
      assert.equal(exitCode, 0, `writing into filesystemBindPath under ${mechanism} must succeed`);
      assert.ok(
        existsSync(probePath),
        `the write into filesystemBindPath under ${mechanism} must actually have landed on the real host filesystem`
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
}

// ─── Recursive read-only — nested submount under a ro bind (P1, external
// review of ab415be6c) ──────────────────────────────────────────────────────
//
// `--rbind` (recursive bind) pulls in every submount that exists under a
// `ro` bind's source directory at bind time — but the classic
// `mount -o remount,ro,bind <staged>` step that follows only remounts the
// TOP mount; Linux does not apply that operation recursively to the
// submounts `--rbind` carried along. Before this fix, a nested mount point
// that existed under REPO_ROOT (or any other declared `ro` bind) at spawn
// time stayed WRITABLE inside the isolated child even though the parent
// directory correctly reported read-only. This test proves the fix by
// creating a REAL nested bind mount under REPO_ROOT on the host (requiring
// genuine bind-mount capability — the same `canBindMountOverAFile`/
// `bindMountCapable` gate the setup-command forced-failure tests above use),
// spawning an isolated child, and attempting a write specifically INSIDE
// that nested mount — asserting EACCES/EROFS, not just checking the parent
// directory.

for (const mechanism of ["bwrap", "unshare"] as const) {
  const usable = (mechanism === "bwrap" ? bwrapUsable : unshareUsable) && bindMountCapable;

  test(`[${mechanism}] a nested bind mount under REPO_ROOT (a ro bind) stays read-only inside isolation — not just the parent directory`, {
    skip: !usable,
  }, async () => {
    // A real, separate mount point INSIDE REPO_ROOT — a scratch directory
    // bind-mounted onto ANOTHER scratch directory that itself lives under
    // REPO_ROOT, mirroring the real-world shape this fix targets (Docker's
    // own /etc/resolv.conf-style injected submounts, or any nested mount
    // that happens to exist under a ro bind's real path at spawn time).
    const nestedSource = mkdtempSync(join(tmpdir(), "pdpp-nested-ro-source-"));
    writeFileSync(join(nestedSource, "seed.txt"), "seed");
    const nestedMountPoint = join(TEST_REPO_ROOT, `.pdpp-nested-ro-probe-${String(process.pid)}`);
    rmSync(nestedMountPoint, { recursive: true, force: true });
    mkdirSync(nestedMountPoint, { recursive: true });
    const mountResult = spawnSync("mount", ["--bind", nestedSource, nestedMountPoint], { stdio: "inherit" });
    assert.equal(
      mountResult.status,
      0,
      `sanity check: bind-mounting a real nested mount point under REPO_ROOT must itself succeed for this test's injection to mean anything`
    );
    try {
      const probeFileName = `.pdpp-nested-ro-write-probe-${String(process.pid)}`;
      const probePath = join(nestedMountPoint, probeFileName);
      const { stdout, exitCode } = await runIsolatedProbe(
        mechanism,
        `const fs=require("fs");try{fs.writeFileSync(${JSON.stringify(probePath)},"x");console.log("WRITE_SUCCEEDED");}catch(e){console.log("WRITE_BLOCKED:"+e.code);}`
      );
      if (existsSync(probePath)) {
        rmSync(probePath, { force: true });
      }
      assert.equal(exitCode, 0, `probe child must exit cleanly; stdout was ${JSON.stringify(stdout)}`);
      assert.ok(
        stdout.startsWith("WRITE_BLOCKED:"),
        `an isolated child under ${mechanism} must NOT be able to write into a NESTED mount under REPO_ROOT (only remounting the top-level ro bind, not its submounts, is exactly the P1 this test guards) — got ${JSON.stringify(stdout)}`
      );
      assert.ok(
        ["EROFS", "EACCES", "EPERM"].includes(stdout.slice("WRITE_BLOCKED:".length)),
        `expected a genuine read-only-filesystem error, got ${JSON.stringify(stdout)}`
      );
    } finally {
      spawnSync("umount", ["-l", nestedMountPoint], { stdio: "ignore" });
      rmSync(nestedMountPoint, { recursive: true, force: true });
      rmSync(nestedSource, { recursive: true, force: true });
    }
  });
}

// ─── Repository-UDS exception, reconciled: findPreexistingSocketsUnderReadOnlyBinds
// (P1, external review of ab415be6c) ──────────────────────────────────────
//
// Recursive read-only (proven above) closes the ability to CREATE a socket
// under a ro bind, but a socket that already existed at spawn time stays
// dialable — a ro bind blocks writes, not reads/dials. These tests prove
// the reconciling scan itself: it finds a real, nested socket under
// REPO_ROOT (no root/bind-mount capability needed — creating a UDS file is
// an ordinary, unprivileged filesystem operation), and stops finding it the
// moment it's removed — closing the loop the claim-eligibility gate depends
// on (see the `evaluateClaimEligibility` tests in bin/scenario-verify-strict.test.ts
// for the claim-text side of this same reconciliation).

// `AF_UNIX` socket paths are capped at `sizeof(sockaddr_un.sun_path)` — 108
// bytes on Linux, a hard kernel limit enforced by `bind(2)`/`listen(2)`
// (EINVAL/ENAMETOOLONG for anything longer), independent of filesystem path
// length limits (usually 4096) that apply everywhere else. `TEST_REPO_ROOT`
// itself is a real, unpredictable absolute path (the checkout location of
// whoever/whatever is running this suite — a CI runner, a colleague's home
// directory, a deeply nested worktree path), so a socket test that builds
// its path from `TEST_REPO_ROOT` plus even a modest suffix can silently
// exceed this limit in a long-path checkout while staying comfortably under
// it in a short one — confirmed: a test in this file failed with `EINVAL`
// in a worktree whose checkout path alone was long enough to push the total
// past 108 bytes, deterministically, not flakily, for every run from that
// location. Every test below that creates a REAL socket (not just a
// directory/symlink) keeps its own path components short and guards with
// this constant.
const UNIX_SOCKET_PATH_MAX_BYTES = 108;

test("findPreexistingSocketsUnderReadOnlyBinds: finds a real socket nested under REPO_ROOT, and stops finding it once removed", async (t) => {
  // Short name (`.psp-<pid>/l.sock`, not `.pdpp-socket-scan-probe-<pid>/leftover.sock`)
  // — see `UNIX_SOCKET_PATH_MAX_BYTES`'s doc comment.
  const nestedDir = join(TEST_REPO_ROOT, `.psp-${String(process.pid)}`);
  const socketPath = join(nestedDir, "l.sock");
  if (Buffer.byteLength(socketPath, "utf8") > UNIX_SOCKET_PATH_MAX_BYTES - 8) {
    t.skip(
      `TEST_REPO_ROOT (${TEST_REPO_ROOT}) is too long for an AF_UNIX socket path in this test — ` +
        `${String(Buffer.byteLength(socketPath, "utf8"))} bytes computed, kernel limit is ${String(UNIX_SOCKET_PATH_MAX_BYTES)}; ` +
        "this environment cannot exercise this specific test, not a defect in the scan itself"
    );
    return;
  }
  mkdirSync(nestedDir, { recursive: true });
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });

    const foundWhilePresent = findPreexistingSocketsUnderReadOnlyBinds();
    assert.ok(
      foundWhilePresent.complete,
      `expected a complete scan (no unreadable subtrees) while the socket is present; got errors ${JSON.stringify(foundWhilePresent.errors)}`
    );
    assert.ok(
      foundWhilePresent.sockets.includes(socketPath),
      `expected the scan to find the real socket at ${JSON.stringify(socketPath)}; got ${JSON.stringify(foundWhilePresent.sockets)}`
    );

    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(socketPath, { force: true });

    const foundAfterRemoval = findPreexistingSocketsUnderReadOnlyBinds();
    assert.ok(
      !foundAfterRemoval.sockets.includes(socketPath),
      `expected the scan to stop finding the socket once removed; got ${JSON.stringify(foundAfterRemoval.sockets)}`
    );
  } finally {
    server.close();
    rmSync(nestedDir, { recursive: true, force: true });
  }
});

test("findPreexistingSocketsUnderReadOnlyBinds: does NOT descend into symlinks (avoids an unbounded/cyclic walk)", () => {
  const nestedDir = join(TEST_REPO_ROOT, `.pdpp-socket-scan-symlink-probe-${String(process.pid)}`);
  mkdirSync(nestedDir, { recursive: true });
  const symlinkPath = join(nestedDir, "self-loop");
  try {
    // A symlink pointing back at its own parent directory — if the scan
    // followed symlinks, this would recurse forever (or at least far beyond
    // the bounded, finite walk this function's own doc comment promises).
    symlinkSync(nestedDir, symlinkPath, "dir");
    const result = findPreexistingSocketsUnderReadOnlyBinds();
    assert.ok(
      Array.isArray(result.sockets),
      "the scan must complete (not hang/throw) against a self-referential symlink"
    );
    assert.ok(result.complete, "a symlink loop must not itself be reported as an enumeration failure");
  } finally {
    rmSync(nestedDir, { recursive: true, force: true });
  }
});

// ─── Fail-closed on an unreadable subtree (P1-2, external review of
// ced8300be) ────────────────────────────────────────────────────────────
//
// An earlier version caught readdirSync's EACCES and silently returned from
// that subtree, treating "I could not see in here" as "nothing here" — a
// fail-OPEN default given this scan's whole purpose is to justify a strong
// claim. These tests plant a real socket, then lock its containing
// directory down so the scan cannot enumerate it, and assert the scan
// reports `complete: false` naming the exact unreadable path — never a
// silently-empty result. Linux enforces directory mode bits against the
// OWNING user too (not just other users), confirmed empirically, so these
// tests do not need a separate UID — chmod against a self-owned directory
// reproduces the real EACCES this function must handle.

test("findPreexistingSocketsUnderReadOnlyBinds: fails CLOSED (complete: false) on a chmod 000 subtree, never silently reports it clean", () => {
  const nestedDir = join(TEST_REPO_ROOT, `.pdpp-socket-scan-000-probe-${String(process.pid)}`);
  const blockedDir = join(nestedDir, "blocked");
  mkdirSync(blockedDir, { recursive: true });
  try {
    chmodSync(blockedDir, 0o000);
    const result = findPreexistingSocketsUnderReadOnlyBinds();
    assert.equal(
      result.complete,
      false,
      "a chmod 000 subtree the scan cannot readdirSync into must mark the scan incomplete, not silently clean"
    );
    assert.ok(
      result.errors.includes(blockedDir),
      `expected the unreadable path to be named in errors; got ${JSON.stringify(result.errors)}`
    );
  } finally {
    chmodSync(blockedDir, 0o755);
    rmSync(nestedDir, { recursive: true, force: true });
  }
});

test("findPreexistingSocketsUnderReadOnlyBinds: fails CLOSED on a chmod 311 (searchable, not listable) subtree hiding a real socket", async (t) => {
  // Directory read vs search are SEPARATE permissions: 311 grants
  // search/execute (traverse into a KNOWN child path) but not read (LIST
  // the directory's contents). readdirSync needs the read bit and throws
  // EACCES identically to a chmod 000 directory — but a socket with a
  // KNOWN name inside a 311 directory stays fully connectable (proven live
  // in this same test, not just asserted): this is the specific gap a
  // naive "just check if I can list it" mental model misses, and why this
  // scan must fail closed on EITHER permission shape identically.
  //
  // Names kept deliberately SHORT (`.pss311-<pid>/s/h.sock`, not a
  // descriptive `.pdpp-socket-scan-311-probe-<pid>/search-only/hidden.sock`)
  // to leave as much of the 108-byte budget as possible for
  // `TEST_REPO_ROOT` itself, which this test does not control — see
  // `UNIX_SOCKET_PATH_MAX_BYTES`'s doc comment above. This alone does not
  // ELIMINATE the dependency on checkout path length, only pushes the
  // threshold further out; the explicit skip below is the actual backstop
  // for a checkout path long enough to exceed even this.
  const nestedDir = join(TEST_REPO_ROOT, `.pss311-${String(process.pid)}`);
  const searchOnlyDir = join(nestedDir, "s");
  const socketPath = join(searchOnlyDir, "h.sock");
  if (Buffer.byteLength(socketPath, "utf8") > UNIX_SOCKET_PATH_MAX_BYTES - 8) {
    // Loud, explicit, reasoned skip — never a silent pass. This environment
    // (specifically, this checkout's absolute path) cannot run this test at
    // all: any socket path built from `TEST_REPO_ROOT` here would risk
    // exceeding the kernel's own 108-byte `AF_UNIX` path limit before this
    // test's own logic is even exercised, which would be a false failure
    // about path length, not a finding about the scan's fail-closed
    // behavior. The 8-byte margin covers this test's own short suffix
    // headroom, not a guarantee for every possible caller.
    t.skip(
      `TEST_REPO_ROOT (${TEST_REPO_ROOT}) is too long for an AF_UNIX socket path in this test — ` +
        `${String(Buffer.byteLength(socketPath, "utf8"))} bytes computed, kernel limit is ${String(UNIX_SOCKET_PATH_MAX_BYTES)}; ` +
        "this environment cannot exercise this specific test, not a defect in the scan itself"
    );
    return;
  }
  mkdirSync(searchOnlyDir, { recursive: true });
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });
    chmodSync(searchOnlyDir, 0o311);

    // Prove the socket is genuinely still reachable despite being
    // unlistable — the property that makes fail-open dangerous here, not
    // just theoretically.
    const stillConnectable = await new Promise<boolean>((resolveConnect) => {
      const client = createConnection(socketPath);
      client.on("connect", () => {
        client.destroy();
        resolveConnect(true);
      });
      client.on("error", () => resolveConnect(false));
    });
    assert.ok(
      stillConnectable,
      "sanity: a socket with a known name inside a chmod 311 directory must remain connectable — otherwise this test isn't proving the real gap"
    );

    const result = findPreexistingSocketsUnderReadOnlyBinds();
    assert.equal(
      result.complete,
      false,
      "a chmod 311 subtree (unlistable but searchable, hiding a live connectable socket) must mark the scan incomplete"
    );
    assert.ok(
      result.errors.includes(searchOnlyDir),
      `expected the unreadable path to be named in errors; got ${JSON.stringify(result.errors)}`
    );
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    chmodSync(searchOnlyDir, 0o755);
    rmSync(nestedDir, { recursive: true, force: true });
  }
});

// ─── TOCTOU narrowing: in-namespace re-scan catches what the one host-side
// pre-flight scan misses (P1-2, external review of ced8300be) ─────────────
//
// The host-side scan (`findPreexistingSocketsUnderReadOnlyBinds`, tested
// above) runs ONCE, before spawn, from the calling process — it cannot see
// a socket a HOST process plants AFTER that scan but BEFORE the isolated
// child's own `exec`. `inNamespaceSocketScanStatement` closes that gap by
// re-running the same kind of check twice more, IN NAMESPACE, wired into
// both `filesystemClosureShellPrelude` (unshare) and
// `bwrapArgvForFilesystemClosure` (bwrap). These tests plant the socket
// AFTER the host-side scan would have already run clean, proving the
// isolated child's OWN in-namespace scan — not the host-side one — is what
// actually catches it and refuses to run the target.
for (const mechanism of ["bwrap", "unshare"] as const) {
  const usable = mechanism === "bwrap" ? bwrapUsable : unshareUsable;

  test(`[${mechanism}] a socket planted under REPO_ROOT AFTER the host-side pre-flight scan is still caught by the in-namespace scan — the target never runs`, {
    skip: !usable,
  }, async (t) => {
    // Short names (`.pt-<mech>-<pid>/t.sock`, not a descriptive
    // `.pdpp-socket-toctou-probe-<mechanism>-<pid>/toctou.sock`) — see
    // `UNIX_SOCKET_PATH_MAX_BYTES`'s doc comment: `TEST_REPO_ROOT` itself is
    // an unpredictable, uncontrolled prefix this test doesn't own, and the
    // 108-byte AF_UNIX path cap is a hard kernel limit, not a style choice.
    const nestedDir = join(TEST_REPO_ROOT, `.pt-${mechanism}-${String(process.pid)}`);
    const socketPath = join(nestedDir, "t.sock");
    if (Buffer.byteLength(socketPath, "utf8") > UNIX_SOCKET_PATH_MAX_BYTES - 8) {
      t.skip(
        `TEST_REPO_ROOT (${TEST_REPO_ROOT}) is too long for an AF_UNIX socket path in this test — ` +
          `${String(Buffer.byteLength(socketPath, "utf8"))} bytes computed, kernel limit is ${String(UNIX_SOCKET_PATH_MAX_BYTES)}; ` +
          "this environment cannot exercise this specific test, not a defect in the scan itself"
      );
      return;
    }
    mkdirSync(nestedDir, { recursive: true });
    const markerPath = join(tmpdir(), `pdpp-isolation-toctou-marker-${mechanism}-${String(process.pid)}`);
    rmSync(markerPath, { force: true });
    const server = createServer();
    try {
      // Simulates the host-side pre-flight scan already having run CLEAN —
      // the real production call site (bin/scenario-verify.ts) runs its own
      // scan before this point in an actual replay; this test skips
      // re-implementing that call site and instead proves the STRONGER
      // property that the in-namespace scan alone (with no help from a
      // host-side scan at all) still catches a socket planted right before
      // spawn.
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socketPath, resolveListen);
      });

      const exitCode = await new Promise<number | null>((resolveExit) => {
        const child = spawnWithNetworkIsolation(
          process.execPath,
          ["-e", `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "ran"); process.exit(0);`],
          { isolate: mechanism, stdio: "ignore" }
        );
        child.on("close", resolveExit);
      });

      assert.notEqual(
        exitCode,
        0,
        `[${mechanism}] the spawn must NOT exit 0 when a pre-existing socket is present under a ro bind — the in-namespace scan must refuse to run`
      );
      assert.ok(
        !existsSync(markerPath),
        `[${mechanism}] the target command must NEVER run when the in-namespace socket scan finds a pre-existing socket`
      );
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(nestedDir, { recursive: true, force: true });
      rmSync(markerPath, { force: true });
    }
  });
}

// ─── Orphaned / replaced socket between scan and dial (P1-2, external
// review of ced8300be) ──────────────────────────────────────────────────
//
// A socket that is DELETED and RECREATED at the same path between a scan
// and the eventual dial is a distinct control from "a socket simply
// appears": it proves the scan isn't fooled by transient absence (e.g. a
// scan racing a socket's close-then-immediately-relisten cycle) into a
// false "clean" verdict for a path that is, at exec time, genuinely
// occupied by a live socket again. This plants a socket, removes it,
// recreates a DIFFERENT socket at the exact same path, then spawns — the
// in-namespace scan runs fresh at spawn time and must see whatever is
// AT THE PATH right then, not a stale first-seen-clean memory of it.
for (const mechanism of ["bwrap", "unshare"] as const) {
  const usable = mechanism === "bwrap" ? bwrapUsable : unshareUsable;

  test(`[${mechanism}] a socket deleted and RECREATED at the same path is still caught (not a stale "seen clean once" verdict)`, {
    skip: !usable,
  }, async (t) => {
    // Short names — see `UNIX_SOCKET_PATH_MAX_BYTES`'s doc comment.
    const nestedDir = join(TEST_REPO_ROOT, `.po-${mechanism}-${String(process.pid)}`);
    const socketPath = join(nestedDir, "o.sock");
    if (Buffer.byteLength(socketPath, "utf8") > UNIX_SOCKET_PATH_MAX_BYTES - 8) {
      t.skip(
        `TEST_REPO_ROOT (${TEST_REPO_ROOT}) is too long for an AF_UNIX socket path in this test — ` +
          `${String(Buffer.byteLength(socketPath, "utf8"))} bytes computed, kernel limit is ${String(UNIX_SOCKET_PATH_MAX_BYTES)}; ` +
          "this environment cannot exercise this specific test, not a defect in the scan itself"
      );
      return;
    }
    mkdirSync(nestedDir, { recursive: true });
    const markerPath = join(tmpdir(), `pdpp-isolation-orphan-marker-${mechanism}-${String(process.pid)}`);
    rmSync(markerPath, { force: true });
    const firstServer = createServer();
    let secondServer: ReturnType<typeof createServer> | undefined;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        firstServer.once("error", rejectListen);
        firstServer.listen(socketPath, resolveListen);
      });
      // Confirm the scan sees it once, establishing there is genuinely
      // something at this path before the delete/recreate cycle — not
      // asserted as the load-bearing check, just a sanity baseline.
      const seenFirst = findPreexistingSocketsUnderReadOnlyBinds();
      assert.ok(
        seenFirst.sockets.includes(socketPath),
        `sanity: expected the first socket to be visible before the orphan/replace cycle; got ${JSON.stringify(seenFirst.sockets)}`
      );
      await new Promise<void>((resolveClose) => firstServer.close(() => resolveClose()));
      rmSync(socketPath, { force: true });

      // Recreate a DIFFERENT socket at the SAME path — this is the orphan/
      // replace shape: the path existed, went away, and now exists again
      // with a new underlying socket, all before the isolated spawn below.
      secondServer = createServer();
      await new Promise<void>((resolveListen, rejectListen) => {
        secondServer?.once("error", rejectListen);
        secondServer?.listen(socketPath, resolveListen);
      });

      const exitCode = await new Promise<number | null>((resolveExit) => {
        const child = spawnWithNetworkIsolation(
          process.execPath,
          ["-e", `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "ran"); process.exit(0);`],
          { isolate: mechanism, stdio: "ignore" }
        );
        child.on("close", resolveExit);
      });

      assert.notEqual(
        exitCode,
        0,
        `[${mechanism}] the spawn must NOT exit 0 against the RECREATED socket — a fresh scan at spawn time must see it, not a stale first-look verdict`
      );
      assert.ok(
        !existsSync(markerPath),
        `[${mechanism}] the target command must NEVER run against the recreated (orphan/replaced) socket`
      );
    } finally {
      await new Promise<void>((resolveClose) => firstServer.close(() => resolveClose()));
      if (secondServer !== undefined) {
        const closeSecond = secondServer;
        await new Promise<void>((resolveClose) => closeSecond.close(() => resolveClose()));
      }
      rmSync(nestedDir, { recursive: true, force: true });
      rmSync(markerPath, { force: true });
    }
  });
}

// ─── cwd survives the filesystem closure (R9) ──────────────────────────────
//
// Node's `spawn(cmd, args, { cwd })` only sets the working directory of the
// process `spawn` itself starts. Under the `bwrap` mechanism that process
// IS the target (bwrap execs it directly), so `cwd` is honored automatically.
// Under `unshare`, the process `spawn` starts is `unshare` itself, which then
// runs an embedded `sh -c` script that stages a fresh root, `pivot_root`s
// into it, and only THEN `exec`s the real target — `cwd` never reaches that
// later `exec`. Before this fix, `filesystemClosureShellPrelude` always ran
// a bare `cd /` immediately after `pivot_root`, silently discarding whatever
// `cwd` the caller asked for. The real production call site
// (`bin/scenario-verify.ts`'s `runReplaySubprocess`) always passes
// `cwd: PACKAGE_ROOT` and depends on cwd-relative module resolution (`tsx`)
// working from there — under the old prelude, selecting the `unshare`
// mechanism (the documented fallback when `bwrap` is unavailable) made every
// real replay crash with `ERR_MODULE_NOT_FOUND`, not a security hole but a
// silent "fallback doesn't actually work" gap. `cwd` here is a real
// subdirectory under `TEST_REPO_ROOT` (mirroring `PACKAGE_ROOT`, itself
// always a subdirectory of `REPO_ROOT`) — already staged read-only by
// `requiredFilesystemBinds()`'s `REPO_ROOT` entry, so no extra bind is
// needed for this path to exist post-pivot, exactly like the real call site.
for (const mechanism of ["bwrap", "unshare"] as const) {
  const usable = mechanism === "bwrap" ? bwrapUsable : unshareUsable;

  test(`[${mechanism}] the isolated child's cwd is the caller-requested path, not "/"`, {
    skip: !usable,
  }, async () => {
    const requestedCwd = join(TEST_REPO_ROOT, "packages", "polyfill-connectors");
    assert.ok(existsSync(requestedCwd), "sanity: the requested cwd must exist on the real host filesystem");
    const child = spawnWithNetworkIsolation(process.execPath, ["-e", "console.log(process.cwd())"], {
      isolate: mechanism,
      cwd: requestedCwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolvePromise) => {
      child.on("close", resolvePromise);
    });
    assert.equal(exitCode, 0, `probe child must exit cleanly; stdout was ${JSON.stringify(stdout.trim())}`);
    assert.equal(
      stdout.trim(),
      requestedCwd,
      `isolated child under ${mechanism} did not honor the caller-requested cwd — got ${JSON.stringify(stdout.trim())}, expected ${JSON.stringify(requestedCwd)}`
    );
  });
}

// ─── Zero-rw-binds proof (P1-2, ninth review, requirement (f)) ────────────
//
// REPO READ-ONLY: `requiredFilesystemBinds()` used to return `{ path:
// REPO_ROOT, mode: "rw" }` — a connector could mutate its own source, other
// connectors' source, node_modules, or .git, and `dedupeBinds`'s
// first-ancestor-wins rule meant that one `rw` entry silently masked any
// narrower `ro` intent under it. This test proves the derived bind list
// itself now contains ZERO `rw` entries — the module-derived set is
// exhaustively read-only; the ONLY writable path anywhere in the isolated
// child's view is `filesystemBindPath` (the caller's own evidence
// workspace), which is NOT part of `requiredFilesystemBinds()`'s own return
// value at all (it's threaded through separately by
// `spawnWithNetworkIsolation`/`bwrapFilesystemClosureArgs`/
// `filesystemClosureShellPrelude`).
test("requiredFilesystemBinds() contains ZERO rw entries — REPO_ROOT and every other derived bind are read-only", () => {
  const binds = requiredFilesystemBinds();
  assert.ok(binds.length > 0, "sanity: the derived bind list must be non-empty");
  const rwBinds = binds.filter((b) => b.mode === "rw");
  assert.deepEqual(
    rwBinds,
    [],
    `every module-derived filesystem bind must be read-only; found rw entries: ${JSON.stringify(rwBinds)}`
  );
  const roBinds = binds.filter((b) => b.mode === "ro");
  assert.equal(roBinds.length, binds.length, 'every derived bind must be mode: "ro"');
});

test("[bwrap] the generated argv's ONLY rw bind is filesystemBindPath — every module-derived bind is --ro-bind", () => {
  const workspaceDir = "/tmp/pdpp-isolation-zero-rw-probe-workspace";
  const argv = bwrapArgvForFilesystemClosure("true", [], workspaceDir);
  const binds = extractBwrapBinds(argv).filter((bind) => bind.source !== "/proc" && bind.source !== "/dev");
  const rwBindSources = binds.filter((b) => b.flag === "--bind").map((b) => b.source);
  assert.deepEqual(
    rwBindSources,
    [workspaceDir],
    `the only --bind (rw) entry in the generated bwrap argv must be filesystemBindPath itself; got ${JSON.stringify(rwBindSources)}`
  );
});

test("[bwrap] the generated argv's ONLY rw bind is filesystemBindPath even when filesystemBindPath is omitted (zero rw entries at all)", () => {
  const argv = bwrapArgvForFilesystemClosure("true", [], undefined);
  const binds = extractBwrapBinds(argv).filter((bind) => bind.source !== "/proc" && bind.source !== "/dev");
  const rwBinds = binds.filter((b) => b.flag === "--bind");
  assert.deepEqual(
    rwBinds,
    [],
    `with no filesystemBindPath supplied, the argv must contain ZERO --bind (rw) entries; got ${JSON.stringify(rwBinds)}`
  );
});

test("[bwrap] the generated argv never binds the real host root, and binds only the derived allowlist plus filesystemBindPath", () => {
  const workspaceDir = "/tmp/pdpp-isolation-guard-workspace-probe";
  const argv = bwrapArgvForFilesystemClosure("true", [], workspaceDir);
  assert.ok(!argv.includes("--dev-bind"), `argv must not contain --dev-bind at all; got ${JSON.stringify(argv)}`);
  const rootBindIndex = argv.findIndex(
    (entry, i) => (entry === "--bind" || entry === "--ro-bind") && argv[i + 1] === "/"
  );
  assert.equal(rootBindIndex, -1, `argv must never bind "/" itself as a source; got ${JSON.stringify(argv)}`);
  assert.ok(
    argv.includes("--tmpfs") && argv[argv.indexOf("--tmpfs") + 1] === "/",
    "root must be a fresh --tmpfs /, not the host filesystem"
  );
  assert.ok(
    argv.includes("--unshare-pid"),
    "argv must unshare the PID namespace — without it the isolated child can enumerate and read every host process's /proc/<pid>/cmdline"
  );

  // The argv's non-/proc, non-/dev bind set must be EXACTLY the derived
  // allowlist plus filesystemBindPath — a symmetric-difference check, not a
  // one-directional "every found bind is allowed" check, so both an
  // undeclared EXTRA bind and a MISSING expected bind (or one with a
  // silently widened mode/flag) fail here.
  const actualBinds = extractBwrapBinds(argv).filter((bind) => bind.source !== "/proc" && bind.source !== "/dev");
  const expectedBinds = expectedBwrapBinds(workspaceDir);
  const actualKeys = new Set(actualBinds.map(bindKey));
  const expectedKeys = new Set(expectedBinds.map(bindKey));

  const unexpected = actualBinds.filter((bind) => !expectedKeys.has(bindKey(bind)));
  assert.deepEqual(
    unexpected,
    [],
    `argv contains binds outside the derived allowlist plus filesystemBindPath — an undeclared bind (or a widened flag/mode on an existing one) was added; got ${JSON.stringify(unexpected)}`
  );

  const missing = expectedBinds.filter((bind) => !actualKeys.has(bindKey(bind)));
  assert.deepEqual(
    missing,
    [],
    `argv is missing an expected allowlist bind — the derivation and the actual argv have drifted apart; missing ${JSON.stringify(missing)}`
  );
});

// ─── Guard mutation-tests itself: prove the guard above actually fires ────
//
// The independent review's critique of the PRIOR guard wasn't just "make it
// stricter" in the abstract — it specifically demanded proof that a
// re-widening is caught, via two concrete mutations: (1) an extra,
// undeclared bind added alongside the legitimate set, and (2) a `--dev-bind`
// variant. This test reimplements the same exact-set check the guard above
// uses, against a deliberately mutated argv, and asserts BOTH mutations are
// rejected — a mechanical regression test for the guard's own strength, not
// just a comment claiming it was manually verified once.
test("[bwrap] guard mutation test — an undeclared extra bind is rejected", () => {
  const workspaceDir = "/tmp/pdpp-isolation-guard-workspace-probe";
  const argv = bwrapArgvForFilesystemClosure("true", [], workspaceDir);
  // Mutation: splice in an ad hoc bind of a real, sensitive path that was
  // never part of requiredFilesystemBinds() or filesystemBindPath — mirrors
  // the independent review's own "--ro-bind /home/.../.ssh /home/.../.ssh"
  // mutation.
  const dashIndex = argv.indexOf("--");
  assert.ok(dashIndex > 0, "expected a -- separator in the generated argv");
  const mutatedArgv = [
    ...argv.slice(0, dashIndex),
    "--ro-bind",
    "/home/undeclared-ssh-dir",
    "/home/undeclared-ssh-dir",
    ...argv.slice(dashIndex),
  ];

  const actualBinds = extractBwrapBinds(mutatedArgv).filter(
    (bind) => bind.source !== "/proc" && bind.source !== "/dev"
  );
  const expectedKeys = new Set(expectedBwrapBinds(workspaceDir).map(bindKey));
  const unexpected = actualBinds.filter((bind) => !expectedKeys.has(bindKey(bind)));

  assert.equal(
    unexpected.length,
    1,
    "the guard's exact-set check must flag the undeclared extra bind — if this is 0, the guard would silently pass a re-widened sandbox"
  );
  assert.equal(unexpected[0]?.source, "/home/undeclared-ssh-dir");
});

test("[bwrap] guard mutation test — a --dev-bind variant is rejected", () => {
  const workspaceDir = "/tmp/pdpp-isolation-guard-workspace-probe";
  const argv = bwrapArgvForFilesystemClosure("true", [], workspaceDir);
  // Mutation: reintroduce the original escape shape, `--dev-bind / /`,
  // spliced in before the `--` separator.
  const dashIndex = argv.indexOf("--");
  assert.ok(dashIndex > 0, "expected a -- separator in the generated argv");
  const mutatedArgv = [...argv.slice(0, dashIndex), "--dev-bind", "/", "/", ...argv.slice(dashIndex)];

  assert.ok(
    mutatedArgv.includes("--dev-bind"),
    "sanity: the mutation must actually introduce --dev-bind into the argv"
  );
  // The guard's own first assertion (`!argv.includes("--dev-bind")`) is the
  // mechanism that catches this shape — prove it actually fires against the
  // mutated argv rather than trusting the guard's logic by inspection.
  assert.equal(
    mutatedArgv.includes("--dev-bind"),
    true,
    "the guard's --dev-bind check must see this mutation as present so its assertion fails"
  );

  const actualBinds = extractBwrapBinds(mutatedArgv).filter(
    (bind) => bind.source !== "/proc" && bind.source !== "/dev"
  );
  const expectedKeys = new Set(expectedBwrapBinds(workspaceDir).map(bindKey));
  const unexpected = actualBinds.filter((bind) => !expectedKeys.has(bindKey(bind)));
  assert.ok(
    unexpected.some((bind) => bind.flag === "--dev-bind" && bind.source === "/"),
    "the exact-set check must also independently flag the --dev-bind / / triple as an unexpected bind"
  );
});
