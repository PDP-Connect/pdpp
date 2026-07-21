import { createHash } from "node:crypto";

const GENERATION_HASH_PATTERN = /^[a-f0-9]{64}$/;

export const REPLACEMENT_CAUSES = [
  "capacity_pressure",
  "idle_ttl",
  "operator_requested",
  "restart_reconcile",
  "readiness_invalidated",
  "allocator_internal_ensure_surface",
  "same_container_browser_generation_change",
  "external_or_host_loss",
] as const;

export type ReplacementCause = (typeof REPLACEMENT_CAUSES)[number];
export type ReplacementPhase = "started" | "completed" | "terminal";
export type ReplacementTerminalOutcome = "failed" | "abandoned";

export interface ReplacementReceipt {
  readonly cause: ReplacementCause;
  readonly connection_id: string;
  readonly connector_id?: string;
  readonly event_seq: number;
  readonly idempotency_key: string;
  readonly lease_id?: string;
  readonly next_generation_hash?: string;
  readonly observed_at: string;
  readonly phase: ReplacementPhase;
  readonly previous_generation_hash?: string;
  readonly profile_key: string;
  readonly replacement_id: string;
  readonly run_id?: string;
  readonly scope: string;
  readonly surface_id?: string;
  readonly surface_subject_id?: string;
  readonly terminal_outcome?: ReplacementTerminalOutcome;
}

export interface ReplacementStartInput {
  readonly cause: ReplacementCause | string;
  readonly connection_id: string;
  readonly connector_id?: string;
  readonly idempotency_key?: string;
  readonly lease_id?: string;
  readonly observed_at?: string;
  readonly previous_generation?: number;
  readonly previous_generation_hash?: string;
  readonly profile_key: string;
  readonly run_id?: string;
  readonly surface_id?: string;
  readonly surface_subject_id?: string;
}

export interface ReplacementCompletionInput {
  readonly cause?: ReplacementCause | string;
  readonly connection_id: string;
  readonly connector_id?: string;
  readonly idempotency_key?: string;
  readonly lease_id?: string;
  readonly next_generation?: number;
  readonly next_generation_hash?: string;
  readonly observed_at?: string;
  readonly profile_key?: string;
  readonly replacement_id: string;
  readonly run_id?: string;
  readonly surface_id?: string;
  readonly surface_subject_id?: string;
}

export interface ReplacementTerminalInput extends ReplacementCompletionInput {
  readonly outcome: ReplacementTerminalOutcome;
}

export interface BrowserSurfaceReplacementLedgerOptions {
  readonly idPrefix?: string;
  readonly now?: () => string;
}

export interface BrowserSurfaceReplacementLedger {
  complete(input: ReplacementCompletionInput): ReplacementReceipt;
  hydrate(receipts: readonly ReplacementReceipt[]): void;
  list(): readonly ReplacementReceipt[];
  selectCurrent(
    connectionId: string,
    surfaceSubjectId?: string,
    currentGenerationHash?: string
  ): ReplacementReceipt | null;
  start(input: ReplacementStartInput): ReplacementReceipt;
  terminate(input: ReplacementTerminalInput): ReplacementReceipt;
}

export interface ReplacementReceiptStore {
  append(receipt: ReplacementReceipt): Promise<ReplacementReceipt>;
  findPendingForSurface(surfaceId: string): Promise<ReplacementReceipt | null>;
  list(): Promise<readonly ReplacementReceipt[]>;
}

type StartIdentity = Pick<ReplacementReceipt, "connection_id" | "profile_key" | "cause"> &
  Partial<
    Pick<
      ReplacementReceipt,
      "connector_id" | "surface_subject_id" | "run_id" | "lease_id" | "surface_id" | "previous_generation_hash"
    >
  >;

export class ReplacementReplayConflictError extends Error {
  readonly code = "replacement_replay_conflict";

  constructor(message: string) {
    super(message);
    this.name = "ReplacementReplayConflictError";
  }
}

export function deriveOpaqueGenerationHash(value: string): string {
  if (!value) {
    throw new Error("opaque generation value must not be empty");
  }
  return sha256(`opaque-generation\0${value}`);
}

