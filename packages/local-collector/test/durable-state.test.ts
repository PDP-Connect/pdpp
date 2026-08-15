// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";
import { test } from "node:test";
import { parseArgs, resolveInspectionOptions } from "../bin/pdpp-local-collector.ts";
import {
  CollectorStateResolutionError,
  canonicalCollectorQueuePath,
  collectorStateDirectory,
  defaultCollectorStateRoot,
  resolveCollectorQueuePath,
} from "../src/durable-state.ts";
import { LocalDeviceOutbox } from "../src/runner.ts";

const SOURCE_A = "dsrc_test_a";
const SOURCE_B = "dsrc_test_b";
const MODULE_FILE = "durable-state.js";

function withTempRoot<T>(prefix: string, callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function modulePath(installRoot: string): string {
  return join(installRoot, "dist", "local-collector", "src", MODULE_FILE);
}

function packageLegacyPath(installRoot: string, name: string): string {
  return join(installRoot, "dist", "local-collector", ".pdpp-data", name);
}

function seedOutbox(path: string, sourceInstanceId: string, id = `test-${sourceInstanceId}-${path.length}`): void {
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id,
      kind: "record_batch",
      payload: { source: sourceInstanceId },
      sourceInstanceId,
    });
  } finally {
    outbox.close();
  }
}

function sourceSummary(path: string, sourceInstanceId: string): number {
  const outbox = new LocalDeviceOutbox({ path });
  try {
    return outbox.summary({ sourceInstanceId }).total;
  } finally {
    outbox.close();
  }
}

test("platform state roots are independent of cwd and use the platform convention", () => {
  assert.equal(
    defaultCollectorStateRoot({
      env: { XDG_STATE_HOME: "/state/x" },
      home: "/home/tester",
      platform: "linux",
    }),
    "/state/x"
  );
  assert.equal(
    defaultCollectorStateRoot({ env: {}, home: "/home/tester", platform: "linux" }),
    "/home/tester/.local/state"
  );
  assert.equal(
    defaultCollectorStateRoot({ env: { XDG_STATE_HOME: "/state/x" }, home: "/Users/tester", platform: "darwin" }),
    "/Users/tester/Library/Application Support"
  );
  assert.equal(
    defaultCollectorStateRoot({
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      home: "C:\\Users\\tester",
      platform: "win32",
    }),
    "C:\\Users\\tester\\AppData\\Local"
  );
  assert.equal(
    defaultCollectorStateRoot({ env: { XDG_STATE_HOME: "relative-state" }, home: "/home/tester", platform: "linux" }),
    "/home/tester/.local/state"
  );
});

test("source ids use injective filename segments", () => {
  const first = canonicalCollectorQueuePath({ sourceInstanceId: "a%b", stateRoot: "/state" });
  const second = canonicalCollectorQueuePath({ sourceInstanceId: "a_25b", stateRoot: "/state" });
  assert.notEqual(first, second);
  const pairFirst = canonicalCollectorQueuePath({ connectorId: "a-b", sourceInstanceId: "c", stateRoot: "/state" });
  const pairSecond = canonicalCollectorQueuePath({ connectorId: "a", sourceInstanceId: "b-c", stateRoot: "/state" });
  assert.notEqual(pairFirst, pairSecond);
});

test("explicit queue paths preserve valid path bytes", () => {
  const explicitPath = " /state/queue with spaces.sqlite ";
  assert.equal(
    resolveCollectorQueuePath({ configuredPath: explicitPath, configuredPathIsExplicit: true }),
    explicitPath
  );
});

