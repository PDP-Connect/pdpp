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
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isNamespaceIsolationAvailable, spawnWithNetworkIsolation } from "./isolation.ts";

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
    const child = spawnWithNetworkIsolation(
      "node",
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

// ─── Pathname-UDS filesystem escape (FIX 5) — negative controls ───────────
//
// External review (independently reproduced): `--net`/`--unshare-net` only
// constrains the NETWORK namespace. A native descendant the isolated child
// spawns — `curl --unix-socket <path>`, never routed through this package's
// JS-layer fetch/http/net patching at all — could previously still dial ANY
// pathname UDS reachable on the shared filesystem, because the isolated
// child's filesystem view was left completely unrestricted. Reported repro:
// `unshare -r -n -- curl --unix-socket /tmp/foreign.sock
// http://localhost/probe` reached a socket the isolated process was never
// supposed to see.
//
// These tests are the reviewer's exact design, run against BOTH mechanisms:
// a plain Node http server (NOT this module's own code) listens on a
// pathname UDS the isolated child was never given — its own workspace
// directory, passed as `filesystemBindPath`, is a SIBLING, DIFFERENT
// directory. The isolated child then spawns native `curl --unix-socket
// <foreign path>` — a real OS-level descendant, exactly the escape class
// the JS-layer preload in subprocess-fetch-preloads.ts cannot see or deny.
// Passing (closing the escape) requires BOTH: the curl connect attempt
// fails, AND the foreign server's own hit counter — the authoritative
// signal, since a compromised/malicious child could lie about its own exit
// code — stays at zero.

/** Starts a plain (non-preloaded, not this module's code) HTTP server on a
 *  pathname UDS and returns a live request counter plus a close() to tear
 *  it down. This stands in for "an unrelated parent-namespace process
 *  listening on a UDS the isolated child should never be able to reach" —
 *  deliberately NOT `startFetchBridgeServer` from subprocess-fetch-preloads.ts,
 *  so this test proves the OS-layer closure, not anything about the bridge
 *  being well-behaved. */
function startForeignUdsServer(socketPath: string): { close: () => Promise<void>; hits: () => number } {
  let hitCount = 0;
  const server = createServer((_req, res) => {
    hitCount += 1;
    res.writeHead(200);
    res.end("should never be reached by an isolated child");
  });
  rmSync(socketPath, { force: true });
  server.listen(socketPath);
  return {
    hits: () => hitCount,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}

/** Runs `curl --unix-socket <foreignSocketPath> http://localhost/probe`
 *  inside a `spawnWithNetworkIsolation`-wrapped child, with `workspaceDir`
 *  (a directory that does NOT contain `foreignSocketPath`) passed as
 *  `filesystemBindPath` — the exact shape a real scenario-verify.ts run
 *  uses (its own evidence workspace re-exposed, everything else masked).
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

for (const mechanism of ["bwrap", "unshare"] as const) {
  const usable = mechanism === "bwrap" ? bwrapUsable : unshareUsable;
  test(`[${mechanism}] a native descendant (curl --unix-socket) cannot dial a foreign pathname UDS outside filesystemBindPath`, {
    skip: !usable,
  }, async () => {
    const foreignDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-foreign-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-workspace-"));
    const foreignSocketPath = join(foreignDir, "foreign.sock");
    const foreign = startForeignUdsServer(foreignSocketPath);
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
    const bridge = startForeignUdsServer(bridgeSocketPath);
    try {
      const exitCode = await runIsolatedCurlAgainstForeignSocket(mechanism, bridgeSocketPath, workspaceDir);
      assert.equal(
        exitCode,
        0,
        `curl must succeed dialing the bridge's own socket inside filesystemBindPath under ${mechanism} isolation — FIX 5 must not break the legitimate bridge path`
      );
      assert.equal(bridge.hits(), 1, "the bridge server must have received exactly the one legitimate request");
    } finally {
      await bridge.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
}

// ─── /run closure (independent second-pass review) — negative controls ────
//
// The FIX 5 controls above prove `/tmp` is masked. Independent review found
// a second, unclaimed instance of the SAME escape class: `/run` was never
// masked under bwrap at all, and was masked under `unshare` only as a side
// effect of the escape-hatch staging logic (which only runs when
// `filesystemBindPath` is set) — so `/run/user/<uid>`, the XDG runtime
// directory that on a real host holds live sockets for ssh-agent, the
// D-Bus session bus, PipeWire, etc., stayed fully reachable from an
// isolated child. Reproduced live on the review host. These tests are the
// same reviewer-specified shape as the FIX 5 controls above, run against a
// socket placed directly under `/run/user/<uid>` instead of under
// `os.tmpdir()`, proving `ALWAYS_MASKED_DIRS` closes this independently of
// `worldWritableTempDirs()`/`filesystemBindPath`.

const runtimeDir = process.getuid ? `/run/user/${String(process.getuid())}` : undefined;
const runtimeDirWritable = (() => {
  if (runtimeDir === undefined) {
    return false;
  }
  try {
    const probePath = join(runtimeDir, `pdpp-isolation-writable-probe-${String(process.pid)}`);
    writeFileSync(probePath, "");
    rmSync(probePath, { force: true });
    return true;
  } catch {
    return false;
  }
})();

for (const mechanism of ["bwrap", "unshare"] as const) {
  const usable = (mechanism === "bwrap" ? bwrapUsable : unshareUsable) && runtimeDirWritable;
  test(`[${mechanism}] a native descendant (curl --unix-socket) cannot dial a foreign pathname UDS under /run/user/<uid>`, {
    skip: !usable,
  }, async () => {
    if (runtimeDir === undefined) {
      return;
    }
    const workspaceDir = mkdtempSync(join(tmpdir(), "pdpp-isolation-workspace-"));
    const foreignSocketPath = join(runtimeDir, `pdpp-isolation-run-foreign-${String(process.pid)}.sock`);
    const foreign = startForeignUdsServer(foreignSocketPath);
    try {
      const exitCode = await runIsolatedCurlAgainstForeignSocket(mechanism, foreignSocketPath, workspaceDir);
      assert.notEqual(
        exitCode,
        0,
        `curl must NOT succeed dialing a foreign UDS under /run/user/<uid> from inside ${mechanism} isolation — exit 0 means /run is still reachable`
      );
      assert.equal(
        foreign.hits(),
        0,
        "the foreign server's own hit counter is authoritative — any nonzero count means the isolated child reached a live /run/user/<uid> socket (ssh-agent, dbus, etc. on a real host)"
      );
    } finally {
      await foreign.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  // Finding 2 (independent review): under `unshare`, `/run` masking used to
  // be an ACCIDENTAL side effect of the escape-hatch staging logic, which
  // only ran when `filesystemBindPath` was set — so a call to
  // `spawnWithNetworkIsolation` with `isolate` set but NO
  // `filesystemBindPath` (the type signature allows this) got zero `/run`
  // masking under `unshare`, even though bwrap's masking was unconditional
  // by construction. This test calls `spawnWithNetworkIsolation` with
  // `filesystemBindPath` OMITTED ENTIRELY, proving `/run` closure is now a
  // standalone, declared invariant under both mechanisms rather than an
  // emergent property of some other feature's plumbing.
  test(`[${mechanism}] /run/user/<uid> is masked even when filesystemBindPath is NOT passed at all`, {
    skip: !usable,
  }, async () => {
    if (runtimeDir === undefined) {
      return;
    }
    const foreignSocketPath = join(runtimeDir, `pdpp-isolation-run-nobindpath-${String(process.pid)}.sock`);
    const foreign = startForeignUdsServer(foreignSocketPath);
    try {
      const exitCode = await new Promise<number | null>((resolve) => {
        const child = spawnWithNetworkIsolation(
          "curl",
          ["-s", "-o", "/dev/null", "--max-time", "3", "--unix-socket", foreignSocketPath, "http://localhost/probe"],
          { isolate: mechanism, stdio: "ignore" }
        );
        child.on("close", resolve);
        child.on("error", () => resolve(-1));
      });
      assert.notEqual(
        exitCode,
        0,
        `curl must NOT succeed dialing a /run/user/<uid> UDS under ${mechanism} isolation even with no filesystemBindPath passed`
      );
      assert.equal(
        foreign.hits(),
        0,
        "the foreign server's hit counter must stay 0 — /run masking must not depend on filesystemBindPath being set"
      );
    } finally {
      await foreign.close();
    }
  });
}