export function mapStopReasonToReplacementCause(
  reason: "capacity_pressure" | "idle_ttl" | "operator" | "reconcile" | "surface_failed"
): ReplacementCause {
  switch (reason) {
    case "capacity_pressure":
      return "capacity_pressure";
    case "idle_ttl":
      return "idle_ttl";
    case "operator":
      return "operator_requested";
    case "reconcile":
      return "restart_reconcile";
    case "surface_failed":
      return "readiness_invalidated";
  }
}

export function createBrowserSurfaceReplacementLedger(
  options: BrowserSurfaceReplacementLedgerOptions = {}
): BrowserSurfaceReplacementLedger {
  const now = options.now ?? (() => new Date().toISOString());
  const idPrefix = options.idPrefix ?? "replacement";
  const receipts: ReplacementReceipt[] = [];
  const byIdempotency = new Map<string, ReplacementReceipt[]>();
  const byReplacement = new Map<string, ReplacementReceipt[]>();
  let nextEventSeq = 1;

  function append(receipt: ReplacementReceipt): ReplacementReceipt {
    const sameEvent = findSameEvent(receipt);
    if (sameEvent) {
      return replayEvent(sameEvent, receipt);
    }
    const replacementEvents = byReplacement.get(receipt.replacement_id) ?? [];
    const samePhase = replacementEvents.find((row) => row.phase === receipt.phase);
    if (samePhase) {
      return replayEvent(samePhase, receipt);
    }
    const prior = replacementEvents.at(-1);
    assertNewEventIdentity(prior, receipt);
    recordEvent(receipt, replacementEvents);
    return receipt;
  }

  function findSameEvent(receipt: ReplacementReceipt): ReplacementReceipt | undefined {
    return byIdempotency.get(receipt.idempotency_key)?.find((row) => row.phase === receipt.phase);
  }

  function replayEvent(existing: ReplacementReceipt, incoming: ReplacementReceipt): ReplacementReceipt {
    assertReplayCompatible(existing, incoming);
    return existing;
  }

  function assertNewEventIdentity(previous: ReplacementReceipt | undefined, incoming: ReplacementReceipt): void {
    if (previous) {
      assertImmutableIdentity(previous, incoming);
    }
  }

  function recordEvent(receipt: ReplacementReceipt, replacementEvents: ReplacementReceipt[]): void {
    receipts.push(receipt);
    nextEventSeq = Math.max(nextEventSeq, receipt.event_seq + 1);
    byIdempotency.set(receipt.idempotency_key, [...(byIdempotency.get(receipt.idempotency_key) ?? []), receipt]);
    byReplacement.set(receipt.replacement_id, [...replacementEvents, receipt]);
  }

  function start(input: ReplacementStartInput): ReplacementReceipt {
    const identity = startIdentity(input);
    const idempotencyKey = input.idempotency_key ?? deriveIdempotencyKey("start", identity);
    return append({
      event_seq: nextEventSeq,
      replacement_id: `${idPrefix}_${sha256(idempotencyKey).slice(0, 24)}`,
      idempotency_key: idempotencyKey,
      scope: replacementScope(identity.connection_id, identity.surface_subject_id),
      ...identity,
      phase: "started",
      observed_at: input.observed_at ?? now(),
    });
  }

  function startIdentity(input: ReplacementStartInput): StartIdentity {
    const identity = {
      connection_id: assertNonEmpty(input.connection_id, "connection_id"),
      profile_key: assertNonEmpty(input.profile_key, "profile_key"),
      cause: assertCause(input.cause),
    } as StartIdentity;
    assignOptional(identity, "connector_id", optionalNonEmpty(input.connector_id));
    assignOptional(identity, "surface_subject_id", optionalNonEmpty(input.surface_subject_id));
    assignOptional(identity, "run_id", optionalNonEmpty(input.run_id));
    assignOptional(identity, "lease_id", optionalNonEmpty(input.lease_id));
    assignOptional(identity, "surface_id", optionalNonEmpty(input.surface_id));
    assignOptional(
      identity,
      "previous_generation_hash",
      generationHash(input.previous_generation_hash, input.previous_generation)
    );
    return identity;
  }

  function complete(input: ReplacementCompletionInput): ReplacementReceipt {
    const replay = findResolutionReplay(input, "completed");
    if (replay) {
      return replayResolution(input, replay);
    }
    assertNoOtherResolution(input, "completed");
    const prior = requireStarted(input.replacement_id);
    return append(completedReceipt(prior, input));
  }

  function terminate(input: ReplacementTerminalInput): ReplacementReceipt {
    const replay = findResolutionReplay(input, "terminal");
    if (replay) {
      assertInputReplayCompatible(input, replay);
      return replay;
    }
    assertNoOtherResolution(input, "terminal");
    const prior = requireStarted(input.replacement_id);
    const cause = input.cause === undefined ? prior.cause : assertCause(input.cause);
    assertCompletionInput(input, prior, cause);
    return append(resolvedReceipt(prior, input, "terminal", undefined, input.outcome));
  }

  function findResolutionReplay(
    input: ReplacementCompletionInput,
    phase: "completed" | "terminal"
  ): ReplacementReceipt | undefined {
    const events = input.idempotency_key
      ? byIdempotency.get(input.idempotency_key)
      : byReplacement.get(input.replacement_id);
    return events?.find((row) => row.phase === phase);
  }

  function replayResolution(input: ReplacementCompletionInput, replay: ReplacementReceipt): ReplacementReceipt {
    assertInputReplayCompatible(input, replay);
    return replay;
  }

  function completedReceipt(prior: ReplacementReceipt, input: ReplacementCompletionInput): ReplacementReceipt {
    const nextGenerationHash = generationHash(input.next_generation_hash, input.next_generation);
    if (!nextGenerationHash) {
      throw new Error("completed replacement requires an observed generation hash");
    }
    const cause = input.cause === undefined ? prior.cause : assertCause(input.cause);
    assertCompletionInput(input, prior, cause);
    return resolvedReceipt(prior, input, "completed", nextGenerationHash);
  }

  function assertNoOtherResolution(input: ReplacementCompletionInput, requestedPhase: "completed" | "terminal"): void {
    const resolved = byReplacement
      .get(input.replacement_id)
      ?.find((row) => row.phase === "completed" || row.phase === "terminal");
    if (resolved && resolved.phase !== requestedPhase) {
      throw new ReplacementReplayConflictError(
        `replacement ${resolved.replacement_id} already resolved as ${resolved.phase}`
      );
    }
  }

  function resolvedReceipt(
    prior: ReplacementReceipt,
    input: ReplacementCompletionInput,
    phase: "completed" | "terminal",
    nextGenerationHash?: string,
    terminalOutcome?: ReplacementTerminalOutcome
  ): ReplacementReceipt {
    const receipt = {
      event_seq: nextEventSeq,
      replacement_id: prior.replacement_id,
      idempotency_key:
        input.idempotency_key ?? `${prior.idempotency_key}:${phase}${terminalOutcome ? `:${terminalOutcome}` : ""}`,
      scope: prior.scope,
      connection_id: prior.connection_id,
      profile_key: prior.profile_key,
      cause: prior.cause,
      phase,
      observed_at: input.observed_at ?? now(),
    } as ReplacementReceipt;
    copyIdentityFields(receipt, prior);
    assignOptional(receipt, "next_generation_hash", nextGenerationHash);
    assignOptional(receipt, "terminal_outcome", terminalOutcome);
    return receipt;
  }

  return {
    start,
    complete,
    terminate,
    list() {
      return receipts.slice();
    },
    hydrate(hydratedReceipts) {
      hydrateReceipts(hydratedReceipts, append);
    },
    selectCurrent(connectionId, surfaceSubjectId, currentGenerationHash) {
      return selectCurrentForScope(receipts, connectionId, surfaceSubjectId, currentGenerationHash);
    },
  };

  function requireStarted(replacementId: string): ReplacementReceipt {
    const events = byReplacement.get(assertNonEmpty(replacementId, "replacement_id"));
    const started = events?.find((row) => row.phase === "started");
    if (!started) {
      throw new Error(`replacement ${replacementId} has no started receipt`);
    }
    return started;
  }
}

