// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  type CpuQuotaProbe,
  cgroupCpuQuota,
  cgroupMemoryQuota,
  effectiveCpuCount,
  effectiveMemoryBudgetBytes,
} from "../server/cpu-quota.ts";

interface ProbeOverrides {
  availableParallelism?: () => number;
  cgroupMounted?: boolean;
  /** Raw /proc/self/cgroup file content. Omit to simulate the file being unreadable. */
  cgroupText?: string;
  /** Extra absolute-path -> content entries (quota files at any ancestor level). */
  files?: Record<string, string>;
  /** Raw /proc/self/mountinfo file content. Omit to simulate the file being unreadable. */
  mountinfoText?: string;
  platform?: NodeJS.Platform;
  totalMemoryBytes?: () => number;
}

function probe(overrides: ProbeOverrides = {}): CpuQuotaProbe {
  const files: Record<string, string> = { ...overrides.files };
  if (overrides.mountinfoText !== undefined) {
    files["/proc/self/mountinfo"] = overrides.mountinfoText;
  }
  if (overrides.cgroupText !== undefined) {
    files["/proc/self/cgroup"] = overrides.cgroupText;
  }
  const cgroupMounted = overrides.cgroupMounted ?? false;
  return {
    availableParallelism: overrides.availableParallelism ?? (() => 4),
    cgroupMounted: () => cgroupMounted,
    platform: overrides.platform ?? "linux",
    readFile: (filePath: string) => {
      const content = files[filePath];
      if (content === undefined) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return content;
    },
    totalMemoryBytes: overrides.totalMemoryBytes ?? (() => 8 * 1024 * 1024 * 1024),
  };
}

/** A single-line cgroup2-only mountinfo fixture, mounted at `mountPoint`. */
function v2Mountinfo(mountPoint: string): string {
  return `36 28 0:30 / ${mountPoint} rw,nosuid,nodev,noexec,relatime shared:8 - cgroup2 cgroup2 rw\n`;
}

/** A two-line mountinfo fixture with separate v1 cpu and memory controller mounts. */
function v1Mountinfo(cpuMountPoint: string, memoryMountPoint: string): string {
  return [
    `40 28 0:31 / ${cpuMountPoint} rw,nosuid,nodev,noexec,relatime shared:9 - cgroup cgroup rw,cpu,cpuacct`,
    `41 28 0:32 / ${memoryMountPoint} rw,nosuid,nodev,noexec,relatime shared:10 - cgroup cgroup rw,memory`,
    "",
  ].join("\n");
}

function v2CgroupText(relativePath: string): string {
  return `0::${relativePath}\n`;
}

function v1CgroupText(relativePath: string): string {
  return [`5:cpu,cpuacct:${relativePath}`, `6:memory:${relativePath}`, ""].join("\n");
}

// ─── cgroup v2: leaf resolution and ancestor walk ──────────────────────────

test("cgroup v2 quota is read from the process's ACTUAL leaf cgroup, not the mount root", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/user.slice/app.slice/scope"),
    files: {
      [path.join("/sys/fs/cgroup/user.slice/app.slice/scope", "cpu.max")]: "50000 100000\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.5 });
});

test("cgroup v2 quota set at a NON-LEAF ancestor is found by walking up when the leaf has no cpu.max at all", () => {
  // Reproduces this exact sandbox's real shape: /proc/self/cgroup's leaf
  // (a systemd scope) has no cpu.max because the cpu controller was never
  // delegated that deep — cgroup.controllers at the leaf lists only
  // "memory pids" (verified directly on this host); the real quota lives
  // at app.slice, one level up. A reader that only checks the leaf (or
  // the mount root) misses this entirely.
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/user.slice/app.slice/scope"),
    files: {
      // Root and leaf both explicitly absent (no entry in `files` = ENOENT
      // from the probe's readFile). Only the middle ancestor has the file.
      [path.join("/sys/fs/cgroup/user.slice/app.slice", "cpu.max")]: "50000 100000\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.5 });
});

test("cgroup v2: root is unlimited but the nested process cgroup is CPU-quota-limited", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/kubepods/pod-abc/container-def"),
    files: {
      "/sys/fs/cgroup/cpu.max": "max 100000\n",
      [path.join("/sys/fs/cgroup/kubepods/pod-abc/container-def", "cpu.max")]: "150000 100000\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  // Must resolve to the NESTED 1.5-core limit, not the root's "unlimited".
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 1.5 });
});