test("explicit environment and profile queue paths preserve leading and trailing spaces", {
  concurrency: false,
}, () => {
  withTempRoot("pdpp-durable-state-whitespace-", (root) => {
    const profileDirectory = join(root, "profiles");
    const profileQueuePath = ` ${join(root, "profile queue.sqlite")} `;
    const environmentQueuePath = ` ${join(root, "environment queue.sqlite")} `;
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(
      join(profileDirectory, "profile.env"),
      `PDPP_CONNECTION_ID=${SOURCE_A}\nPDPP_COLLECTOR_QUEUE="${profileQueuePath}"\n`
    );
    const previousProfileDirectory = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    const previousQueuePath = process.env.PDPP_COLLECTOR_QUEUE;
    process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDirectory;
    process.env.PDPP_COLLECTOR_QUEUE = environmentQueuePath;
    try {
      assert.equal(parseArgs(["status"]).queuePath, environmentQueuePath);
      delete process.env.PDPP_COLLECTOR_QUEUE;
      const options = resolveInspectionOptions(parseArgs(["status", "--source-instance-id", SOURCE_A]));
      assert.equal(options.queuePath, profileQueuePath);
    } finally {
      if (previousProfileDirectory === undefined) {
        delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
      } else {
        process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previousProfileDirectory;
      }
      if (previousQueuePath === undefined) {
        delete process.env.PDPP_COLLECTOR_QUEUE;
      } else {
        process.env.PDPP_COLLECTOR_QUEUE = previousQueuePath;
      }
    }
  });
});

test("whitespace-only environment and profile queue paths remain explicit instead of falling back", {
  concurrency: false,
}, () => {
  const previousProfileDirectory = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  const previousQueuePath = process.env.PDPP_COLLECTOR_QUEUE;
  withTempRoot("pdpp-durable-state-whitespace-only-", (root) => {
    const profileDirectory = join(root, "profiles");
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(
      join(profileDirectory, "profile.env"),
      `PDPP_CONNECTION_ID=${SOURCE_A}\nPDPP_COLLECTOR_QUEUE="   "\n`
    );
    process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDirectory;
    process.env.PDPP_COLLECTOR_QUEUE = "   ";
    try {
      const fromEnvironment = parseArgs(["status"]);
      assert.equal(fromEnvironment.queuePath, "   ");
      assert.equal(fromEnvironment.queuePathExplicit, true);
      delete process.env.PDPP_COLLECTOR_QUEUE;
      const fromProfile = resolveInspectionOptions(parseArgs(["status", "--source-instance-id", SOURCE_A]));
      assert.equal(fromProfile.queuePath, "   ");
      assert.equal(fromProfile.queuePathExplicit, true);
    } finally {
      if (previousProfileDirectory === undefined) {
        delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
      } else {
        process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previousProfileDirectory;
      }
      if (previousQueuePath === undefined) {
        delete process.env.PDPP_COLLECTOR_QUEUE;
      } else {
        process.env.PDPP_COLLECTOR_QUEUE = previousQueuePath;
      }
    }
  });
});

test("the same source resolves to the same state across cwd and install roots", { concurrency: false }, () => {
  withTempRoot("pdpp-durable-state-stable-", (root) => {
    const stateRoot = join(root, "user-state");
    const cwdA = join(root, "worktree-a");
    const cwdB = join(root, "worktree-b");
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });
    const installA = join(root, "npx-cache-a", "package");
    const installB = join(root, "global-node-modules", "package");
    const previousCwd = process.cwd();
    try {
      chdir(cwdA);
      const first = resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installA),
        sourceInstanceId: SOURCE_A,
        stateRoot,
      });
      chdir(cwdB);
      const second = resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installB),
        sourceInstanceId: SOURCE_A,
        stateRoot,
      });

      assert.equal(first, second);
      assert.equal(
        first,
        canonicalCollectorQueuePath({ connectorId: "claude_code", sourceInstanceId: SOURCE_A, stateRoot })
      );
      assert.ok(first.startsWith(collectorStateDirectory(stateRoot)));
      assert.ok(!first.startsWith(installA));
      assert.ok(!first.startsWith(installB));
      assert.ok(!first.startsWith(cwdA));
      assert.ok(!first.startsWith(cwdB));
      assert.notEqual(
        first,
        canonicalCollectorQueuePath({ connectorId: "claude_code", sourceInstanceId: SOURCE_B, stateRoot })
      );
    } finally {
      chdir(previousCwd);
    }
  });
});

