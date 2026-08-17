// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Public surface of `@pdpp/collector-runtime`.
 *
 * This package is the generic, connector-agnostic collector-execution
 * runtime, carved out of `@pdpp/polyfill-connectors` so the runtime no
 * longer lives inside the connector-content package. It carries no
 * connector definitions, manifests, or connector-specific content — see
 * `@pdpp/polyfill-connectors/collectors` (`collector-registry.ts`) for that.
 *
 * This barrel re-exports the modules that:
 *
 *   - drive the collector loop (collector-runner.ts);
 *   - speak the device-exporter ingest contract (local-device-client.ts,
 *     local-device-envelope.ts, local-device-queue.ts, local-device-outbox.ts);
 *   - advertise runtime capabilities (runtime-capabilities.ts).
 *
 * The connector-facing JSONL wire-protocol message types
 * (connector-runtime-protocol.ts), the bootstrap guard (is-main-module.ts),
 * and the emit/scope-filter primitives (safe-emit.ts, scope-filters.ts) moved
 * out to `@pdpp/connector-protocol` — the connector AUTHORING CONTRACT — so
 * connector authors do not have to depend on this runtime package (and its
 * release cadence) just to get the files they author against. This package
 * depends on `@pdpp/connector-protocol` (content→protocol←runtime is the
 * intended terminal shape); it no longer re-exports that package's surface
 * from this barrel — import `@pdpp/connector-protocol` directly for those
 * types.
 *
 * `static-secret-injection.ts` deliberately did NOT move here even though it
 * was previously re-exported from this slice's old home
 * (`polyfill-connectors/src/runner/index.ts`): it depends on a
 * manifest-derived, per-connector generated registry
 * (`generated/static-secret-registry.generated.ts`), so it is
 * content-adjacent, not generic runtime, and no consumer of this package
 * (`@pdpp/local-collector` included) actually imports it through this
 * barrel. It remains in `@pdpp/polyfill-connectors`.
 *
 * `connector-runtime.ts` (the in-process runtime entry that filesystem-class
 * connectors import for `runConnector` / `CollectContext`) and
 * `browser-launch.ts` / `browser-handoff.ts` / `fixture-capture.ts`, which
 * touch Playwright, also remain out of scope for this package.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §2.
 */

export {
  COLLECTOR_PROTOCOL_HEADER,
  COLLECTOR_PROTOCOL_VERSION,
} from "./collector-protocol.ts";
export {
  buildCollectorStartMessage,
  COLLECTION_SCOPE_STATE_KEY,
  COLLECTOR_COVERAGE_STATUSES,
  type CollectionScope,
  type CollectorChildContext,
  type CollectorCompletenessSummary,
  type CollectorConnectorSpec,
  type CollectorCoverageStatus,
  type CollectorEnrollmentConfig,
  type CollectorRunConfig,
  type CollectorRunResult,
  CollectorStateReadError,
  collectorScopeFingerprint,
  deriveLocalCollectorLifecycleState,
  drainCollectorQueue,
  enrollCollector,
  LOCAL_COLLECTOR_LIFECYCLE_STATES,
  type LocalCollectorLifecycleInput,
  type LocalCollectorLifecycleState,
  readCollectionScopeFromState,
  resolveScopedStreamTimeRanges,
  runCollectorConnector,
  summarizeCollectorCompleteness,
  transformRecordsToCollectorEnvelopes,
} from "./collector-runner.ts";
export {
  DEFAULT_LOCAL_DEVICE_REQUEST_TIMEOUT_MS,
  type EnrollmentExchangeRequest,
  type EnrollmentExchangeResponse,
  type GetSourceInstanceStateRequest,
  type HeartbeatRequest,
  type IngestBatchRequest,
  LOCAL_DEVICE_ENDPOINTS,
  LocalDeviceClient,
  type LocalDeviceClientOptions,
  LocalDeviceHttpError,
  LocalDeviceRequestTimeoutError,
  type PutSourceInstanceStateRequest,
  type SourceInstanceStateResponse,
} from "./local-device-client.ts";
export {
  type BuildLocalDeviceRecordEnvelopeInput,
  buildLocalDeviceRecordEnvelope,
  canonicalJson,
  hashCanonicalJson,
  type LocalDeviceRecordEnvelope,
} from "./local-device-envelope.ts";
export {
  type BuildLocalDeviceOutboxIdInput,
  buildLocalDeviceOutboxId,
  classifyDeadLetterError,
  LocalDeviceOutbox,
  type LocalDeviceOutboxClaimInput,
  type LocalDeviceOutboxCompactResult,
  type LocalDeviceOutboxDeadLetterErrorClass,
  type LocalDeviceOutboxDeadLetterErrorSummary,
  type LocalDeviceOutboxDeadLetterErrorSummaryInput,
  type LocalDeviceOutboxDeadLetterInput,
  type LocalDeviceOutboxEnqueueInput,
  type LocalDeviceOutboxFailInput,
  type LocalDeviceOutboxItem,
  type LocalDeviceOutboxKind,
  type LocalDeviceOutboxLeaseInput,
  type LocalDeviceOutboxOptions,
  type LocalDeviceOutboxPageStats,
  type LocalDeviceOutboxPruneSentInput,
  type LocalDeviceOutboxPruneSentResult,
  type LocalDeviceOutboxRenewInput,
  type LocalDeviceOutboxRequeueDeadLettersInput,
  type LocalDeviceOutboxRequeueDeadLettersResult,
  type LocalDeviceOutboxStatus,
  type LocalDeviceOutboxSummary,
} from "./local-device-outbox.ts";
export {
  LocalDeviceQueue,
  type LocalDeviceQueueItem,
  type LocalDeviceQueueOptions,
  type LocalDeviceQueueStatus,
} from "./local-device-queue.ts";
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
} from "./runtime-capabilities.ts";