export function selectCurrentReplacementReceipt(
  receipts: readonly ReplacementReceipt[],
  currentGenerationHash: string | null
): ReplacementReceipt | null {
  const latestStarted = receipts
    .filter((receipt) => receipt.phase === "started")
    .sort(compareReceiptsAscending)
    .at(-1);
  if (!latestStarted) {
    return null;
  }
  const latest = receipts
    .filter((receipt) => receipt.replacement_id === latestStarted.replacement_id)
    .sort(compareReceiptsAscending)
    .at(-1);
  if (!latest) {
    return null;
  }
  if (latest.phase === "started") {
    return latest;
  }
  if (latest.phase === "terminal") {
    return null;
  }
  return latest.next_generation_hash === currentGenerationHash ? latest : null;
}

function compareReceiptsAscending(left: ReplacementReceipt, right: ReplacementReceipt): number {
  return left.event_seq - right.event_seq || left.idempotency_key.localeCompare(right.idempotency_key);
}

function assignOptional<T extends object>(target: T, key: string, value: unknown): void {
  if (value !== undefined) {
    (target as Record<string, unknown>)[key] = value;
  }
}

function copyIdentityFields(target: ReplacementReceipt, source: ReplacementReceipt): void {
  assignOptional(target, "connector_id", source.connector_id);
  assignOptional(target, "surface_subject_id", source.surface_subject_id);
  assignOptional(target, "run_id", source.run_id);
  assignOptional(target, "lease_id", source.lease_id);
  assignOptional(target, "surface_id", source.surface_id);
  assignOptional(target, "previous_generation_hash", source.previous_generation_hash);
}

