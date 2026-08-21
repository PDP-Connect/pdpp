// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { fingerprintsEqual } from "./stores/credential-encryption.ts";

const DRAFT_IDENTITY_PREFIX = "static_secret_draft_identity_";
const VERIFIED_IDENTITY_PREFIX = "static_secret_verified_identity_";

export interface StaticSecretIdentityField {
  readonly identity?: boolean;
  readonly label?: string;
  readonly name: string;
  readonly required?: boolean;
  readonly secret?: boolean;
}

/**
 * Provider identities are non-secret account labels, not credentials. Keep
 * normalization deliberately conservative: whitespace is transport noise;
 * changing case or Unicode semantics could collapse two provider identities
 * that the manifest has not declared equivalent.
 */
export function normalizeStaticSecretIdentity(value: string): string {
  return value.trim();
}

function identityBindingKey(prefix: string, ownerSubjectId: string, connectorId: string, identity: string): string {
  const normalized = normalizeStaticSecretIdentity(identity);
  if (!normalized) {
    return "";
  }
  const digest = createHash("sha256")
    .update(prefix)
    .update("\u0000")
    .update(ownerSubjectId)
    .update("\u0000")
    .update(connectorId)
    .update("\u0000")
    .update(normalized)
    .digest("hex");
  return `${prefix}${digest}`;
}

export function staticSecretDraftIdentityBindingKey(
  ownerSubjectId: string,
  connectorId: string,
  identity: string
): string {
  return identityBindingKey(DRAFT_IDENTITY_PREFIX, ownerSubjectId, connectorId, identity);
}

export function staticSecretVerifiedIdentityBindingKey(
  ownerSubjectId: string,
  connectorId: string,
  identity: string
): string {
  return identityBindingKey(VERIFIED_IDENTITY_PREFIX, ownerSubjectId, connectorId, identity);
}

export function isStaticSecretVerifiedIdentityBindingKey(value: string): boolean {
  return value.startsWith(VERIFIED_IDENTITY_PREFIX);
}

export function staticSecretSetupIdentity(
  fields: readonly StaticSecretIdentityField[],
  setupFields: Record<string, string>
): string | null {
  const field = fields.find((candidate) => candidate.identity && !candidate.secret);
  return field ? (setupFields[field.name] ?? null) : null;
}

export function staticSecretSetupFieldsFromBinding(sourceBinding: unknown): Record<string, string> | null {
  const source = objectRecord(sourceBinding);
  const raw = objectRecord(source?.setup_fields);
  if (!raw) {
    return null;
  }
  const fields = stringFields(raw);
  return Object.keys(fields).length > 0 ? fields : null;
}

export function staticSecretVerifiedIdentityFromBinding(sourceBinding: unknown): string | null {
  const value = objectRecord(sourceBinding)?.verified_identity;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function staticSecretBindingRecord(sourceBinding: unknown): Record<string, unknown> | null {
  const source = objectRecord(sourceBinding);
  return source ? { ...source } : null;
}

export function staticSecretIdentityConflictError(
  message: string,
  code = "static_secret_identity_conflict"
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function isStaticSecretBindingUniqueConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && new Set(["23505", "SQLITE_CONSTRAINT_UNIQUE"]).has(code)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("UNIQUE constraint failed") || message.includes("duplicate key value violates unique constraint")
  );
}

export function staticSecretIdentityClaim(input: {
  connectorId: string;
  ownerSubjectId: string;
  probedIdentity: string;
}): { identity: string; sourceBindingKey: string } {
  const identity = normalizeStaticSecretIdentity(input.probedIdentity);
  const sourceBindingKey = staticSecretVerifiedIdentityBindingKey(input.ownerSubjectId, input.connectorId, identity);
  if (!sourceBindingKey) {
    throw staticSecretIdentityConflictError(
      "The provider returned no verified account identity; refusing to store the credential.",
      "static_secret_identity_missing"
    );
  }
  return { identity, sourceBindingKey };
}

