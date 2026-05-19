/**
 * Runner-side public surface for the local collector.
 *
 * This module is the no-Playwright entry into `@pdpp/polyfill-connectors`
 * that the publishable `@pdpp/local-collector` package re-exports. It
 * intentionally re-exports only the modules that:
 *
 *   - drive the collector loop (collector-runner.ts);
 *   - speak the device-exporter ingest contract (local-device-client.ts,
 *     local-device-envelope.ts, local-device-queue.ts);
 *   - advertise runtime capabilities (runtime-capabilities.ts);
 *   - implement the JSONL protocol primitives (safe-emit.ts,
 *     scope-filters.ts, is-main-module.ts) and the message-type shapes
 *     (connector-runtime-protocol.ts).
 *
 * Anything not exported here is OUT of the runner slice — most importantly
 * `connector-runtime.ts` (the in-process runtime entry that filesystem-class
 * connectors still import for `runConnector` / `CollectContext`) and
 * `browser-launch.ts` / `browser-handoff.ts` / `fixture-capture.ts`, which
 * touch Playwright.
 *
 * The publishable build is enforced by:
 *
 *   - `tsconfig.runner.json` — type-checks this slice in isolation;
 *   - the `@pdpp/local-collector` CI grep gate — proves the published
 *     artifact never names `playwright`, `patchright`, `imapflow`,
 *     `pdf-parse`, `better-sqlite3`, or `linkedom`.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §2.
 */

export { COLLECTOR_PROTOCOL_HEADER, COLLECTOR_PROTOCOL_VERSION } from "../collector-protocol.ts";
export {
  buildCollectorStartMessage,
  type CollectorChildContext,
  type CollectorConnectorSpec,
  type CollectorEnrollmentConfig,
  type CollectorRunConfig,
  type CollectorRunResult,
  CollectorStateReadError,
  drainCollectorQueue,
  enrollCollector,
  runCollectorConnector,
  transformRecordsToCollectorEnvelopes,
} from "../collector-runner.ts";
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
} from "../connector-runtime-protocol.ts";
export { isMainModule } from "../is-main-module.ts";
export {
  type EnrollmentExchangeRequest,
  type EnrollmentExchangeResponse,
  type GetSourceInstanceStateRequest,
  type HeartbeatRequest,
  type IngestBatchRequest,
  LOCAL_DEVICE_ENDPOINTS,
  LocalDeviceClient,
  type LocalDeviceClientOptions,
  LocalDeviceHttpError,
  type PutSourceInstanceStateRequest,
  type SourceInstanceStateResponse,
} from "../local-device-client.ts";
export {
  type BuildLocalDeviceRecordEnvelopeInput,
  buildLocalDeviceRecordEnvelope,
  canonicalJson,
  hashCanonicalJson,
  type LocalDeviceRecordEnvelope,
} from "../local-device-envelope.ts";
export {
  type BuildLocalDeviceOutboxIdInput,
  buildLocalDeviceOutboxId,
  LocalDeviceOutbox,
  type LocalDeviceOutboxClaimInput,
  type LocalDeviceOutboxDeadLetterInput,
  type LocalDeviceOutboxEnqueueInput,
  type LocalDeviceOutboxFailInput,
  type LocalDeviceOutboxItem,
  type LocalDeviceOutboxKind,
  type LocalDeviceOutboxLeaseInput,
  type LocalDeviceOutboxOptions,
  type LocalDeviceOutboxRenewInput,
  type LocalDeviceOutboxStatus,
  type LocalDeviceOutboxSummary,
} from "../local-device-outbox.ts";
export {
  LocalDeviceQueue,
  type LocalDeviceQueueItem,
  type LocalDeviceQueueOptions,
  type LocalDeviceQueueStatus,
} from "../local-device-queue.ts";
export {
  type ImportLegacyLocalDeviceQueueOptions,
  importLegacyLocalDeviceQueue,
  inspectLegacyLocalDeviceQueue,
  type LegacyLocalDeviceQueueImportResult,
  type LegacyLocalDeviceQueueInspection,
} from "../local-device-queue-migration.ts";
export {
  assertPlacementOrThrow,
  COLLECTOR_RUNTIME_CAPABILITIES,
  type ConnectorPlacementInput,
  type ConnectorRuntimeRequirements,
  diffRequiredBindings,
  evaluatePlacement,
  type PlacementDecision,
  PROVIDER_RUNTIME_CAPABILITIES,
  RUNTIME_CAPABILITY_MISMATCH_CODE,
  type RuntimeBindingName,
  RuntimeCapabilityMismatchError,
  type RuntimeCapabilityProfile,
} from "../runtime-capabilities.ts";
export { emitToStdout, parseJsonlLine, stringifyForJsonl } from "../safe-emit.ts";
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
} from "../scope-filters.ts";
