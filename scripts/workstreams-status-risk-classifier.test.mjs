#!/usr/bin/env node
/**
 * Fixture-based tests for the wrapper-lane risk classifier in workstreams-status.mjs.
 *
 * Runs workstreams-status.mjs --no-fail against a minimal fake repo layout and
 * asserts that thin-transcript risks are emitted or suppressed as expected.
 *
 * Run: node scripts/workstreams-status-risk-classifier.test.mjs
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const statusScript = join(__dirname, "workstreams-status.mjs");

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`PASS: ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`FAIL: ${label}\n  ${detail}`);
  failed++;
}

/**
 * Run workstreams-status.mjs --no-fail against a fake wrapper directory
 * containing a single lane with the given status.json fields.
 * Returns stdout as a string.
 */
function runWithFixture(statusData, options = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "ws-status-test-"));
  try {
    // Fake git repo so the script can parse worktrees / branch status.
    execFileSync("git", ["init", "--quiet", tmp]);
    execFileSync("git", ["-C", tmp, "commit", "--allow-empty", "--quiet", "-m", "init"]);

    const lane = statusData.lane ?? "test-lane";
    const ts = "20260101T000000Z";
    const artifactDir = join(tmp, "tmp", "workstreams", "claude-wrapper", lane, ts);
    mkdirSync(artifactDir, { recursive: true });

    if (options.parked) {
      const parkedDir = join(tmp, "tmp", "workstreams", "parked", lane);
      mkdirSync(parkedDir, { recursive: true });
      writeFileSync(join(parkedDir, "status.txt"), "parked by owner\n");
    }

    const extraEnv = {};
    if (options.tmuxOutput !== undefined) {
      const fakeBin = join(tmp, "bin");
      mkdirSync(fakeBin, { recursive: true });
      const tmuxOutput = typeof options.tmuxOutput === "function" ? options.tmuxOutput(tmp) : options.tmuxOutput;
      const tmuxScript = `#!/usr/bin/env bash
if [[ "$1" == "list-panes" ]]; then
  cat <<'TMUX_EOF'
${tmuxOutput}
TMUX_EOF
  exit 0
fi
exit 1
`;
      const tmuxPath = join(fakeBin, "tmux");
      writeFileSync(tmuxPath, tmuxScript);
      chmodSync(tmuxPath, 0o755);
      extraEnv.PATH = `${fakeBin}:${process.env.PATH}`;
    }

    if (options.corruptStatus) {
      writeFileSync(join(artifactDir, "status.json"), "");
    } else {
      writeFileSync(
        join(artifactDir, "status.json"),
        JSON.stringify({ lane, started_at: ts, ended_at: "2026-01-01T00:30:00Z", ...statusData })
      );
    }

    // workstreams-status.mjs resolves repoRoot via git; we must run from the fake repo.
    return execFileSync("node", [statusScript, "--no-fail"], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, ...extraEnv, HOME: process.env.HOME },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Test cases ---

// 1. Aborted lane with zero transcript_bytes must NOT appear in Risks.
try {
  const out = runWithFixture({
    lane: "ri-connector-green-no-human-v3",
    status: "aborted",
    report_state: "absent",
    exit_code: 130,
    transcript_bytes: 0,
  });
  if (out.includes("thin-transcript")) {
    fail("aborted/zero-bytes: thin-transcript risk emitted (should be suppressed)", out);
  } else {
    pass("aborted/zero-bytes: thin-transcript risk suppressed");
  }
} catch (err) {
  fail("aborted/zero-bytes: script threw", err.message);
}

// 2. Aborted lane with zero transcript_bytes must still appear in Wrapper Lanes inventory.
try {
  const out = runWithFixture({
    lane: "ri-connector-green-no-human-v3",
    status: "aborted",
    report_state: "absent",
    exit_code: 130,
    transcript_bytes: 0,
  });
  if (!out.includes("aborted")) {
    fail("aborted/zero-bytes: lane not visible in Wrapper Lanes inventory", out);
  } else {
    pass("aborted/zero-bytes: lane visible in Wrapper Lanes inventory");
  }
} catch (err) {
  fail("aborted/zero-bytes: script threw", err.message);
}

// 3. Completed lane with zero transcript_bytes MUST appear as a thin-transcript risk.
try {
  const out = runWithFixture({
    lane: "ri-some-completed-lane",
    status: "completed",
    report_state: "present",
    exit_code: 0,
    transcript_bytes: 0,
  });
  if (!out.includes("thin-transcript")) {
    fail("completed/zero-bytes: thin-transcript risk not emitted (should surface)", out);
  } else {
    pass("completed/zero-bytes: thin-transcript risk correctly surfaced");
  }
} catch (err) {
  fail("completed/zero-bytes: script threw", err.message);
}

// 4. Failed lane with zero transcript_bytes MUST appear as a thin-transcript risk.
try {
  const out = runWithFixture({
    lane: "ri-some-failed-lane",
    status: "failed",
    report_state: "absent",
    exit_code: 1,
    transcript_bytes: 0,
  });
  if (!out.includes("thin-transcript")) {
    fail("failed/zero-bytes: thin-transcript risk not emitted (should surface)", out);
  } else {
    pass("failed/zero-bytes: thin-transcript risk correctly surfaced");
  }
} catch (err) {
  fail("failed/zero-bytes: script threw", err.message);
}

// 5. Completed lane with a large transcript must NOT appear as a thin-transcript risk.
try {
  const out = runWithFixture({
    lane: "ri-healthy-lane",
    status: "completed",
    report_state: "present",
    exit_code: 0,
    transcript_bytes: 50000,
  });
  if (out.includes("thin-transcript")) {
    fail("completed/large-bytes: thin-transcript risk emitted unexpectedly", out);
  } else {
    pass("completed/large-bytes: no false thin-transcript risk");
  }
} catch (err) {
  fail("completed/large-bytes: script threw", err.message);
}

// 6. Recovered report-only lane whose branch no longer exists must NOT appear as a live risk.
try {
  const out = runWithFixture({
    branch: "workstream/already-parked",
    lane: "ri-recovered-parked-lane",
    status: "complete",
    report_state: "recovered",
    recovered: true,
    exit_code: 0,
    transcript_bytes: 1,
  });
  if (out.includes("thin-transcript")) {
    fail("recovered/parked: thin-transcript risk emitted for historical lane", out);
  } else if (!out.includes("ri-recovered-parked-lane")) {
    fail("recovered/parked: lane disappeared from wrapper inventory", out);
  } else {
    pass("recovered/parked: no live risk, still visible in inventory");
  }
} catch (err) {
  fail("recovered/parked: script threw", err.message);
}

// 7. Completed report-bearing lane whose branch no longer exists must NOT appear as a live risk.
try {
  const out = runWithFixture({
    branch: "workstream/already-merged",
    lane: "ri-completed-merged-lane",
    status: "complete",
    report_state: "present",
    recovered: false,
    exit_code: 0,
    transcript_bytes: 127,
  });
  if (out.includes("thin-transcript")) {
    fail("completed/merged: thin-transcript risk emitted for historical lane", out);
  } else if (!out.includes("ri-completed-merged-lane")) {
    fail("completed/merged: lane disappeared from wrapper inventory", out);
  } else {
    pass("completed/merged: no live risk, still visible in inventory");
  }
} catch (err) {
  fail("completed/merged: script threw", err.message);
}

// 8. Explicitly parked failed lane with corrupt status must remain visible but stop blocking owner status.
try {
  const out = runWithFixture(
    {
      lane: "ri-parked-corrupt-lane",
      status: "failed",
      report_state: "absent",
      exit_code: 1,
      transcript_bytes: 0,
    },
    { corruptStatus: true, parked: true }
  );
  if (out.includes("WRAPPER-LANE failed lane=ri-parked-corrupt-lane")) {
    fail("parked/corrupt: failed wrapper risk emitted for parked historical lane", out);
  } else if (!out.includes("ri-parked-corrupt-lane") || !out.includes("parked=true")) {
    fail("parked/corrupt: lane disappeared or missing parked marker", out);
  } else {
    pass("parked/corrupt: no live risk, still visible as parked inventory");
  }
} catch (err) {
  fail("parked/corrupt: script threw", err.message);
}

// 9. A running lane with no wrapper process must still surface as an owner risk.
try {
  const out = runWithFixture({
    lane: "ri-running-orphan",
    status: "running",
    report_state: "absent",
    exit_code: -1,
    transcript_bytes: -1,
  });
  if (!out.includes("running-without-process lane=ri-running-orphan")) {
    fail("running/orphan: missing owner risk for running lane without process", out);
  } else {
    pass("running/orphan: owner risk emitted");
  }
} catch (err) {
  fail("running/orphan: script threw", err.message);
}

// 10. Idle shell panes in the repo should surface as cleanup candidates, while
// live Claude panes and shells outside the repo should not.
try {
  const out = runWithFixture(
    {
      lane: "ri-healthy-lane",
      status: "completed",
      report_state: "present",
      exit_code: 0,
      transcript_bytes: 50000,
    },
    {
      tmuxOutput: (repo) =>
        [
          `%1\tmain\t26\tcq-salvage\tzsh\t999999\t${repo}`,
          `%2\tmain\t6\tri-owner-delegate-live\tclaude\t999998\t${repo}`,
          `%3\tmain\t8\tzsh\tzsh\t999997\t${tmpdir()}`,
        ].join("\n"),
    }
  );
  if (!out.includes("Idle Tmux Cleanup Candidates")) {
    fail("tmux-cleanup: cleanup section missing", out);
  } else if (!out.includes("main:26:cq-salvage")) {
    fail("tmux-cleanup: idle repo shell not listed", out);
  } else if (out.includes("ri-owner-delegate-live pane=%2")) {
    fail("tmux-cleanup: live Claude pane listed as cleanup candidate", out);
  } else if (out.includes("main:8:zsh pane=%3")) {
    fail("tmux-cleanup: shell outside repo listed as cleanup candidate", out);
  } else {
    pass("tmux-cleanup: idle repo shell listed and non-candidates excluded");
  }
} catch (err) {
  fail("tmux-cleanup: script threw", err.message);
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