test("cgroup v2: root is unlimited but the nested process cgroup is MEMORY-quota-limited", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/kubepods/pod-abc/container-def"),
    files: {
      "/sys/fs/cgroup/memory.max": "max\n",
      [path.join("/sys/fs/cgroup/kubepods/pod-abc/container-def", "memory.max")]: "536870912\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupMemoryQuota(p), { state: "known", value: 536_870_912 });
});

test("cgroup v2: tightest ancestor wins when nearest also happens to be tightest (monotonically tightening chain)", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/a/b/c"),
    files: {
      [path.join("/sys/fs/cgroup/a", "cpu.max")]: "400000 100000\n",
      [path.join("/sys/fs/cgroup/a/b", "cpu.max")]: "200000 100000\n",
      [path.join("/sys/fs/cgroup/a/b/c", "cpu.max")]: "100000 100000\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 1 });
});

test("cgroup v2 CPU: tighter PARENT wins over a looser CHILD (the confirmed defect this fix closes)", () => {
  // Reproduces the red-team's live-kernel-verified counterexample: a
  // systemd slice with a tight quota running a scope whose own file
  // declares a looser value. The kernel enforces the tighter ancestor
  // regardless of which level's file is nearest -- reading only the
  // nearest file (the pre-fix behavior) returned the looser child value
  // here (4 cores) instead of the true effective quota (0.1 cores).
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/parent/child"),
    files: {
      [path.join("/sys/fs/cgroup/parent", "cpu.max")]: "10000 100000\n",
      [path.join("/sys/fs/cgroup/parent/child", "cpu.max")]: "400000 100000\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.1 });
});

test("cgroup v2 memory: tighter PARENT wins over a looser CHILD", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/parent/child"),
    files: {
      [path.join("/sys/fs/cgroup/parent", "memory.max")]: "134217728\n", // 128MiB
      [path.join("/sys/fs/cgroup/parent/child", "memory.max")]: "8589934592\n", // 8GiB
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupMemoryQuota(p), { state: "known", value: 134_217_728 });
});

test("cgroup v2 CPU: unlimited child does not mask a tighter parent", () => {
  // "unlimited" at one level asserts "no additional constraint HERE," not
  // "ignore the rest of the chain" -- the tighter parent still binds.
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/parent/child"),
    files: {
      [path.join("/sys/fs/cgroup/parent", "cpu.max")]: "50000 100000\n",
      [path.join("/sys/fs/cgroup/parent/child", "cpu.max")]: "max 100000\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.5 });
});

test("cgroup v2 CPU: tighter child wins over a looser parent (the direction the pre-fix code already handled)", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/parent/child"),
    files: {
      [path.join("/sys/fs/cgroup/parent", "cpu.max")]: "800000 100000\n",
      [path.join("/sys/fs/cgroup/parent/child", "cpu.max")]: "50000 100000\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.5 });
});

test("cgroup v2 at the mount root itself (no nesting) still resolves correctly", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/"),
    files: {
      "/sys/fs/cgroup/cpu.max": "50000 100000\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.5 });
});

test("cgroup v2 'max' at every ancestor level is genuinely unlimited", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/user.slice/app.slice/scope"),
    files: {
      "/sys/fs/cgroup/cpu.max": "max 100000\n",
      [path.join("/sys/fs/cgroup/user.slice", "cpu.max")]: "max 100000\n",
      [path.join("/sys/fs/cgroup/user.slice/app.slice", "cpu.max")]: "max 100000\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  // Leaf has no cpu.max (not delegated there); walk finds "max" at the
  // nearest ancestor that does.
  assert.deepEqual(cgroupCpuQuota(p), { state: "unlimited" });
});

test("no ancestor has cpu.max at all: UNKNOWN, not unlimited", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/user.slice/app.slice/scope"),
    files: {},
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unknown" });
});