test("an explicit queue path wins before legacy discovery, including ambiguous stores", () => {
  withTempRoot("pdpp-durable-state-explicit-", (root) => {
    const stateRoot = join(root, "user-state");
    const legacyA = join(root, "legacy-a");
    const legacyB = join(root, "legacy-b");
    const explicitPath = join(root, "operator-owned", "queue.sqlite");
    seedOutbox(join(legacyA, "a.sqlite"), SOURCE_A);
    seedOutbox(join(legacyB, "b.sqlite"), SOURCE_A);

    const resolved = resolveCollectorQueuePath({
      configuredPath: explicitPath,
      configuredPathIsExplicit: true,
      connectorId: "claude_code",
      legacyRoots: [legacyA, legacyB],
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });

    assert.equal(resolved, explicitPath);
    assert.equal(
      existsSync(canonicalCollectorQueuePath({ connectorId: "claude_code", sourceInstanceId: SOURCE_A, stateRoot })),
      false
    );
    assert.equal(sourceSummary(join(legacyA, "a.sqlite"), SOURCE_A), 1);
    assert.equal(sourceSummary(join(legacyB, "b.sqlite"), SOURCE_A), 1);
  });
});

test("an explicit environment queue path remains ahead of a saved profile queue", { concurrency: false }, () => {
  withTempRoot("pdpp-durable-state-profile-precedence-", (root) => {
    const profileDirectory = join(root, "profiles");
    const profileQueuePath = join(root, "profile.sqlite");
    const explicitQueuePath = join(root, "explicit.sqlite");
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(
      join(profileDirectory, "profile.env"),
      `PDPP_CONNECTION_ID=${SOURCE_A}\nPDPP_COLLECTOR_QUEUE=${profileQueuePath}\n`
    );
    const previousProfileDirectory = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    const previousQueuePath = process.env.PDPP_COLLECTOR_QUEUE;
    process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDirectory;
    process.env.PDPP_COLLECTOR_QUEUE = explicitQueuePath;
    try {
      for (const command of ["status", "doctor", "retry-dead-letters", "prune-sent", "compact"] as const) {
        const options = resolveInspectionOptions(parseArgs([command, "--source-instance-id", SOURCE_A]));
        assert.equal(options.queuePath, explicitQueuePath);
        assert.equal(options.queuePathExplicit, true);
      }
    } finally {
      if (previousProfileDirectory === undefined) {
        delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
      } else {
        process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previousProfileDirectory;
      }
      if (previousQueuePath === undefined) {
        delete process.env.PDPP_COLLECTOR_QUEUE;
      } else {
        process.env.PDPP_COLLECTOR_QUEUE = previousQueuePath;
      }
    }
  });
});

