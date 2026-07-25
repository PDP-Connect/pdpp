// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  addNodeProbeToEnvironment,
  assertArtifactReceipt,
  bindNodeEnvironment,
  createNodeProbe,
  gitHeadSha,
  labelChildEnvironment,
  NODE_22_14_VERSION,
  packageContentSha256,
} from "./artifact-receipt.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

assert.equal(
  process.version,
  NODE_22_14_VERSION,
  `This gate requires the pinned Node ${NODE_22_14_VERSION} runtime; received ${process.version}.`
);

// This explicit gate is intentionally separate from ordinary `verify`: a
// developer's normal package verification stays offline and uses their local
// runtime, while the release-floor receipt cannot drift to a newer Node 22.
const tempRoot = mkdtempSync(resolve(tmpdir(), "pdpp-cli-node-22-14-gate-"));
const probe = createNodeProbe(tempRoot);
const sourceEnv = bindNodeEnvironment(process.env, process.execPath);
const env = addNodeProbeToEnvironment(sourceEnv, probe);
const headSha = gitHeadSha(packageRoot);
const contentSha256 = packageContentSha256(packageRoot);

try {
  execFileSync("pnpm", ["build"], {
    cwd: packageRoot,
    env: labelChildEnvironment(env, "pnpm build"),
    stdio: "inherit",
  });
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", resolve(packageRoot, "scripts/pack-install-run.ts")],
    {
      cwd: packageRoot,
      env: labelChildEnvironment(
        {
          ...env,
          PDPP_ARTIFACT_EXPECTED_NODE_VERSION: NODE_22_14_VERSION,
          PDPP_ARTIFACT_EXPECTED_NODE_EXEC_PATH: process.execPath,
          PDPP_ARTIFACT_EXPECTED_GIT_HEAD_SHA: headSha,
          PDPP_ARTIFACT_EXPECTED_CONTENT_SHA256: contentSha256,
        },
        "pack-install-run"
      ),
      encoding: "utf8" as const,
      maxBuffer: 1024 * 1024,
    }
  );
  process.stdout.write(output);

  const receiptLine = output.split("\n").find((line) => line.startsWith("ARTIFACT_RECEIPT "));
  assert.ok(receiptLine, "artifact gate did not emit a receipt");
  const receipt = JSON.parse(receiptLine.slice("ARTIFACT_RECEIPT ".length));
  assertArtifactReceipt(receipt, {
    nodeVersion: NODE_22_14_VERSION,
    nodeExecPath: process.execPath,
    gitHeadSha: headSha,
    packageContentSha256: contentSha256,
  });
  assert.ok(
    receipt.subprocesses.some(({ label }: { label: string }) => label === "pnpm build"),
    "receipt missed the build subprocess"
  );
  assert.ok(
    receipt.subprocesses.some(({ label }: { label: string }) => label.startsWith("npm ")),
    "receipt missed npm subprocesses"
  );
  assert.ok(
    receipt.subprocesses.some(({ label }: { label: string }) => label.startsWith("npx ")),
    "receipt missed npx subprocesses"
  );
  process.stdout.write(`Node ${NODE_22_14_VERSION} emitted artifact contract passed.\n`);
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}