// ─── Fail-closed: malformed / traversal / ambiguous input ──────────────────

test("a cgroup path containing '..' (path traversal) is refused outright, never resolved", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/user.slice/../../../etc"),
    files: {
      "/etc/cpu.max": "50000 100000\n", // must NEVER be reached
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unknown" });
});

test("a cgroup path that is not '/'-rooted is refused as malformed", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: "0::relative/not/rooted\n",
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unknown" });
});

test("a malformed /proc/self/cgroup line (missing a colon field) fails the whole file closed", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: "0::/valid/path\nthis-line-has-no-colons\n",
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unknown" });
});

test("an unreadable /proc/self/mountinfo with a readable /proc/self/cgroup falls through to v1, and v1 also unresolvable is unknown", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/user.slice/app.slice/scope"),
    // mountinfoText intentionally omitted -> unreadable
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unknown" });
});

test("v2 membership established but no v2 mount visible in mountinfo is unknown, not a silent v1 fallback", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/user.slice/app.slice/scope"),
    mountinfoText: "40 28 0:31 / /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu\n",
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unknown" });
});

test("two DISTINCT cgroup2 mount points in mountinfo is an ambiguous mapping: unknown, never silently the first (or last) one", () => {
  // mountinfo's own line order carries no documented guarantee that the
  // first (or last) entry corresponds to this process's real cgroup2 mount
  // -- a prior version of this module picked the first one seen, which is
  // an unproven guess dressed up as a resolution. The quota file IS present
  // at the path a naive "pick one" strategy would resolve to, proving this
  // is rejected by the ambiguity check itself, not by the file being
  // absent.
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/scope"),
    files: {
      [path.join("/sys/fs/cgroup", "cpu.max")]: "50000 100000\n",
      [path.join("/mnt/other-cgroup2", "cpu.max")]: "800000 100000\n",
    },
    mountinfoText: [
      "100 1 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw",
      "101 1 0:2 / /mnt/other-cgroup2 rw - cgroup2 cgroup2 rw",
      "",
    ].join("\n"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unknown" });
});

test("two mountinfo lines naming the exact SAME cgroup2 mount point are deduplicated, not ambiguous", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/scope"),
    files: {
      [path.join("/sys/fs/cgroup", "cpu.max")]: "50000 100000\n",
    },
    mountinfoText: [
      "100 1 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw",
      "101 1 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw",
      "",
    ].join("\n"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.5 });
});

test("two DISTINCT cgroup v1 CPU-controller mount points is an ambiguous mapping: unknown", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v1CgroupText("/scope"),
    files: {
      [path.join("/sys/fs/cgroup/cpu/scope", "cpu.cfs_period_us")]: "100000\n",
      [path.join("/sys/fs/cgroup/cpu/scope", "cpu.cfs_quota_us")]: "50000\n",
      [path.join("/mnt/other-cpu/scope", "cpu.cfs_period_us")]: "100000\n",
      [path.join("/mnt/other-cpu/scope", "cpu.cfs_quota_us")]: "800000\n",
    },
    mountinfoText: [
      "40 28 0:31 / /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct",
      "42 28 0:33 / /mnt/other-cpu rw - cgroup cgroup rw,cpu,cpuacct",
      "41 28 0:32 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory",
      "",
    ].join("\n"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unknown" });
});

test("two mountinfo lines naming the exact SAME cgroup v1 controller mount point are deduplicated, not ambiguous", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v1CgroupText("/scope"),
    files: {
      [path.join("/sys/fs/cgroup/memory/scope", "memory.limit_in_bytes")]: "268435456\n",
    },
    mountinfoText: [
      "41 28 0:32 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory",
      "43 28 0:32 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory",
      "",
    ].join("\n"),
  });
  assert.deepEqual(cgroupMemoryQuota(p), { state: "known", value: 268_435_456 });
});

