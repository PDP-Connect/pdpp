// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only misbehaving stub connector for FIX 2(b)'s subprocess strictness
 * test: writes one non-JSON line to stdout before a normal DONE. Used by
 * bin/scenario-verify-strict.test.ts to prove scenario-verify.ts's stdout
 * protocol accounting no longer silently discards a garbage line — it must
 * fail the run instead. Never registered in src/orchestrator.ts.
 */

process.stdout.write("this is not json\n");
process.stdout.write(`${JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 })}\n`);
process.exit(0);