test("a unique legacy stable-state store remains discoverable in place and stays source-isolated", () => {
  withTempRoot("pdpp-durable-state-legacy-", (root) => {
    const stateRoot = join(root, "user-state");
    const stableDirectory = collectorStateDirectory(stateRoot);
    const legacyA = join(stableDirectory, "legacy-a.sqlite");
    const legacyB = join(stableDirectory, "legacy-b.sqlite");
    seedOutbox(legacyA, SOURCE_A);
    seedOutbox(legacyB, SOURCE_B);

    const resolvedA = resolveCollectorQueuePath({
      connectorId: "claude_code",
      moduleUrl: modulePath(join(root, "install")),
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    const resolvedB = resolveCollectorQueuePath({
      connectorId: "codex",
      moduleUrl: modulePath(join(root, "install")),
      sourceInstanceId: SOURCE_B,
      stateRoot,
    });

    assert.equal(resolvedA, legacyA);
    assert.equal(resolvedB, legacyB);
    assert.equal(sourceSummary(resolvedA, SOURCE_A), 1);
    assert.equal(sourceSummary(resolvedB, SOURCE_B), 1);
    assert.equal(sourceSummary(resolvedA, SOURCE_B), 0);
    assert.equal(sourceSummary(resolvedB, SOURCE_A), 0);
  });
});

test("a unique package-local legacy store is handed off atomically without deleting the old pathname", () => {
  withTempRoot("pdpp-durable-state-migrate-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    seedOutbox(legacyPath, SOURCE_A);

    const resolved = resolveCollectorQueuePath({
      connectorId: "claude_code",
      moduleUrl: modulePath(installRoot),
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });

    assert.equal(resolved, canonicalPath);
    assert.equal(existsSync(legacyPath), true);
    assert.equal(existsSync(canonicalPath), true);
    assert.equal(sourceSummary(legacyPath, SOURCE_A), 1);
    assert.equal(sourceSummary(canonicalPath, SOURCE_A), 1);
    assert.equal(readFileSync(canonicalPath, { encoding: "utf8" }).startsWith("SQLite format 3"), true);
  });
});

test("migration reconciles a legacy write that lands after the snapshot", () => {
  withTempRoot("pdpp-durable-state-reconcile-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    seedOutbox(legacyPath, SOURCE_A, "before-snapshot");

    const resolved = resolveCollectorQueuePath({
      connectorId: "claude_code",
      moduleUrl: modulePath(installRoot),
      sourceInstanceId: SOURCE_A,
      stateRoot,
      beforeMigrationReconcile: () => seedOutbox(legacyPath, SOURCE_A, "after-snapshot"),
    });

    assert.equal(resolved, canonicalPath);
    assert.equal(sourceSummary(canonicalPath, SOURCE_A), 2);
  });
});

test("migration retires a live WAL legacy writer before canonical installation", () => {
  withTempRoot("pdpp-durable-state-handoff-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    const liveLegacyWriter = new LocalDeviceOutbox({ path: legacyPath });
    liveLegacyWriter.enqueue({
      id: "before-handoff",
      kind: "record_batch",
      payload: { source: SOURCE_A },
      sourceInstanceId: SOURCE_A,
    });
    assert.equal(existsSync(`${legacyPath}-wal`), true);

    try {
      let canonicalWriter: LocalDeviceOutbox | undefined;
      const resolved = resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installRoot),
        sourceInstanceId: SOURCE_A,
        stateRoot,
        afterMigrationInstall: () => {
          canonicalWriter = new LocalDeviceOutbox({ path: canonicalPath });
          canonicalWriter.enqueue({
            id: "canonical-during-handoff",
            kind: "record_batch",
            payload: { source: SOURCE_A },
            sourceInstanceId: SOURCE_A,
          });
          assert.throws(() =>
            liveLegacyWriter.enqueue({
              id: "after-canonical-install",
              kind: "record_batch",
              payload: { source: SOURCE_A },
              sourceInstanceId: SOURCE_A,
            })
          );
        },
      });

      assert.equal(resolved, canonicalPath);
      assert.equal(sourceSummary(canonicalPath, SOURCE_A), 2);
      assert.equal(sourceSummary(legacyPath, SOURCE_A), 1);
      assert.notEqual(statSync(legacyPath).ino, statSync(canonicalPath).ino);
      canonicalWriter?.close();
    } finally {
      liveLegacyWriter.close();
    }
  });
});

test("restart completes a handoff after failure between retirement and canonical install", () => {
  withTempRoot("pdpp-durable-state-crash-restart-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    seedOutbox(legacyPath, SOURCE_A, "before-crash");

    assert.throws(() =>
      resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installRoot),
        sourceInstanceId: SOURCE_A,
        stateRoot,
        afterRetirementFence: () => {
          throw new Error("simulated crash after durable retirement");
        },
      })
    );
    assert.equal(existsSync(canonicalPath), false);
    assert.equal(existsSync(legacyPath), true);

    const restarted = resolveCollectorQueuePath({
      connectorId: "claude_code",
      moduleUrl: modulePath(installRoot),
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    assert.equal(restarted, canonicalPath);
    assert.equal(sourceSummary(canonicalPath, SOURCE_A), 1);
    assert.equal(sourceSummary(legacyPath, SOURCE_A), 1);
  });
});

