// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type CpuQuotaProbe,
  cgroupCpuQuota,
  cgroupMemoryQuota,
  effectiveCpuCount,
  effectiveMemoryBudgetBytes,
} from "../server/cpu-quota.ts";

type ProbeOverrides = Omit<Partial<CpuQuotaProbe>, "cgroupMounted"> & {
  cgroupMounted?: boolean;
  files?: Record<string, string>;
};

function probe(overrides: ProbeOverrides = {}): CpuQuotaProbe {
  const files = overrides.files ?? {};
  const cgroupMounted = overrides.cgroupMounted ?? false;
  return {
    availableParallelism: overrides.availableParallelism ?? (() => 4),
    cgroupMounted: () => cgroupMounted,
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
    totalMemoryBytes: overrides.totalMemoryBytes ?? (() => 8 * 1024 * 1024 * 1024),
  };
}

test("cgroup v2 CPU quota below one core is read as a fraction", () => {
  const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "50000 100000\n" } });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 0.5 });
});

test("cgroup v2 CPU quota above one core is read exactly", () => {
  const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "400000 100000\n" } });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 4 });
});

test("cgroup v2 'max' CPU quota is explicitly unlimited", () => {
  const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "max 100000\n" } });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unlimited" });
});

test("cgroup v1 CPU quota is used when v2 is absent", () => {
  const p = probe({
    files: {
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000\n",
    },
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "known", value: 2 });
});

test("cgroup v1 CPU quota of -1 is explicitly unlimited (v1's own sentinel)", () => {
  const p = probe({
    files: {
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n",
    },
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unlimited" });
});

test("cgroup mounted but no CPU quota file readable is UNKNOWN, not unlimited (Fly/Firecracker guest-visibility case)", () => {
  // This is the exact ambiguity a red-team review flagged: Fly.io enforces
  // shared-vCPU quotas host-side on a Firecracker microVM, and it is
  // unconfirmed whether that quota is exposed inside the guest's own
  // cgroup filesystem. If the guest's cgroup is mounted (proof of
  // containerization) but the quota file itself is absent/unreadable, the
  // safe assumption is "a limit may exist and isn't visible", not "no
  // limit exists" — the latter would silently oversubscribe.
  const p = probe({ cgroupMounted: true });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unknown" });
});

test("no cgroup mounted at all is genuinely unlimited (bare metal / uncontainerized Linux)", () => {
  const p = probe({ cgroupMounted: false });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unlimited" });
});

test("non-linux platform is always unlimited (no cgroups exist there)", () => {
  const p = probe({
    platform: "darwin",
    readFile: () => {
      throw new Error("should not be called on non-linux");
    },
  });
  assert.deepEqual(cgroupCpuQuota(p), { state: "unlimited" });
});

test("effectiveCpuCount floors a fractional quota but never returns zero", () => {
  const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "50000 100000\n" } });
  assert.equal(effectiveCpuCount(p), 1);
});

test("effectiveCpuCount floors a multi-core quota", () => {
  const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "350000 100000\n" } });
  assert.equal(effectiveCpuCount(p), 3);
});

test("effectiveCpuCount falls back to availableParallelism only when genuinely unlimited", () => {
  const p = probe({ availableParallelism: () => 24, cgroupMounted: false });
  assert.equal(effectiveCpuCount(p), 24);
});

test("effectiveCpuCount treats a 1-vCPU cgroup identically to a --cpus=1 container regardless of host core count", () => {
  const p = probe({
    availableParallelism: () => 24,
    files: { "/sys/fs/cgroup/cpu.max": "100000 100000\n" },
  });
  assert.equal(effectiveCpuCount(p), 1);
});

test("effectiveCpuCount stays at the safe floor of 1 when the quota is UNKNOWN, never falls through to host core count", () => {
  // The regression this module's redesign specifically closes: previously
  // "no quota file readable" and "cgroup absent" were the same `null`
  // return and both fell through to os.availableParallelism() (24 on this
  // host) — unsafe if the true reason was an invisible Firecracker-guest
  // quota, not an actually-uncontainerized process.
  const p = probe({ availableParallelism: () => 24, cgroupMounted: true });
  assert.equal(effectiveCpuCount(p), 1);
});

test("cgroup v2 memory quota is read in bytes", () => {
  const p = probe({ files: { "/sys/fs/cgroup/memory.max": "536870912\n" } });
  assert.deepEqual(cgroupMemoryQuota(p), { state: "known", value: 536_870_912 });
});

test("cgroup v2 'max' memory quota is explicitly unlimited", () => {
  const p = probe({ files: { "/sys/fs/cgroup/memory.max": "max\n" } });
  assert.deepEqual(cgroupMemoryQuota(p), { state: "unlimited" });
});

test("cgroup v1 memory quota is read in bytes", () => {
  const p = probe({ files: { "/sys/fs/cgroup/memory/memory.limit_in_bytes": "268435456\n" } });
  assert.deepEqual(cgroupMemoryQuota(p), { state: "known", value: 268_435_456 });
});

test("cgroup v1 memory quota near the architecture's unset sentinel is treated as unlimited", () => {
  const p = probe({ files: { "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n" } });
  assert.deepEqual(cgroupMemoryQuota(p), { state: "unlimited" });
});

test("cgroup mounted but no memory quota file readable is UNKNOWN, not unlimited", () => {
  const p = probe({ cgroupMounted: true });
  assert.deepEqual(cgroupMemoryQuota(p), { state: "unknown" });
});

test("effectiveMemoryBudgetBytes returns the known quota directly", () => {
  const p = probe({ files: { "/sys/fs/cgroup/memory.max": "536870912\n" } });
  assert.equal(effectiveMemoryBudgetBytes(p), 536_870_912);
});

test("effectiveMemoryBudgetBytes falls back to a conservative fixed budget (not host total memory) when UNKNOWN", () => {
  const p = probe({ cgroupMounted: true, totalMemoryBytes: () => 128 * 1024 * 1024 * 1024 });
  const budget = effectiveMemoryBudgetBytes(p);
  assert.ok(budget < 128 * 1024 * 1024 * 1024, "must not fall through to the 128GiB host total");
  assert.equal(budget, 512 * 1024 * 1024);
});

test("effectiveMemoryBudgetBytes falls back to host total memory only when genuinely unlimited", () => {
  const p = probe({ cgroupMounted: false, totalMemoryBytes: () => 8 * 1024 * 1024 * 1024 });
  assert.equal(effectiveMemoryBudgetBytes(p), 8 * 1024 * 1024 * 1024);
});
