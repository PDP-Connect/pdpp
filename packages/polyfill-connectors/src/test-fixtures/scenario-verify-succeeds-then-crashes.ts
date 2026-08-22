// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only misbehaving stub connector for FIX 2(d)'s subprocess strictness
 * test: writes a normal succeeded DONE, then exits with a nonzero code —
 * modeling a connector that crashes (or is killed) right after reporting
 * success. Used by bin/scenario-verify-strict.test.ts to prove
 * scenario-verify.ts fails the run on subprocess nonzero exit EVEN WHEN
 * DONE said succeeded, rather than trusting the DONE message alone. Never
 * registered in src/orchestrator.ts.
 */

process.stdout.write(`${JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 })}\n`);
process.exit(7);
