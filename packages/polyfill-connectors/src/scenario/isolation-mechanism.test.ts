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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  // Every --bind/--ro-bind source must be either filesystemBindPath or a
  // path requiredFilesystemBinds() actually derived — never an ad hoc
  // addition that bypassed the documented derivation.
  const derivedPaths = new Set(requiredFilesystemBinds().map((bind) => bind.path));
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--bind" && argv[i] !== "--ro-bind") {
      continue;
    }
    const source = argv[i + 1];
    if (source === "/proc" || source === "/dev") {
      continue;
    }
    assert.ok(
      source === workspaceDir || derivedPaths.has(source ?? ""),
      `bind source "${String(source)}" is neither filesystemBindPath nor a requiredFilesystemBinds() entry — an undeclared bind was added; got ${JSON.stringify(argv)}`
    );
  }
});
