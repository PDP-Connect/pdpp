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
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bwrapArgvForFilesystemClosure,
  isNamespaceIsolationAvailable,
  requiredFilesystemBinds,
  spawnWithNetworkIsolation,
} from "./isolation.ts";

const bwrapUsable =
  process.platform === "linux" &&
  spawnSync("bwrap", ["--unshare-net", "--dev-bind", "/", "/", "true"], { stdio: "ignore", timeout: 5000 }).status ===
    0;

const unshareUsable =
  process.platform === "linux" &&
  spawnSync("unshare", ["-r", "-n", "-m", "true"], { stdio: "ignore", timeout: 5000 }).status === 0;

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

// ─── Double-probe / non-atomic mechanism selection regression ─────────────
//
// A caller that already ran `isNamespaceIsolationAvailable()` once and
// passes `opts.isolate` as a bare `true` (a boolean) instead of the
// resolved `capability.mechanism` makes `spawnWithNetworkIsolation` call
// `detectMechanism()`, which re-runs the ENTIRE probe (spawning `unshare`,
// and — if that's denied — `bwrap`) from scratch on every single spawn,
// contradicting the "probe once, reuse everywhere" contract callers rely
// on. This test proves that contract mechanically: with fake `unshare`/
// `bwrap` binaries on PATH that log every invocation, passing the
// already-known mechanism directly must invoke the probe binaries ZERO
// times, while passing a bare `true` must invoke them (the regression this
// test exists to catch if a caller — or this function itself — regresses
// back to re-probing).

/** Writes a fake `unshare`/`bwrap` shell shim to `dir/name` that appends its
 *  full argv (one line, space-joined) to `logPath` and exits 0, then
 *  returns `dir` prepended onto `PATH` so a child process resolves the fake
 *  binary instead of the real one. */
function fakeIsolationBinDir(logPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-isolation-fake-bin-"));
  for (const name of ["unshare", "bwrap"]) {
    const scriptPath = join(dir, name);
    writeFileSync(scriptPath, `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(logPath)}\nexit 0\n`, { mode: 0o755 });
  }
  return dir;
}

test("spawnWithNetworkIsolation given an already-resolved mechanism does NOT re-probe (no unshare/bwrap probe invocation)", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-probe-log-"));
  const logPath = join(logDir, "invocations.log");
  writeFileSync(logPath, "");
  const fakeBinDir = fakeIsolationBinDir(logPath);
  const fakePath = `${fakeBinDir}:${process.env.PATH ?? ""}`;
  // detectMechanism()'s isNamespaceIsolationAvailable() probe (when it runs
  // at all — the whole point of this test is that it must NOT) runs
  // spawnSync in THIS process using THIS process's env/PATH, not the
  // spawned child's — so the fake binaries must be resolvable from here too.
  const realPath = process.env.PATH;
  process.env.PATH = fakePath;

  try {
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawnWithNetworkIsolation("node", ["-e", "process.exit(0)"], {
        isolate: "bwrap",
        stdio: "ignore",
        env: { ...process.env, PATH: fakePath },
      });
      child.on("close", resolve);
    });
    assert.equal(exitCode, 0);

    const invocations = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    // Exactly one bwrap call: the ACTUAL wrapped spawn (`bwrap --unshare-net
    // ... -- sh -c ...`), never a probe call (`bwrap --unshare-net
    // --dev-bind / / true`, no trailing `-- sh -c`) and never an `unshare`
    // call at all — proving detectMechanism()'s `isNamespaceIsolationAvailable()`
    // re-probe path was never taken when the mechanism was already known.
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
      invocations[0]?.includes("-- sh -c"),
      `expected the real wrapped-spawn argv shape, not a probe; got ${JSON.stringify(invocations)}`
    );
  } finally {
    process.env.PATH = realPath;
    rmSync(logDir, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("spawnWithNetworkIsolation given a bare `true` DOES re-probe (documents the boolean fallback path's cost, for contrast)", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-probe-log-"));
  const logPath = join(logDir, "invocations.log");
  writeFileSync(logPath, "");
  const fakeBinDir = fakeIsolationBinDir(logPath);
  const fakePath = `${fakeBinDir}:${process.env.PATH ?? ""}`;
  const realPath = process.env.PATH;
  process.env.PATH = fakePath;

  try {
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawnWithNetworkIsolation("node", ["-e", "process.exit(0)"], {
        isolate: true,
        stdio: "ignore",
        env: { ...process.env, PATH: fakePath },
      });
      child.on("close", resolve);
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
  } finally {
    process.env.PATH = realPath;
    rmSync(logDir, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
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
  return `${bind.flag} ${bind.source} ${bind.dest}`;
}

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
