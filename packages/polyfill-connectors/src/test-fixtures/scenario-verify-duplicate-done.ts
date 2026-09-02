// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only misbehaving stub connector for FIX 2(c)'s subprocess strictness
 * test: writes TWO DONE messages. Used by bin/scenario-verify-strict.test.ts
 * to prove scenario-verify.ts fails a run on more than one DONE, rather than
 * silently accepting the second one (or ignoring it). Never registered in
 * src/orchestrator.ts.
 */

process.stdout.write(`${JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 })}\n`);
process.stdout.write(`${JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 })}\n`);
process.exit(0);
