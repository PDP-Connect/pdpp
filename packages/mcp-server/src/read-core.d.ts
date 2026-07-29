// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `@pdpp/read-core` ships no declaration file (its own build sets
// `declaration: false`). This ambient module gives the two exports this
// package actually imports an honest `unknown`-in/`unknown`-out signature —
// narrower than the implicit `any` TS would otherwise infer for the whole
// module, and consistent with the `Json`-based typing used throughout
// tools.ts. Callers narrow the return value via `callBuildSharedRecordContentLadder`
// / `callSummarizeRecordEvidence` in tools.ts.
declare module "@pdpp/read-core" {
  export function buildRecordContentLadder(record: unknown, options?: Record<string, unknown>): unknown;
  export function summarizeRecordEvidence(body: unknown, label: unknown, options?: Record<string, unknown>): unknown;
}
