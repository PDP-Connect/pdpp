#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Run the client-conformance cases against Vana Context Gateway.
//
// Wiring, in the only order that works:
//
//   1. Start the instrumented AS+RS fixture (the suite's ClientFixture).
//   2. Provision a real Context Gateway whose PDPP connection binding has
//      `resource` = the fixture's URL, so CG's unmodified outbound read path
//      makes its Section 8 requests to the fixture.
//   3. Build a ClientUnderTest over CG's public routes and run CLIENT_CASES.
//
// Step 2 must follow step 1 because CG stores the resource identifier when
// the grant is persisted, not when it reads: the fixture's port has to exist
// before the row is written.
//
// The Context Gateway half lives in the Context Gateway repo
// (`scripts/provision-client-target.mjs`) and is invoked as a subprocess.
// Nothing about CG is vendored here, and this script never edits CG.
//
// Usage:
//   node --import tsx scripts/vana-client-target.mjs \
//     --cg-repo ~/.tmp/cg-client-adapter-0919 [--json report.json]

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startClientFixture } from "../src/harness/client-adapter.ts";
import { makeContext, runCases } from "../src/harness/runner.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import {
  createVanaContextGatewayClientUnderTest,
  readVanaClientTargetDescriptor,
} from "../src/targets/vana-client-adapter.ts";
import { CLIENT_CASES } from "../src/tests/client.ts";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function log(message) {
  process.stderr.write(`[vana-client] ${message}\n`);
}

async function main() {
  const cgRepo = arg("cg-repo");
  if (!cgRepo) {
    throw new Error("--cg-repo <path to the Context Gateway worktree> is required");
  }
  const jsonOut = arg("json");

  // 1. The fixture, first, so its URL can be baked into CG's binding.
  const fixture = await startClientFixture();
  log(`fixture listening on ${fixture.url}`);

  // 2. Context Gateway, pointed at it.
  const stateDir = await mkdtemp(join(tmpdir(), "vana-client-target-"));
  const stateFile = join(stateDir, "descriptor.json");
  const provision = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(cgRepo, "scripts/provision-client-target.mjs"),
      "--resource",
      fixture.url,
      "--state-file",
      stateFile,
    ],
    { cwd: cgRepo, detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  provision.stdout.on("data", (chunk) => process.stderr.write(`[provision:out] ${chunk}`));
  provision.stderr.on("data", (chunk) => process.stderr.write(`[provision] ${chunk}`));

  const descriptor = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for the Context Gateway descriptor")), 600_000);
    provision.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`provisioning exited early with code ${code}`));
    });
    const poll = setInterval(() => {
      readVanaClientTargetDescriptor(stateFile).then(
        (value) => {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(value);
        },
        () => {
          /* not written yet */
        }
      );
    }, 1000);
  });
  log(`Context Gateway on ${descriptor.cgOrigin} (connection ${descriptor.connectionId})`);

  // 3. Run the cases.
  //
  // CLIENT_CASES hardcode the fixture's stream name, and the provisioning
  // script seeds CG's grant for that same name, so the two halves agree on
  // which stream is under test without either side guessing.
  let results;
  try {
    const client = createVanaContextGatewayClientUnderTest(descriptor, fixture);
    const target = new ReferenceTargetAdapter();
    results = await runCases(CLIENT_CASES, { ...makeContext(target, []), client });
  } finally {
    try {
      process.kill(-provision.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    await fixture.close();
  }

  const tally = results.reduce((counts, result) => {
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    return counts;
  }, {});

  for (const result of results) {
    process.stderr.write(
      `${result.outcome.toUpperCase().padEnd(11)} ${result.caseId}${
        result.detail ? `\n            ${result.detail}` : ""
      }\n`
    );
  }
  log(JSON.stringify(tally));

  const report = { client: "vana-context-gateway", results, tally };
  if (jsonOut) {
    await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    log(`wrote ${jsonOut}`);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[vana-client] FAILED: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