test("an unparseable mountinfo line (too few fields) is skipped, not fatal, if another line resolves the mount", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/scope"),
    files: {
      [path.join("/sys/fs/cgroup", "cpu.max")]: "50000 100000\n",
    },
    mountinfoText: `garbage line with too few fields\n${v2Mountinfo("/sys/fs/cgroup")}`,
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.5 });
});

test("a mountinfo line missing the '-' separator is skipped, not fatal", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/scope"),
    files: {
      [path.join("/sys/fs/cgroup", "cpu.max")]: "50000 100000\n",
    },
    mountinfoText: `1 2 0:1 / /nowhere rw,relatime shared:1 cgroup2 cgroup2 rw\n${v2Mountinfo("/sys/fs/cgroup")}`,
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.5 });
});

test("a cgroup2 mount whose root field is not '/' (a bind-mounted subtree) is rejected, never silently joined", () => {
  // proc(5) field 4 ("root") names the subtree of the underlying
  // filesystem a mount exposes, distinct from field 5 ("mount point"). An
  // ordinary top-level cgroup2 mount has root "/" (every fixture in this
  // file uses that); a bind-mounted SUBTREE (root != "/") means
  // /proc/self/cgroup's hierarchy-root-relative path is not directly
  // joinable against the mount point without double-counting the
  // bind-mounted prefix -- this mount must be treated as unusable, not
  // silently trusted.
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/scope"),
    files: {
      // Present at the path a naive join WOULD produce, proving this is
      // rejected by the root-field check itself, not by the file merely
      // being absent.
      [path.join("/sys/fs/cgroup", "cpu.max")]: "50000 100000\n",
    },
    mountinfoText: "36 28 0:30 /some/bind-mounted/subtree /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n",
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unknown" });
});

// ─── cgroup v1 ──────────────────────────────────────────────────────────────

test("cgroup v1 quota is read from the process's actual leaf, walking up when needed", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v1CgroupText("/docker/container-id"),
    files: {
      [path.join("/sys/fs/cgroup/cpu/docker/container-id", "cpu.cfs_period_us")]: "100000\n",
      [path.join("/sys/fs/cgroup/cpu/docker/container-id", "cpu.cfs_quota_us")]: "200000\n",
    },
    mountinfoText: v1Mountinfo("/sys/fs/cgroup/cpu", "/sys/fs/cgroup/memory"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 2 });
});

test("cgroup v1: root is unlimited (-1) but the nested process cgroup is CPU-quota-limited", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v1CgroupText("/kubepods/pod-abc"),
    files: {
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n",
      [path.join("/sys/fs/cgroup/cpu/kubepods/pod-abc", "cpu.cfs_period_us")]: "100000\n",
      [path.join("/sys/fs/cgroup/cpu/kubepods/pod-abc", "cpu.cfs_quota_us")]: "50000\n",
    },
    mountinfoText: v1Mountinfo("/sys/fs/cgroup/cpu", "/sys/fs/cgroup/memory"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.5 });
});

test("cgroup v1: root is unlimited but the nested process cgroup is MEMORY-quota-limited", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v1CgroupText("/kubepods/pod-abc"),
    files: {
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
      [path.join("/sys/fs/cgroup/memory/kubepods/pod-abc", "memory.limit_in_bytes")]: "268435456\n",
    },
    mountinfoText: v1Mountinfo("/sys/fs/cgroup/cpu", "/sys/fs/cgroup/memory"),
  });
  assert.deepEqual(cgroupMemoryQuota(p), { state: "known", value: 268_435_456 });
});