test("migration fails closed when the legacy and canonical roots cross filesystems", () => {
  if (!existsSync("/dev/shm")) {
    return;
  }
  const crossFilesystemRoot = mkdtempSync(join("/dev/shm", "pdpp-durable-state-cross-"));
  try {
    withTempRoot("pdpp-durable-state-cross-source-", (root) => {
      const legacyPath = packageLegacyPath(join(root, "npx-temp-package"), "collector-runner-queue.sqlite");
      seedOutbox(legacyPath, SOURCE_A);
      assert.notEqual(statSync(join(root, "npx-temp-package")).dev, statSync(crossFilesystemRoot).dev);
      assert.throws(
        () =>
          resolveCollectorQueuePath({
            connectorId: "claude_code",
            moduleUrl: modulePath(join(root, "npx-temp-package")),
            sourceInstanceId: SOURCE_A,
            stateRoot: crossFilesystemRoot,
          }),
        (error: unknown) =>
          error instanceof CollectorStateResolutionError && error.code === "legacy_state_migration_failed"
      );
      assert.equal(existsSync(legacyPath), true);
    });
  } finally {
    rmSync(crossFilesystemRoot, { force: true, recursive: true });
  }
});

test("migration ignores an orphaned crash artifact and restart reuses the installed canonical copy", () => {
  withTempRoot("pdpp-durable-state-restart-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "reaped-npx-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({ connectorId: "codex", sourceInstanceId: SOURCE_B, stateRoot });
    seedOutbox(legacyPath, SOURCE_B);
    mkdirSync(collectorStateDirectory(stateRoot), { recursive: true });
    const orphanedTemporaryPath = `${canonicalPath}.migration-crashed.tmp`;
    writeFileSync(orphanedTemporaryPath, "partial snapshot");

    const first = resolveCollectorQueuePath({
      connectorId: "codex",
      moduleUrl: modulePath(installRoot),
      sourceInstanceId: SOURCE_B,
      stateRoot,
    });
    const second = resolveCollectorQueuePath({
      connectorId: "codex",
      moduleUrl: modulePath(join(root, "new-install")),
      sourceInstanceId: SOURCE_B,
      stateRoot,
    });

    assert.equal(first, canonicalPath);
    assert.equal(second, canonicalPath);
    assert.equal(existsSync(orphanedTemporaryPath), true);
    assert.equal(existsSync(legacyPath), true);
    assert.equal(sourceSummary(canonicalPath, SOURCE_B), 1);
  });
});

test("multiple nonempty legacy stores fail closed, and an empty canonical file is not allowed to hide one", () => {
  withTempRoot("pdpp-durable-state-ambiguous-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "package");
    const legacyA = packageLegacyPath(installRoot, "a.sqlite");
    const legacyB = packageLegacyPath(installRoot, "b.sqlite");
    seedOutbox(legacyA, SOURCE_A);
    seedOutbox(legacyB, SOURCE_A);

    assert.throws(
      () =>
        resolveCollectorQueuePath({
          connectorId: "claude_code",
          moduleUrl: modulePath(installRoot),
          sourceInstanceId: SOURCE_A,
          stateRoot,
        }),
      (error: unknown) => error instanceof CollectorStateResolutionError && error.code === "legacy_state_ambiguous"
    );
    assert.equal(existsSync(legacyA), true);
    assert.equal(existsSync(legacyB), true);

    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    const emptyCanonical = new LocalDeviceOutbox({ path: canonicalPath });
    emptyCanonical.close();
    assert.throws(
      () =>
        resolveCollectorQueuePath({
          connectorId: "claude_code",
          moduleUrl: modulePath(installRoot),
          sourceInstanceId: SOURCE_A,
          stateRoot,
        }),
      (error: unknown) => error instanceof CollectorStateResolutionError && error.code === "legacy_state_ambiguous"
    );
    assert.equal(existsSync(canonicalPath), true);
    assert.equal(sourceSummary(legacyA, SOURCE_A), 1);
    assert.equal(sourceSummary(legacyB, SOURCE_A), 1);
  });
});