export function parseStaticSecretSetupFields(
  raw: unknown,
  fields: readonly StaticSecretIdentityField[],
  onError: (code: string, message: string, param: string) => void
): Record<string, string> | undefined | null {
  if (raw === undefined) {
    return;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    onError("invalid_request", "setup_fields must be an object when provided.", "setup_fields");
    return null;
  }
  const provided = objectRecord(raw);
  if (!provided) {
    return null;
  }
  return parseSetupFieldRecord(provided, fields, onError);
}

export function parseStaticSecretDraftSetupFields(
  raw: unknown,
  fields: readonly StaticSecretIdentityField[],
  onError: (code: string, message: string, param: string) => void
): Record<string, string> | null {
  return parseSetupFieldRecord(objectRecord(raw) ?? {}, fields, onError);
}

function parseSetupFieldRecord(
  provided: Record<string, unknown>,
  fields: readonly StaticSecretIdentityField[],
  onError: (code: string, message: string, param: string) => void
): Record<string, string> | null {
  const unknown = unknownStaticSecretSetupField(provided, fields);
  if (unknown) {
    onError("unknown_setup_field", `Unknown setup field: ${unknown}`, `setup_fields.${unknown}`);
    return null;
  }
  const missing = missingStaticSecretSetupField(provided, fields);
  if (missing) {
    onError("missing_setup_field", `${missing.label ?? missing.name} is required.`, `setup_fields.${missing.name}`);
    return null;
  }
  return collectStaticSecretSetupFields(provided, fields);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringFields(raw: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) => (typeof value === "string" ? [[key, value.trim()]] : []))
  );
}

function unknownStaticSecretSetupField(
  provided: Record<string, unknown>,
  fields: readonly StaticSecretIdentityField[]
): string | null {
  const allowed = new Set(fields.filter((field) => !field.secret).map((field) => field.name));
  return Object.keys(provided).find((key) => !allowed.has(key)) ?? null;
}

function fieldText(field: StaticSecretIdentityField, provided: Record<string, unknown>): string {
  const value = provided[field.name];
  return typeof value === "string" ? value.trim() : "";
}

function missingStaticSecretSetupField(
  provided: Record<string, unknown>,
  fields: readonly StaticSecretIdentityField[]
): StaticSecretIdentityField | null {
  return fields.find((field) => !field.secret && field.required && !fieldText(field, provided)) ?? null;
}

function collectStaticSecretSetupFields(
  provided: Record<string, unknown>,
  fields: readonly StaticSecretIdentityField[]
): Record<string, string> {
  return Object.fromEntries(
    fields
      .filter((field) => !field.secret)
      .map((field) => [field.name, fieldText(field, provided)])
      .filter(([, value]) => value)
  );
}

// A binding only carries retarget-protection authority once it has gone
// through the real static-secret setup pipeline — captured as a
// `static_secret_draft` and, once promoted, a `static_secret` binding. A row
// with neither kind — e.g. an `account_hint`-only legacy shape that predates
// this pipeline entirely — never had the chance to record a durable identity
// signal and must remain repairable exactly as before. This is the one
// legacy carve-out; every pipeline-shaped active row is subject to the
// fail-closed rule below, whether or not `activateDraft` has yet rewritten
// its binding `kind` from `static_secret_draft` to `static_secret`.
//
// `historical_archive` is included so a recovered row that still carries a
// credential + durable `verified_identity` from before it was paused gets the
// SAME fail-closed retarget protection as any other static-secret row — this
// binding kind is never rewritten away by the archive-reconnect capture path
// (see `ref-static-secret-credentials.ts`'s `isPausedHistoricalArchiveTarget`),
// so without this it would be silently exempt from the mismatch guard below.
const STATIC_SECRET_PIPELINE_BINDING_KINDS = new Set(["static_secret", "static_secret_draft", "historical_archive"]);