function hydrateReceipts(
  hydratedReceipts: readonly ReplacementReceipt[],
  append: (receipt: ReplacementReceipt) => ReplacementReceipt
): void {
  for (const receipt of [...hydratedReceipts].sort((left, right) => left.event_seq - right.event_seq)) {
    append(receipt);
  }
}

function selectCurrentForScope(
  receipts: readonly ReplacementReceipt[],
  connectionId: string,
  surfaceSubjectId: string | undefined,
  currentGenerationHash: string | undefined
): ReplacementReceipt | null {
  const scopeRows = receipts.filter(
    (receipt) => receipt.connection_id === connectionId && matchesSurfaceSubject(receipt, surfaceSubjectId)
  );
  if (surfaceSubjectId === undefined && new Set(scopeRows.map((receipt) => receipt.scope)).size > 1) {
    return null;
  }
  return selectCurrentReplacementReceipt(scopeRows, currentGenerationHash ?? null);
}

function matchesSurfaceSubject(receipt: ReplacementReceipt, surfaceSubjectId: string | undefined): boolean {
  return surfaceSubjectId === undefined || receipt.surface_subject_id === surfaceSubjectId;
}

function assertCompletionInput(
  input: ReplacementCompletionInput,
  prior: ReplacementReceipt,
  cause: ReplacementCause
): void {
  assertCompletionIdentity(input, prior, cause);
  assertOptionalFieldsMatch(input, prior);
}

function assertCompletionIdentity(
  input: ReplacementCompletionInput,
  prior: ReplacementReceipt,
  cause: ReplacementCause
): void {
  if (input.connection_id !== prior.connection_id) {
    throw new ReplacementReplayConflictError(`replacement ${prior.replacement_id} connection changed on replay`);
  }
  if (cause !== prior.cause) {
    throw new ReplacementReplayConflictError(`replacement ${prior.replacement_id} cause changed on replay`);
  }
}

function assertOptionalFieldsMatch(input: ReplacementCompletionInput, prior: ReplacementReceipt): void {
  for (const field of [
    "connector_id",
    "profile_key",
    "surface_subject_id",
    "run_id",
    "lease_id",
    "surface_id",
  ] as const) {
    assertOptionalFieldMatch(input[field], prior[field], prior.replacement_id, field);
  }
}

function assertOptionalFieldMatch(
  incoming: string | undefined,
  existing: string | undefined,
  replacementId: string,
  field: string
): void {
  if (incoming !== undefined && incoming !== existing) {
    throw new ReplacementReplayConflictError(`replacement ${replacementId} immutable field ${field} changed on replay`);
  }
}

function assertInputReplayCompatible(
  input: ReplacementCompletionInput | ReplacementTerminalInput,
  existing: ReplacementReceipt
): void {
  assertReplayIdentity(input, existing);
  assertOptionalFieldsMatch(input, existing);
  assertReplayCause(input, existing);
  assertReplayGeneration(input, existing);
  assertReplayOutcome(input, existing);
}

