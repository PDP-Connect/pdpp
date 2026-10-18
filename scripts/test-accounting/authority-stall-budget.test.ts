// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Behavioral tests for the leaf stall budget.
//
// The whole point of the budget is to tell two shapes apart, so both are
// exercised as REAL spawned child processes, never as source-text assertions:
//
//   (a) a STUCK child   — alive, holding its pipes open, producing nothing;
//   (b) a SLOW-PROGRESSING FINITE child — emitting a trickle of output with
//       gaps that are long relative to the budget but never exceed it, then
//       exiting on its own.
//
// (b) is the case a naive total-runtime cap gets wrong: it runs for LONGER
// than the stall budget in wall-clock terms while never being silent for
// longer than the budget. A correct implementation must let (b) finish and
// must kill (a).
//
// The budget, the watchdog tick and the deadlines are driven through
// PDPP_ACCOUNTING_STALL_BUDGET_MS, PDPP_ACCOUNTING_PROGRESS_TICK_MS and
// PDPP_ACCOUNTING_LEAF_DEADLINE_MS so the tests run in a fraction of a second
// per case rather than at the 300s / 5s / 600s production defaults; the code
// path under test is identical either way. Every fixture keeps the ratio its
// assertion depends on (a silence well over the budget, a heartbeat well
// inside it) and only shrinks the absolute wait. `capture` is exercised through the module's
// real spawn/append/watchdog machinery via a child that is a real `node -e`
// process, so a regression that removed the watchdog would leave (a) hanging
// until the enclosing per-file timeout killed the whole file.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { liveProcessGroupsForTest, trackProcessGroup } from "./authority.ts";

const STALLED_PATTERN = /STALLED/;
const NO_OUTPUT_PATTERN = /produced no output/;
const PROGRESS_PREFIX_PATTERN = /\[test-accounting\]/;
const STARTED_PATTERN = /started/;
const EXIT_ZERO_PATTERN = /exit 0/;
const DEADLINE_PATTERN = /deadline/i;
const TRANSCRIPT_FAILURE_PATTERN = /transcript test failure/;

// Watchdog tick used by every driver; production ticks every 5s.
const PROGRESS_TICK_MS = 100;

/** Wall-clock ms and outcome of running one child under a given stall budget. */
interface Outcome {
  code: number | null;
  durationMs: number;
  stderr: string;
  stdout: string;
}

// Drive the REAL authority capture path in a subprocess. authority.ts reads its
// budget from the environment at module load, so each case needs its own
// process; spawning one keeps the production module completely unmodified.
function runCapture(
  childScript: string,
  budgetMs: number,
  deadlineMs?: number,
  parseNodeEvents = false,
  failWriteAt?: number,
  hardTimeoutMs?: number,
  // Body of the injected transcript write (an async function body with `writes`
  // in scope); runs before the failWriteAt check.
  transcriptWriteBody = "",
  // Keep the driver alive this long after capture settles, so a late transcript
  // write can resolve and reveal any signal sent after the settlement.
  lingerMs = 0
): Promise<Outcome> {
  const driver = `
    // Record every process-group SIGKILL so a test can see signals sent after
    // the capture settled; the real kill still happens.
    const groupKills = [];
    const realKill = process.kill;
    process.kill = (pid, signal) => {
      if (typeof pid === "number" && pid < 0 && signal === "SIGKILL") groupKills.push(pid);
      return realKill.call(process, pid, signal);
    };
    const { runCaptureForTest } = await import(${JSON.stringify(new URL("./authority.ts", import.meta.url).href)});
    let writes = 0;
    // The group kill count at the moment each transcript write is released.
    const releasedWithKills = [];
    let outcome;
    try {
      const result = await runCaptureForTest(
        [process.execPath, "-e", ${JSON.stringify(childScript)}],
        process.cwd(),
        ${JSON.stringify(parseNodeEvents)},
        async () => {
          writes += 1;
          ${transcriptWriteBody}
          releasedWithKills.push(groupKills.length);
          if (writes === ${JSON.stringify(failWriteAt ?? null)}) throw new Error("transcript test failure");
        }
      );
      outcome = {
        stdout: result.stdout.slice(-1024),
        retained_capture_bytes: result.retained_capture_bytes,
        stdout_truncated: result.stdout_truncated,
        node_summary: result.node_summary,
      };
    } catch (error) {
      outcome = { capture_error: error.message };
      process.stderr.write(String(error.message) + "\\n");
      process.exitCode = 1;
    }
    const killsAtSettle = groupKills.length;
    await new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(lingerMs)}));
    process.stdout.write(JSON.stringify({
      ...outcome,
      writes,
      released_with_kills: releasedWithKills,
      kills_at_settle: killsAtSettle,
      kills_total: groupKills.length,
    }) + "\\n");
  `;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver], {
      env: {
        ...process.env,
        PDPP_ACCOUNTING_STALL_BUDGET_MS: String(budgetMs),
        PDPP_ACCOUNTING_PROGRESS_TICK_MS: String(PROGRESS_TICK_MS),
        ...(deadlineMs === undefined ? {} : { PDPP_ACCOUNTING_LEAF_DEADLINE_MS: String(deadlineMs) }),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const hardTimeout = setTimeout(
      () => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      },
      hardTimeoutMs ?? (deadlineMs === undefined ? 30_000 : deadlineMs + 5000)
    );
    child.on("close", (code) => {
      clearTimeout(hardTimeout);
      resolve({ code, durationMs: Date.now() - started, stderr, stdout });
    });
  });
}