export function isStaticSecretPipelineBinding(sourceBinding: unknown): boolean {
  const kind = objectRecord(sourceBinding)?.kind;
  return typeof kind === "string" && STATIC_SECRET_PIPELINE_BINDING_KINDS.has(kind);
}

function staticSecretRetargetRefusedError(): Error & { code: string } {
  return staticSecretIdentityConflictError(
    "This active connection has no verified provider identity on record, so a credential replacement cannot be " +
      "proven safe. To connect a different account, disconnect this connection and create a new one.",
    "static_secret_identity_unverified_replacement"
  );
}

// Terminal authority for REPLACING the credential behind an ACTIVE
// static-secret connection. Only fires when a credential already exists —
// the very first capture on an active row (no credential yet, e.g. a
// connection seeded active before its owner ever sealed a secret) is
// establishment, not replacement, and always proceeds.
//
// Once a credential exists, absence of proof is never read as permission,
// and PROOF MEANS EVIDENCE THE OWNER DID NOT AUTHOR: a replacement is
// allowed only when THIS request affirmatively proves sameness via one of
// two channels, both independent of anything the caller typed into the
// request body —
//   1. `identity` is a value a synchronous PROVIDER PROBE just returned for
//      the new secret, and it matches the durable `verified_identity`
//      already on the binding — itself only ever written from an earlier
//      successful probe. `setup_fields` (owner-typed, non-secret, resubmit-
//      table alongside any stolen secret) is NEVER an acceptable source for
//      either side of this comparison — an attacker who already knows the
//      account email can trivially resubmit it.
//   2. A non-secret, key-derived fingerprint proves the submitted secret is
//      byte-for-byte the same credential already stored — computed from the
//      plaintext itself, never from anything the request "claims".
// A provider-probed identity that CONTRADICTS the durable one is a hard
// reject — fingerprint sameness cannot override an explicit, proven account
// mismatch. Anything that proves neither channel is refused; the sanctioned
// path for a genuine account change is an explicit disconnect + new
// connection.
export function assertStaticSecretActiveCredentialReplacementAllowed(input: {
  existingCredentialFingerprint: string | null;
  hasExistingCredential: boolean;
  newSecretFingerprint: string | null;
  probedIdentity?: string | undefined;
  sourceBinding: unknown;
  status: string;
}): void {
  // `paused` is admitted alongside `active` so a recovered historical-archive
  // row carrying a residual credential + durable identity (from before it was
  // paused) gets the identical fail-closed check — a paused row is not
  // exempt from proving sameness just because it is not currently active.
  if (
    (input.status !== "active" && input.status !== "paused") ||
    !isStaticSecretPipelineBinding(input.sourceBinding) ||
    !input.hasExistingCredential
  ) {
    return;
  }
  const durableIdentity = staticSecretVerifiedIdentityFromBinding(input.sourceBinding);
  const probedIdentity =
    input.probedIdentity === undefined ? null : normalizeStaticSecretIdentity(input.probedIdentity);
  if (durableIdentity !== null && probedIdentity !== null) {
    if (probedIdentity !== normalizeStaticSecretIdentity(durableIdentity)) {
      throw staticSecretIdentityConflictError(
        "This active connection is already verified for a different provider identity. Create a separate connection for the other account.",
        "static_secret_identity_mismatch"
      );
    }
    return;
  }
  // No affirmative provider-verified identity match: either nothing durable
  // is on record yet, or this request had no probe to compare against (a
  // no-probe connector never reaches the branch above at all). Fall back to
  // exact-credential proof — fingerprints are derived from the plaintext
  // under the operator key, so a match proves sameness without decrypting
  // the stored secret or trusting anything the request merely claims.
  if (
    input.existingCredentialFingerprint &&
    input.newSecretFingerprint &&
    fingerprintsEqual(input.existingCredentialFingerprint, input.newSecretFingerprint)
  ) {
    return;
  }
  throw staticSecretRetargetRefusedError();
}