function assertReplayIdentity(input: ReplacementCompletionInput, existing: ReplacementReceipt): void {
  if (input.replacement_id !== existing.replacement_id || input.connection_id !== existing.connection_id) {
    throw new ReplacementReplayConflictError(
      `replacement ${existing.replacement_id} replay changed immutable identity`
    );
  }
}

function assertReplayCause(input: ReplacementCompletionInput, existing: ReplacementReceipt): void {
  if (input.cause !== undefined && assertCause(input.cause) !== existing.cause) {
    throw new ReplacementReplayConflictError(
      `replacement ${existing.replacement_id} replay changed immutable field cause`
    );
  }
}

function assertReplayGeneration(input: ReplacementCompletionInput, existing: ReplacementReceipt): void {
  if (input.next_generation_hash === undefined && input.next_generation === undefined) {
    return;
  }
  if (generationHash(input.next_generation_hash, input.next_generation) !== existing.next_generation_hash) {
    throw new ReplacementReplayConflictError(
      `replacement ${existing.replacement_id} replay changed immutable field next_generation_hash`
    );
  }
}

function assertReplayOutcome(
  input: ReplacementCompletionInput | ReplacementTerminalInput,
  existing: ReplacementReceipt
): void {
  if ("outcome" in input && input.outcome !== existing.terminal_outcome) {
    throw new ReplacementReplayConflictError(
      `replacement ${existing.replacement_id} replay changed immutable field terminal_outcome`
    );
  }
}

function assertReplayCompatible(existing: ReplacementReceipt, incoming: ReplacementReceipt): void {
  const fields: readonly (keyof ReplacementReceipt)[] = [
    "replacement_id",
    "scope",
    "connection_id",
    "connector_id",
    "profile_key",
    "surface_subject_id",
    "run_id",
    "lease_id",
    "surface_id",
    "previous_generation_hash",
    "next_generation_hash",
    "cause",
    "phase",
    "terminal_outcome",
  ];
  for (const field of fields) {
    if (existing[field] !== incoming[field]) {
      throw new ReplacementReplayConflictError(`replacement replay changed immutable field ${field}`);
    }
  }
}

function assertImmutableIdentity(previous: ReplacementReceipt, incoming: ReplacementReceipt): void {
  for (const field of [
    "replacement_id",
    "scope",
    "connection_id",
    "connector_id",
    "profile_key",
    "surface_subject_id",
    "run_id",
    "lease_id",
    "surface_id",
    "previous_generation_hash",
    "cause",
  ] as const) {
    if (previous[field] !== incoming[field]) {
      throw new ReplacementReplayConflictError(
        `replacement ${previous.replacement_id} immutable field ${field} changed`
      );
    }
  }
}

function assertCause(value: ReplacementCause | string): ReplacementCause {
  if ((REPLACEMENT_CAUSES as readonly string[]).includes(value)) {
    return value as ReplacementCause;
  }
  throw new Error(`unknown replacement cause '${value}'`);
}

function assertNonEmpty(value: string | undefined, field: string): string {
  if (!value?.trim()) {
    throw new Error(`${field} must be non-empty`);
  }
  return value;
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function generationHash(value: string | undefined, generation: number | undefined): string | undefined {
  if (value !== undefined) {
    if (!GENERATION_HASH_PATTERN.test(value)) {
      throw new Error("generation hashes must be lowercase SHA-256 hex values");
    }
    return value;
  }
  return generation === undefined ? undefined : sha256(`logical-generation\0${String(generation)}`);
}

function replacementScope(connectionId: string, surfaceSubjectId: string | undefined): string {
  // This value is persisted in TEXT by both SQLite and PostgreSQL. NUL is a
  // useful in-memory delimiter, but PostgreSQL rejects it at the parameter
  // boundary. JSON preserves the exact two-part identity without relying on
  // a character that one of the supported stores cannot represent.
  return JSON.stringify([connectionId, surfaceSubjectId ?? ""]);
}

function deriveIdempotencyKey(kind: string, value: unknown): string {
  return `${kind}_${sha256(JSON.stringify(value))}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