// Holds stdout/stderr open and never writes: the exact wedge shape an operator
// cannot distinguish from slow work without a stall signal.
const STUCK_CHILD = "setInterval(() => {}, 1000);";

// Emits one line every `intervalMs` for `lines` lines, then exits 0.
function liveChild(intervalMs: number, lines: number): string {
  return `
    let n = 0;
    const timer = setInterval(() => {
      process.stdout.write("tick " + (++n) + "\\n");
      if (n === ${lines}) { clearInterval(timer); process.exit(0); }
    }, ${intervalMs});
  `;
}

// Total runtime (2s) exceeds the 1.5s stall budget used below, while the longest
// silence (200ms) is an eighth of it.
const SLOW_BUT_LIVE_CHILD = liveChild(200, 10);

// The cases below are independent real-process tests whose cost is wall-clock
// waiting, not CPU, so a few run side by side. Each spawns its own driver and
// leaf, and every shared-state assertion is per-driver, so overlap cannot leak
// between cases. The in-process tracker test below stays serial because it
// intercepts this process's `process.kill`.
describe("leaf capture lifecycle", { concurrency: 4 }, () => {
  test("a STUCK child is killed and reported once its silence exceeds the declared stall budget", async () => {
    const budgetMs = 1500;
    const outcome = await runCapture(STUCK_CHILD, budgetMs);

    // Without a watchdog this child never exits and this assertion times out.
    assert.equal(outcome.code, 1, "the wedged leaf must fail the run, not hang it");
    assert.match(outcome.stderr, STALLED_PATTERN, "the operator must be told the leaf stalled");
    assert.match(outcome.stderr, NO_OUTPUT_PATTERN, "the failure must name the stall as the cause");
    assert.ok(
      outcome.durationMs < budgetMs * 4,
      `expected the stuck child to be killed promptly after the budget, took ${outcome.durationMs}ms`
    );
  });

  test("a SLOW-PROGRESSING FINITE child runs to completion even though its total runtime exceeds the stall budget", async () => {
    const budgetMs = 1500;
    const outcome = await runCapture(SLOW_BUT_LIVE_CHILD, budgetMs);

    // This is the discrimination the budget exists for: ~2s of real work under a
    // 1.5s budget must survive, because no single silence ever reached 1.5s.
    assert.equal(outcome.code, 0, `slow-but-live leaf must not be killed; stderr was: ${outcome.stderr}`);
    assert.doesNotMatch(
      outcome.stderr,
      STALLED_PATTERN,
      "a leaf making steady progress must never be reported as stalled"
    );
    assert.ok(
      outcome.durationMs > budgetMs,
      `the fixture must actually outlive the budget to be meaningful, ran ${outcome.durationMs}ms`
    );
  });

  test("progress is reported on stderr while a leaf is quiet, so a live run is never silent", async () => {
    // The observability half: an operator watching a long leaf must see it is
    // alive. Heartbeats tick every PROGRESS_TICK_MS, so a leaf that outlives
    // several ticks emits at least one without ever stalling.
    const outcome = await runCapture(liveChild(150, 4), 60_000);

    assert.equal(outcome.code, 0);
    assert.match(outcome.stderr, PROGRESS_PREFIX_PATTERN, "progress must be visible on stderr");
    assert.match(outcome.stderr, STARTED_PATTERN, "the operator must see the leaf start");
    assert.match(outcome.stderr, EXIT_ZERO_PATTERN, "the operator must see the leaf finish");
  });

  test("a continuously chatty leaf is killed at its total deadline", async () => {
    const deadlineMs = 400;
    const outcome = await runCapture(
      "setInterval(() => process.stdout.write('.'.repeat(64 * 1024)), 1);",
      60_000,
      deadlineMs
    );

    assert.equal(outcome.code, 1, "a chatty leaf must fail at its total deadline");
    assert.match(outcome.stderr, DEADLINE_PATTERN, "the operator must be told the leaf exceeded its total deadline");
    assert.ok(outcome.durationMs < 4000, `deadline kill must be prompt; ran ${outcome.durationMs}ms`);
  });

  test("large non-event output completes with bounded retained capture", async () => {
    const child = `
    const chunk = 'x'.repeat(64 * 1024);
    let remaining = 8 * 1024 * 1024;
    function write() {
      while (remaining > 0) {
        const value = chunk.slice(0, Math.min(chunk.length, remaining));
        remaining -= value.length;
        if (!process.stdout.write(value)) { process.stdout.once('drain', write); return; }
      }
      process.stdout.write('\\nPDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test"}}\\n');
    }
    write();
  `;
    const outcome = await runCapture(child, 60_000, undefined, true);
    const result = JSON.parse(outcome.stdout) as {
      retained_capture_bytes: number;
      stdout_truncated: boolean;
      stdout: string;
      node_summary?: { assertions: number; passed: number; failed: number };
    };

    assert.equal(outcome.code, 0);
    assert.equal(result.node_summary?.assertions, 1, "structured counts must include the event after bulk output");
    assert.equal(result.node_summary?.passed, 1);
    assert.equal(result.node_summary?.failed, 0);
    assert.equal(result.stdout_truncated, true, "the diagnostic tail must report that stdout was truncated");
    assert.ok(
      result.retained_capture_bytes <= 128 * 1024,
      `retained capture was ${result.retained_capture_bytes} bytes`
    );
  });

  test("a leaf deadline kills a descendant that keeps inherited pipes open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-leaf-descendant-"));
    const pidFile = join(dir, "pid");
    const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setInterval(() => {}, 1000);
  `;
    let pid: number | undefined;
    try {
      const outcome = await runCapture(script, 60_000, 800);
      assert.ok(outcome.durationMs < 5000, `capture should settle before the hard guard, took ${outcome.durationMs}ms`);
      assert.equal(outcome.code, 1, "capture must fail after killing the descendant group");
      assert.match(outcome.stderr, DEADLINE_PATTERN);
      pid = Number(readFileSync(pidFile, "utf8"));
      await assertProcessGone(pid);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a clean leaf exit settles promptly and kills descendants that keep inherited pipes open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-leaf-clean-exit-"));
    const pidFile = join(dir, "pid");
    const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.exit(0);
  `;
    let pid: number | undefined;
    try {
      const pendingOutcome = runCapture(script, 60_000, 60_000, false, undefined, 2500);
      await waitForFile(pidFile, 1500);
      pid = Number(readFileSync(pidFile, "utf8"));
      const outcome = await pendingOutcome;
      assert.equal(outcome.code, 0, `clean parent exit must succeed; stderr was: ${outcome.stderr}`);
      assert.ok(
        outcome.durationMs < 1500,
        `capture should settle after the grace period, took ${outcome.durationMs}ms`
      );
      await assertProcessGone(pid);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SIGTERM of the authority kills every active leaf process group before exiting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-authority-signal-"));
    const pidFile = join(dir, "pid");
    const leaf = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
  `;
    const driver = `
    const { runCaptureForTest } = await import(${JSON.stringify(new URL("./authority.ts", import.meta.url).href)});
    await runCaptureForTest([process.execPath, "-e", ${JSON.stringify(leaf)}], process.cwd());
  `;
    const authority = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    let authorityStderr = "";
    authority.stderr?.on("data", (chunk: Buffer) => {
      authorityStderr += chunk.toString();
    });
    let pids: number[] = [];
    try {
      await waitForFile(pidFile, 2000);
      pids = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
      if (authority.pid === undefined) {
        assert.fail("authority process did not start");
      }
      process.kill(authority.pid, "SIGTERM");
      const exit = await waitForClose(authority, 2000);
      assert.equal(exit.signal, "SIGTERM", `authority should re-raise SIGTERM; stderr was: ${authorityStderr}`);
      for (const pid of pids) {
        // biome-ignore lint/performance/noAwaitInLoops: each assertion waits for a just-killed group member.
        await assertProcessGone(pid);
      }
    } finally {
      if (authority.pid !== undefined) {
        try {
          process.kill(-authority.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      if (pids[0]) {
        try {
          process.kill(-pids[0], "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a transcript write failure kills the process group and rejects instead of hanging", async () => {
    const outcome = await runCapture(
      "const chunk = 'x'.repeat(64 * 1024); setInterval(() => process.stdout.write(chunk), 1);",
      60_000,
      1000,
      false,
      3
    );
    assert.equal(outcome.code, 1);
    const result = JSON.parse(outcome.stdout) as { capture_error?: string; writes?: number };
    assert.match(result.capture_error ?? "", TRANSCRIPT_FAILURE_PATTERN);
    assert.equal(result.writes, 3);
    assert.ok(
      outcome.durationMs < 5000,
      `capture should settle promptly after write failure, took ${outcome.durationMs}ms`
    );
  });

  test("a fast leaf with a slow transcript writer is fully drained before the capture settles", async () => {
    // Five bursts of ten events land in the pipe within ~100ms and the leaf exits,
    // while each transcript write takes 600ms and keeps the pipes paused. The
    // exit grace (250ms, not shrunk here) must not discard the bursts the capture
    // has not read yet, so the write must outlast two of its periods.
    const child = `
    const line = 'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test"}}\\n';
    let burst = 0;
    const timer = setInterval(() => {
      process.stdout.write(line.repeat(10));
      if (++burst === 5) { clearInterval(timer); process.exit(0); }
    }, 20);
  `;
    const outcome = await runCapture(
      child,
      60_000,
      60_000,
      true,
      undefined,
      30_000,
      "await new Promise((resolve) => setTimeout(resolve, 600));"
    );
    const result = JSON.parse(outcome.stdout) as { node_summary?: { assertions: number; passed: number } };

    assert.equal(outcome.code, 0, `the slow-writer drain should succeed; stderr was: ${outcome.stderr}`);
    assert.equal(result.node_summary?.assertions, 50, "every emitted event must be counted, never a partial total");
    assert.equal(result.node_summary?.passed, 50);
  });

  test("a leaf's same-group descendant with ignored stdio is killed after a normal exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-leaf-ignored-stdio-"));
    const pidFile = join(dir, "pid");
    const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.exit(0);
  `;
    let pid: number | undefined;
    try {
      const outcome = await runCapture(script, 60_000, 60_000);
      assert.equal(outcome.code, 0, `clean parent exit must succeed; stderr was: ${outcome.stderr}`);
      pid = Number(readFileSync(pidFile, "utf8"));
      await assertProcessGone(pid);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the leaf deadline still bounds a transcript write that never resolves after the leaf exits", async () => {
    const outcome = await runCapture(
      "process.stdout.write('hello\\n');",
      60_000,
      500,
      false,
      undefined,
      8000,
      "await new Promise(() => {});"
    );
    const result = JSON.parse(outcome.stdout) as { capture_error?: string };

    assert.equal(outcome.code, 1, `a wedged transcript write must fail the run; stderr was: ${outcome.stderr}`);
    assert.match(result.capture_error ?? "", DEADLINE_PATTERN);
    assert.ok(outcome.durationMs < 5000, `deadline must bound the wedged write, took ${outcome.durationMs}ms`);
  });

  test("a stall rejection releases the leaf deadline so the authority process exits promptly", async () => {
    // The leaf writes once and stays alive while its transcript write never
    // resolves. The stall watchdog kills it and the run rejects, but the 60s leaf
    // deadline must not keep the authority process alive after that.
    const outcome = await runCapture(
      "process.stdout.write('hello\\n'); setInterval(() => {}, 1000);",
      1000,
      60_000,
      false,
      undefined,
      10_000,
      "await new Promise(() => {});"
    );
    const result = JSON.parse(outcome.stdout) as { capture_error?: string };

    assert.equal(outcome.code, 1, `a stalled leaf must fail the run; stderr was: ${outcome.stderr}`);
    assert.match(result.capture_error ?? "", NO_OUTPUT_PATTERN);
    assert.ok(
      outcome.durationMs < 5000,
      `the authority process must exit after the stall failure, took ${outcome.durationMs}ms`
    );
  });

  test("a transcript write that resolves after the capture rejected sends no further signal", async () => {
    // The deadline rejects the capture while the first transcript write is still
    // pending. Releasing the process group is one-shot: when that write resolves
    // later, the old numeric PGID must not be signalled again.
    const outcome = await runCapture(
      "process.stdout.write('hello\\n'); setInterval(() => {}, 1000);",
      60_000,
      500,
      false,
      undefined,
      10_000,
      "if (writes === 1) await new Promise((resolve) => setTimeout(resolve, 900));",
      600
    );
    const result = JSON.parse(outcome.stdout) as {
      capture_error?: string;
      kills_at_settle: number;
      kills_total: number;
    };

    assert.equal(outcome.code, 1, `the deadline must fail the run; stderr was: ${outcome.stderr}`);
    assert.match(result.capture_error ?? "", DEADLINE_PATTERN);
    assert.ok(result.kills_at_settle >= 1, "the deadline must have killed the group");
    assert.equal(
      result.kills_total,
      result.kills_at_settle,
      "no process-group signal may be sent after the capture settled"
    );
  });

  test("a group killed when its leaf exits is not signalled again by a failure kill during the drain", async () => {
    // The leaf exits at once and leaves a same-group child holding its pipes, so
    // the exit grace kills the group first. The first transcript write then takes
    // 0.8s and fails: a second kill path while the capture is still draining. Once
    // the group has been signalled its numeric PGID may be reused, so no later kill
    // path may signal it again before the capture settles.
    const outcome = await runCapture(
      `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      process.stdout.write('hello\\n');
      process.exit(0);
    `,
      60_000,
      60_000,
      false,
      1,
      20_000,
      "if (writes === 1) await new Promise((resolve) => setTimeout(resolve, 800));"
    );
    const result = JSON.parse(outcome.stdout) as { capture_error?: string; kills_at_settle: number };

    assert.equal(outcome.code, 1, `the failing write must fail the run; stderr was: ${outcome.stderr}`);
    assert.match(result.capture_error ?? "", TRANSCRIPT_FAILURE_PATTERN);
    assert.equal(
      result.kills_at_settle,
      1,
      "the process group must receive exactly one SIGKILL before the capture settles"
    );
  });

  test("a leaf that closes its pipes inside the exit grace signals its group before a slow transcript write is released", async () => {
    // The leaf writes once and exits at once. Its pipes close inside the exit grace
    // while the transcript write is still pending, so the capture settles through
    // the close path. The same-group child has ignored stdio and holds no pipe, so
    // only a group signal can reach it. That signal must land before the write is
    // released, and no group signal may follow the release.
    const dir = mkdtempSync(join(tmpdir(), "pdpp-leaf-early-close-"));
    const pidFile = join(dir, "pid");
    const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.stdout.write('hello\\n');
    process.exit(0);
  `;
    let pid: number | undefined;
    try {
      const outcome = await runCapture(
        script,
        60_000,
        60_000,
        false,
        undefined,
        20_000,
        "if (writes === 1) await new Promise((resolve) => setTimeout(resolve, 700));",
        300
      );
      pid = Number(readFileSync(pidFile, "utf8"));
      const result = JSON.parse(outcome.stdout) as { released_with_kills: number[]; kills_total: number };

      assert.equal(outcome.code, 0, `the early-close drain should succeed; stderr was: ${outcome.stderr}`);
      assert.deepEqual(
        result.released_with_kills,
        [1],
        "the process group must be signalled before the slow transcript write is released"
      );
      assert.equal(result.kills_total, 1, "no process-group signal may follow the release");
      await assertProcessGone(pid);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a newer tracker that reuses an older tracker's numeric PGID keeps its registry entry when the older one releases", () => {
  // Two trackers for one numeric PGID, in sequence. The fake leaders control the
  // identity, and negative-PID kills are intercepted so no real group is signalled.
  // The PGID is above any kernel pid_max, so an unintercepted kill would find no group.
  const pgid = 4_194_305;
  const groupSignals: number[] = [];
  const realKill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid < 0) {
      groupSignals.push(pid);
      return true;
    }
    return realKill.call(process, pid, signal);
  }) as typeof process.kill;
  const older = trackProcessGroup(fakeGroupLeader(pgid));
  const newer = trackProcessGroup(fakeGroupLeader(pgid));
  try {
    older.release();

    assert.deepEqual(
      liveProcessGroupsForTest(),
      [pgid],
      "the older tracker's release must not remove the newer tracker's entry"
    );
    assert.deepEqual(groupSignals, [], "the older tracker must not signal a group it no longer owns");
    newer.kill();
    assert.deepEqual(groupSignals, [-pgid], "the newer tracker must still signal its group");
    assert.deepEqual(liveProcessGroupsForTest(), [], "a landed kill unregisters the newer tracker's group");
  } finally {
    process.kill = realKill;
    newer.release();
  }
});

function fakeGroupLeader(pid: number): ReturnType<typeof spawn> {
  return Object.assign(new EventEmitter(), { pid }) as unknown as ReturnType<typeof spawn>;
}

async function assertProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: each check waits for the OS to reap the process just killed.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`descendant ${pid} survived the process-group kill`);
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: poll until the spawned leaf reports its pid.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${path}`);
}

function waitForClose(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<{ signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`authority did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("close", (_code, signal) => {
      clearTimeout(timer);
      resolve({ signal });
    });
  });
}
