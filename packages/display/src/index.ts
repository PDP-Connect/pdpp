// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// One public surface for framework-independent display policy. Internal modules
// stay grouped by the knowledge they own; consumers import only @pdpp/display.
export type {
  AttentionAxis,
  AxisChip,
  CoverageAxis,
  EvidenceTone,
  FreshnessAxis,
  OutboxAxis,
} from "./health/axis-vocabulary.ts";
// biome-ignore lint/performance/noBarrelFile: this package intentionally provides one stable public import surface.
export {
  formatAttentionAxis,
  formatCoverageAxis,
  formatFreshnessAxis,
  formatOutboxAxis,
} from "./health/axis-vocabulary.ts";
export type { ConnectorDisplayInput, SourceDisplayInput } from "./identity/connector-display.ts";
export {
  deriveSourceDisplayNameFallback,
  formatConnectorKeyForDisplay,
  formatConnectorNameForDisplay,
  formatSourceForDisplay,
  formatSourceWithConnectionForDisplay,
  isFallbackConnectionLabel,
} from "./identity/connector-display.ts";
export type { StreamManifestEntry } from "./identity/stream-display.ts";
export { streamDisplayDetail, streamDisplayLabel } from "./identity/stream-display.ts";
export type {
  ClientDisplayInput,
  GrantLabelInput,
  RunLabelInput,
  TraceLabelInput,
} from "./identity/summary-row-label.ts";
export { grantRowLabel, runRowLabel, traceRowLabel } from "./identity/summary-row-label.ts";
export type { DeclaredFieldRoles, FieldRole } from "./record/declared-field-roles.ts";
export {
  EMPTY_DECLARED_FIELD_ROLES,
  fieldForRole,
  hasDeclaredRoles,
  parseFieldRole,
} from "./record/declared-field-roles.ts";
export type { DeclaredFieldTypes } from "./record/declared-field-types.ts";
export { humanizeFieldLabel } from "./record/field-label.ts";
export type { FormattedAmount } from "./record/record-format.ts";
export {
  deriveDeclaredFieldTypes,
  formatDeclaredAmount,
  isMonetaryDeclaredType,
} from "./record/record-format.ts";
export type {
  PreviewKind,
  PreviewKindDescriptor,
  RecordKind,
  RecordKindDescriptor,
} from "./record/record-kind.ts";
export { classifyRecordKind } from "./record/record-kind.ts";
export type { GenericField, RecordPreview } from "./record/record-preview.ts";
export { buildRecordPreview, rowPrimary, rowSecondary } from "./record/record-preview.ts";
export type { StructuredCell } from "./record/structured-value.ts";
export { formatStructuredCell } from "./record/structured-value.ts";
export type { FusedSourceStatus } from "./source/fused-source-status.ts";
export { fuseSourceStatus } from "./source/fused-source-status.ts";
export type {
  SourceLifecycleFacts,
  SourceStatusFlag,
  SourceStatusInput,
  SourceStatusKind,
  SourceStatusTone,
  SourceTerminalSetupDisposition,
  SourceVerdictInput,
  SourceVerdictTone,
  TerminalSetupDispositionCopy,
} from "./source/source-status.ts";
export {
  deriveRenderedSourceStatus,
  deriveSourceLifecycleFacts,
  deriveSourceVerdictStatus,
  freshnessNoteFromVerdict,
  isActiveSourceRunStatus,
  isArchivedSource,
  isPausedSource,
  isRevokedSource,
  isSetupFailedSource,
  isSetupInProgressSource,
  renderedSourceStatus,
  TERMINAL_SETUP_DISPOSITION_COPY,
} from "./source/source-status.ts";
export type { SourceVerdictProjection } from "./source/source-verdict.ts";
export { projectSourceVerdict } from "./source/source-verdict.ts";
export type {
  ParsedTimestamp,
  TimestampPrecision,
  TimestampValue,
  TimestampValueKind,
} from "./time/timestamp.ts";
export {
  DAY,
  formatCalendarDate,
  formatInstantAbsolute,
  formatRelative,
  formatTimestampTitle,
  HOUR,
  MINUTE,
  parseTimestampValue,
  RELATIVE_CUTOFF,
} from "./time/timestamp.ts";