test("cgroup v1 quota+period must come from the SAME ancestor level, not mixed across levels", () => {
  // If the leaf has cfs_quota_us but not cfs_period_us (or vice versa), the
  // pair reader must not pair a leaf value with an ancestor's — it should
  // treat that level as absent and continue walking up to a level with
  // BOTH files.
  const p = probe({
    cgroupMounted: true,
    cgroupText: v1CgroupText("/a/b"),
    files: {
      // Leaf has only quota, not period -- must not be used.
      [path.join("/sys/fs/cgroup/cpu/a/b", "cpu.cfs_quota_us")]: "999999\n",
      [path.join("/sys/fs/cgroup/cpu/a", "cpu.cfs_period_us")]: "100000\n",
      [path.join("/sys/fs/cgroup/cpu/a", "cpu.cfs_quota_us")]: "300000\n",
    },
    mountinfoText: v1Mountinfo("/sys/fs/cgroup/cpu", "/sys/fs/cgroup/memory"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 3 });
});

test("cgroup v1 CPU: tighter PARENT wins over a looser CHILD, aggregated across the whole paired-file chain", () => {
  // v1 analog of the v2 CPU counterexample above. The pair-reader must
  // aggregate the QUOTA/PERIOD RATIO computed per ancestor (not raw quota
  // values from different levels, and not just the nearest pair) and take
  // the minimum ratio.
  const p = probe({
    cgroupMounted: true,
    cgroupText: v1CgroupText("/parent/child"),
    files: {
      [path.join("/sys/fs/cgroup/cpu/parent", "cpu.cfs_period_us")]: "100000\n",
      [path.join("/sys/fs/cgroup/cpu/parent", "cpu.cfs_quota_us")]: "10000\n", // 0.1 core
      [path.join("/sys/fs/cgroup/cpu/parent/child", "cpu.cfs_period_us")]: "100000\n",
      [path.join("/sys/fs/cgroup/cpu/parent/child", "cpu.cfs_quota_us")]: "400000\n", // 4.0 cores
    },
    mountinfoText: v1Mountinfo("/sys/fs/cgroup/cpu", "/sys/fs/cgroup/memory"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.1 });
});

test("cgroup v1 CPU: unlimited (-1) child does not mask a tighter parent", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v1CgroupText("/parent/child"),
    files: {
      [path.join("/sys/fs/cgroup/cpu/parent", "cpu.cfs_period_us")]: "100000\n",
      [path.join("/sys/fs/cgroup/cpu/parent", "cpu.cfs_quota_us")]: "50000\n",
      [path.join("/sys/fs/cgroup/cpu/parent/child", "cpu.cfs_period_us")]: "100000\n",
      [path.join("/sys/fs/cgroup/cpu/parent/child", "cpu.cfs_quota_us")]: "-1\n",
    },
    mountinfoText: v1Mountinfo("/sys/fs/cgroup/cpu", "/sys/fs/cgroup/memory"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.5 });
});

test("cgroup v1 memory: tighter PARENT wins over a looser CHILD", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v1CgroupText("/parent/child"),
    files: {
      [path.join("/sys/fs/cgroup/memory/parent", "memory.limit_in_bytes")]: "134217728\n", // 128MiB
      [path.join("/sys/fs/cgroup/memory/parent/child", "memory.limit_in_bytes")]: "8589934592\n", // 8GiB
    },
    mountinfoText: v1Mountinfo("/sys/fs/cgroup/cpu", "/sys/fs/cgroup/memory"),
  });
  assert.deepEqual(cgroupMemoryQuota(p), { state: "known", value: 134_217_728 });
});

test("a malformed reading at ANY ancestor level makes the whole aggregate UNKNOWN, not silently skipped", () => {
  // A garbage value at one level of the chain means this module cannot
  // prove what the true effective quota is -- ignoring that level and
  // trusting only the readable ones would be exactly the "guess instead of
  // fail closed" mistake this module exists to avoid.
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/parent/child"),
    files: {
      [path.join("/sys/fs/cgroup/parent", "cpu.max")]: "not-a-number 100000\n",
      [path.join("/sys/fs/cgroup/parent/child", "cpu.max")]: "50000 100000\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unknown" });
});

