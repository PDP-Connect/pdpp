// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `@pdpp/connector-protocol` ships as a vendored tarball (vendor/pdpp-connector-
// protocol-0.0.1.tgz) — its `ProgressExtra` interface (defined in the
// `./connector-runtime-protocol` subpath export, re-exported by
// `src/connector-runtime.ts`) is closed with no index signature. This
// augments it (structural interface merging, not a copy) so a connector can
// emit an optional `phase_boundary` marker on a PROGRESS message without
// waiting on a protocol package bump. The vendored package's compiled JS
// already forwards unknown PROGRESS fields untouched end-to-end (validated:
// reference-implementation/runtime/index.ts's validateProgressMessage only
// checks known fields when present, never rejects extras) — this file changes
// nothing at runtime, only what TypeScript allows callers to pass and readers
// to read.
import "@pdpp/connector-protocol/connector-runtime-protocol";

declare module "@pdpp/connector-protocol/connector-runtime-protocol" {
  interface ProgressExtra {
    /**
     * Declares a connector-defined phase transition with no external-provider
     * dependency (no rate limit, no network I/O to a third party) starting
     * now. `run-executor.ts`'s attempt watchdog uses this to stop applying
     * `maxRunWallClockMs` — a budget sized for provider-rate-limited walks —
     * once the run has moved into locally-bound work like a database read.
     */
    phase_boundary?: "local_only_phase_started";
  }
}
