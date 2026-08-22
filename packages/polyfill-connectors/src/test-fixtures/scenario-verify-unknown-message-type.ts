// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only misbehaving stub connector for repair wave 6 (P2-2 duty 1)'s
 * unknown-message-type rejection test: writes one well-formed JSON object
 * whose `type` is not one of `wire-registry.ts`'s `KNOWN_MESSAGE_TYPES`,
 * before a normal DONE. Used by bin/scenario-verify-strict.test.ts to prove
 * scenario-verify.ts's stdout protocol accumulator rejects an unrecognized
 * `type` even though the line IS valid JSON (distinct from FIX 2(b)'s
 * non-JSON-line test, which this fixture deliberately does NOT reproduce —
 * this line parses fine, only its `type` is bogus). Never registered in
 * src/orchestrator.ts.
 */

process.stdout.write(`${JSON.stringify({ type: "BOGUS_MESSAGE_TYPE", stream: "widgets" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 })}\n`);
process.exit(0);
