// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { type CpuQuotaProbe, cgroupCpuQuota, effectiveCpuCount } from "../server/cpu-quota.ts";

function probe(overrides: Partial<CpuQuotaProbe> & { files?: Record<string, string> } = {}): CpuQuotaProbe {
  const files = overrides.files ?? {};
  return {
    availableParallelism: overrides.availableParallelism ?? (() => 4),
    platform: overrides.platform ?? "linux",
    readFile:
      overrides.readFile ??
      ((path: string) => {
        const content = files[path];
        if (content === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return content;
      }),
  };
}

test("cgroup v2 quota below one CPU is read as a fraction", () => {
  const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "50000 100000\n" } });
  assert.equal(cgroupCpuQuota(p), 0.5);
});

test("cgroup v2 quota above one CPU is read exactly", () => {
  const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "400000 100000\n" } });
  assert.equal(cgroupCpuQuota(p), 4);
});

test("cgroup v2 'max' quota (no limit) falls through to null", () => {
  const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "max 100000\n" } });
  assert.equal(cgroupCpuQuota(p), null);
});

test("cgroup v1 is used when v2 is absent", () => {
  const p = probe({
    files: {
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000\n",
    },
  });
  assert.equal(cgroupCpuQuota(p), 2);
});

test("cgroup v1 quota of -1 (unset) falls through to null", () => {
  const p = probe({
    files: {
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n",
    },
  });
  assert.equal(cgroupCpuQuota(p), null);
});

test("no cgroup files present returns null", () => {
  const p = probe();
  assert.equal(cgroupCpuQuota(p), null);
});

test("non-linux platform never reads cgroup files", () => {
  const p = probe({
    platform: "darwin",
    readFile: () => {
      throw new Error("should not be called on non-linux");
    },
  });
  assert.equal(cgroupCpuQuota(p), null);
});

test("effectiveCpuCount floors a fractional quota but never returns zero", () => {
  const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "50000 100000\n" } });
  assert.equal(effectiveCpuCount(p), 1);
});

test("effectiveCpuCount floors a multi-core quota", () => {
  const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "350000 100000\n" } });
  assert.equal(effectiveCpuCount(p), 3);
});

test("effectiveCpuCount falls back to availableParallelism when no quota applies", () => {
  const p = probe({ availableParallelism: () => 24 });
  assert.equal(effectiveCpuCount(p), 24);
});

test("effectiveCpuCount treats a 1-vCPU cgroup identically to a --cpus=1 container regardless of host core count", () => {
  // Regression: the real bug this module fixes. A 24-core host under a
  // --cpus=1 container quota must size like 1 CPU, not 24 (which
  // os.availableParallelism() alone would report).
  const p = probe({
    availableParallelism: () => 24,
    files: { "/sys/fs/cgroup/cpu.max": "100000 100000\n" },
  });
  assert.equal(effectiveCpuCount(p), 1);
});