test("cgroup v1 memory sentinel is the kernel's actual LONG_MAX page-aligned value, not an approximate power of two", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v1CgroupText("/scope"),
    files: {
      [path.join("/sys/fs/cgroup/memory/scope", "memory.limit_in_bytes")]: "9223372036854771712\n",
    },
    mountinfoText: v1Mountinfo("/sys/fs/cgroup/cpu", "/sys/fs/cgroup/memory"),
  });
  assert.deepEqual(cgroupMemoryQuota(p), { state: "unlimited" });
});

// ─── effectiveCpuCount / effectiveMemoryBudgetBytes ────────────────────────

test("effectiveCpuCount floors a fractional nested quota but never returns zero", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/scope"),
    files: { [path.join("/sys/fs/cgroup/scope", "cpu.max")]: "50000 100000\n" },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.equal(effectiveCpuCount(p), 1);
});

test("effectiveCpuCount falls back to availableParallelism only when genuinely unlimited end-to-end", () => {
  const p = probe({
    availableParallelism: () => 24,
    cgroupMounted: false,
  });
  assert.equal(effectiveCpuCount(p), 24);
});

test("effectiveCpuCount stays at the safe floor of 1 when nested resolution is UNKNOWN, never falls through to host core count", () => {
  const p = probe({
    availableParallelism: () => 24,
    cgroupMounted: true,
    cgroupText: v2CgroupText("/user.slice/app.slice/scope"),
    files: {},
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.equal(effectiveCpuCount(p), 1);
});

test("effectiveMemoryBudgetBytes resolves the real nested quota, not the (looser) mount-root reading", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/kubepods/pod-abc"),
    files: {
      "/sys/fs/cgroup/memory.max": "max\n",
      [path.join("/sys/fs/cgroup/kubepods/pod-abc", "memory.max")]: "536870912\n",
    },
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
  });
  assert.equal(effectiveMemoryBudgetBytes(p), 536_870_912);
});

test("effectiveMemoryBudgetBytes falls back to a conservative fixed budget (not host total memory) when UNKNOWN", () => {
  const p = probe({
    cgroupMounted: true,
    cgroupText: v2CgroupText("/user.slice/app.slice/scope"),
    files: {},
    mountinfoText: v2Mountinfo("/sys/fs/cgroup"),
    totalMemoryBytes: () => 128 * 1024 * 1024 * 1024,
  });
  const budget = effectiveMemoryBudgetBytes(p);
  assert.ok(budget < 128 * 1024 * 1024 * 1024, "must not fall through to the 128GiB host total");
  assert.equal(budget, 512 * 1024 * 1024);
});

test("effectiveMemoryBudgetBytes falls back to host total memory only when genuinely unlimited", () => {
  const p = probe({
    cgroupMounted: false,
    totalMemoryBytes: () => 8 * 1024 * 1024 * 1024,
  });
  assert.equal(effectiveMemoryBudgetBytes(p), 8 * 1024 * 1024 * 1024);
});

// ─── Non-Linux / no-cgroup platforms ───────────────────────────────────────

test("non-linux platform never reads /proc at all and is always unlimited", () => {
  const p = probe({
    platform: "darwin",
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unlimited" });
});

test("this process's REAL /proc/self/cgroup and /proc/self/mountinfo resolve without throwing", () => {
  // Smoke test against the actual host filesystem (no probe override) --
  // exercises the real REAL_PROBE end to end, proving the module doesn't
  // crash on this sandbox's own genuinely nested cgroup shape
  // (/user.slice/.../*.scope, five levels deep, verified manually during
  // this fix's development).
  const cpu = cgroupCpuQuota();
  const memory = cgroupMemoryQuota();
  assert.ok(["known", "unlimited", "unknown"].includes(cpu.state));
  assert.ok(["known", "unlimited", "unknown"].includes(memory.state));
  assert.ok(effectiveCpuCount() >= 1);
  assert.ok(effectiveMemoryBudgetBytes() > 0);
});
