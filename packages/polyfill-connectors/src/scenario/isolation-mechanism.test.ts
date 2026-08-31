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
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isNamespaceIsolationAvailable, spawnWithNetworkIsolation } from "./isolation.ts";

const bwrapUsable =
  process.platform === "linux" &&
  spawnSync("bwrap", ["--unshare-net", "--dev-bind", "/", "/", "true"], { stdio: "ignore", timeout: 5000 }).status ===
    0;

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
