// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only misbehaving-connector fixture for `bin/connector-dev.test.ts`.
 *
 * Emits a RECORD, then a DONE with `status: "succeeded"`, and THEN exits
 * with a nonzero exit code — proving `bin/connector-dev.ts`'s DONE-finality
 * check (see `runAndStream`'s `ProtocolViolationReason`) treats a nonzero
 * exit AFTER a succeeded DONE as a failure, not a success, even though the
 * DONE message itself claimed success.
 *
 * Deliberately NOT using `runConnector`/`connector-runtime.ts` (that runtime
 * always exits 0 on a successful collect()) — this fixture writes the JSONL
 * protocol directly to stdout and calls `process.exit(1)` itself, the same
 * shape `src/test-fixtures/protocol-subprocess-done-then-fail.ts` uses for
 * `src/test-harness.ts`'s equivalent check. This is a separate file (not a
 * reuse of that one) because that fixture belongs to another lane's owned
 * test (`src/test-harness.test.ts`).
 */

import { stringifyForJsonl } from "@pdpp/connector-protocol";

process.stdout.write(
  stringifyForJsonl({
    type: "RECORD",
    stream: "items",
    key: "item-1",
    data: { id: "item-1" },
    emitted_at: new Date().toISOString(),
  })
);
process.stdout.write(stringifyForJsonl({ type: "DONE", status: "succeeded", records_emitted: 1 }));
process.exit(1);