export interface StaticSecretIdentityInstance {
  readonly connectorInstanceId: string;
  readonly displayName?: string | null;
  readonly sourceBinding?: unknown;
  readonly status: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface StaticSecretIdentityStore<T extends StaticSecretIdentityInstance = StaticSecretIdentityInstance> {
  getByBinding: (input: {
    connectorId: string;
    ownerSubjectId: string;
    sourceBindingKey: string;
    sourceKind: string;
  }) => MaybePromise<T | null>;
  listActiveByConnector: (ownerSubjectId: string, connectorId: string, options: { limit: number }) => MaybePromise<T[]>;
}

export async function findExistingStaticSecretIdentity<T extends StaticSecretIdentityInstance>(input: {
  connectorId: string;
  fields: readonly StaticSecretIdentityField[];
  ownerSubjectId: string;
  setupFields: Record<string, string>;
  store: StaticSecretIdentityStore<T>;
}): Promise<T | null> {
  const identity = normalizeStaticSecretIdentity(staticSecretSetupIdentity(input.fields, input.setupFields) ?? "");
  const identityField = input.fields.find((field) => field.identity && !field.secret);
  if (!(identity && identityField)) {
    return null;
  }
  const draft = await input.store.getByBinding({
    connectorId: input.connectorId,
    ownerSubjectId: input.ownerSubjectId,
    sourceBindingKey: staticSecretDraftIdentityBindingKey(input.ownerSubjectId, input.connectorId, identity),
    sourceKind: "account",
  });
  if (draft) {
    return existingIdentityBindingOrThrow(draft, input.connectorId, identity);
  }
  const verified = await input.store.getByBinding({
    connectorId: input.connectorId,
    ownerSubjectId: input.ownerSubjectId,
    sourceBindingKey: staticSecretVerifiedIdentityBindingKey(input.ownerSubjectId, input.connectorId, identity),
    sourceKind: "account",
  });
  if (verified) {
    return existingIdentityBindingOrThrow(verified, input.connectorId, identity);
  }
  return findLegacyStaticSecretIdentity(input.store, input.connectorId, input.ownerSubjectId, identity, identityField);
}

function existingIdentityBindingOrThrow<T extends StaticSecretIdentityInstance>(
  existing: T,
  connectorId: string,
  identity: string
): T {
  if (existing.status === "revoked") {
    throw staticSecretIdentityConflictError(
      `The '${connectorId}' connection for provider identity '${identity}' is revoked; refusing to reactivate it silently.`,
      "static_secret_identity_revoked"
    );
  }
  return existing;
}

async function findLegacyStaticSecretIdentity<T extends StaticSecretIdentityInstance>(
  store: StaticSecretIdentityStore<T>,
  connectorId: string,
  ownerSubjectId: string,
  identity: string,
  identityField: StaticSecretIdentityField
): Promise<T | null> {
  const active = await store.listActiveByConnector(ownerSubjectId, connectorId, { limit: 500 });
  const matches = active.filter((instance) => matchesStaticSecretIdentity(instance, identity, identityField.name));
  if (matches.length > 1) {
    throw staticSecretIdentityConflictError(
      `More than one active '${connectorId}' connection already claims this provider identity; refusing to create another connection.`,
      "static_secret_identity_ambiguous"
    );
  }
  return matches[0] ?? null;
}

function matchesStaticSecretIdentity(
  instance: StaticSecretIdentityInstance,
  identity: string,
  identityFieldName: string
): boolean {
  const binding = objectRecord(instance.sourceBinding);
  if (binding?.kind !== "static_secret") {
    return false;
  }
  const verified = staticSecretVerifiedIdentityFromBinding(binding);
  return verified
    ? verified === identity
    : staticSecretSetupFieldsFromBinding(binding)?.[identityFieldName] === identity;
}
