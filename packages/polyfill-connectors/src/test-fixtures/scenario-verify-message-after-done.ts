// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only misbehaving stub connector for FIX 2(c)'s subprocess strictness
 * test: writes a normal DONE, then writes ANOTHER protocol message after
 * it. Used by bin/scenario-verify-strict.test.ts to prove scenario-verify.ts
 * fails a run when anything follows DONE, rather than silently accepting
 * (or ignoring) the extra output. Never registered in src/orchestrator.ts.
 */

process.stdout.write(`${JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 })}\n`);
process.stdout.write(`${JSON.stringify({ type: "PROGRESS", message: "should never have been written" })}\n`);
process.exit(0);
