// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Public surface of `@pdpp/connector-protocol`.
 *
 * This is the connector AUTHORING CONTRACT: the JSONL wire-protocol message
 * types, the bootstrap guard, and the emit/scope-filter primitives a
 * connector's own `index.ts` imports directly. It is the bottom of the
 * dependency graph — depends on nothing in `@pdpp/collector-runtime` or
 * `@pdpp/polyfill-connectors` — so connector authors do not have to depend
 * on the runtime package (and its release cadence) just to get the files
 * they author against. `@pdpp/collector-runtime` depends on this package;
 * this package depends on neither of the other two.
 *
 * Carved out of `@pdpp/collector-runtime` in the same engine-split effort
 * that carved that package out of `@pdpp/polyfill-connectors`: this barrel
 * re-exports the modules that:
 *
 *   - speak the message-type shapes (connector-runtime-protocol.ts);
 *   - implement the JSONL protocol primitives (safe-emit.ts,
 *     scope-filters.ts, is-main-module.ts).
 *
 * `collector-definition.ts`, `auth.ts`, `http-retry.ts`, `pdpp-safe-text.ts`,
 * and `safe-text-preview.ts` are exported only as subpaths (see this
 * package's package.json `exports`), matching how they were exported before
 * this move — none of them were part of the old collector-runtime barrel
 * either.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §2.
 */

export type {
  AssistanceAttachment,
  AssistanceAttachmentKind,
  AssistanceCompletion,
  AssistanceCompletionStatus,
  AssistanceOwnerAction,
  AssistanceProgressPosture,
  AssistanceRequest,
  AssistanceResponseContract,
  AssistanceSensitivity,
  DetailCoverageMessage,
  DetailGapMessage,
  DetailGapRecoveredMessage,
  DetailGapStartEntry,
  EmittedMessage,
  InteractionKind,
  InteractionRequest,
  InteractionResponse,
  RecordData,
  StartMessage,
  StreamScope,
  ValidateRecord,
} from "./connector-runtime-protocol.ts";
export { isMainModule } from "./is-main-module.ts";
export {
  emitToStdout,
  parseJsonlLine,
  stringifyForJsonl,
} from "./safe-emit.ts";
export {
  type EmitGate,
  type EmitGateRecord,
  type EmitTombstonesArgs,
  emitTombstones,
  type MakeEmitGateOptions,
  makeEmitGate,
  passesResourceFilter,
  passesTimeRange,
  type RequireCredentialsOrAskArgs,
  requireCredentialsOrAsk,
  resourceSet,
  type StreamRequest,
  type TimeRange,
} from "./scope-filters.ts";
