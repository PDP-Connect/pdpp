// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE normalizer for a manifest's `setup.credential_capture` block.
 *
 * Both authorities that need to know "is this connector static-secret, and
 * which fields carry the secret" must derive that from this module, not
 * re-implement the predicate:
 *   - Setup (`reference-implementation/server/connection-setup-plan.ts`)
 *     imports this to classify a connector and describe its capture form.
 *   - Runtime injection's generator
 *     (`packages/polyfill-connectors/scripts/generate-static-secret-registry.ts`)
 *     imports this to derive the env-var injection mapping.
 *
 * Before this module existed, setup and the generator each hand-rolled their
 * own field-normalization predicate. The two predicates looked equivalent but
 * silently disagreed on two shapes: a `type: "password"` field with no
 * explicit `secret: true` (setup treated it as secret, the generator did
 * not), and a secret field with no `label` (setup silently dropped it,
 * the generator kept it). Either asymmetry reproduces the exact venmo
 * failure class this file's callers exist to close: a manifest classified
 * static-secret by one side and invisible to the other, forever refusing to
 * inject or forever unable to present a capture form. Sharing this
 * normalizer by construction — one function, one set of rules — makes that
 * class of drift structurally impossible instead of merely tested against.
 *
 * This module is pure: no `node:fs`, no network, no provider-specific
 * knowledge, no runtime filesystem access. It only transforms the
 * `credential_capture` object already in hand. That purity is what lets the
 * publishable `@pdpp/local-collector` runtime slice depend on it (via the
 * generator, at build time) without pulling in manifest directory scanning.
 *
 * Field-label policy: a manifest's secret field is a UI/API contract, not
 * just data — `label` is the copy the owner sees when sealing that
 * credential. A secret field missing `label` cannot be presented, so it must
 * not silently vanish (as the pre-existing setup-side normalizer did) or
 * silently ship into the runtime injection registry as if it were fully
 * specified (as the generator did). Both would let one authority proceed on
 * a manifest the other authority cannot actually serve. Instead this throws
 * a `StaticSecretCredentialCaptureError` with the exact connector/field name,
 * which fails manifest generation (the generator throws uncaught -> CI red)
 * and fails manifest registration at the RI (registration is the one place
 * every manifest is normalized before any request can observe it — see
 * `reference-implementation/server/connector-manifest-validation.ts`).
 */

export type StaticSecretFieldType = "email" | "password" | "text";

const BUNDLED_STATIC_SECRET_CREDENTIAL_KINDS = new Set(["secret_bundle", "username_password"]);
const FULLY_BUNDLED_STATIC_SECRET_CREDENTIAL_KINDS = new Set(["secret_bundle"]);

export function isBundledStaticSecretCredentialKind(kind: string): boolean {
  return BUNDLED_STATIC_SECRET_CREDENTIAL_KINDS.has(kind);
}

/** True when every capture field, not only secret fields, is sealed into the credential bundle. */
export function isFullyBundledStaticSecretCredentialKind(kind: string): boolean {
  return FULLY_BUNDLED_STATIC_SECRET_CREDENTIAL_KINDS.has(kind);
}

export interface StaticSecretCredentialCaptureFieldLike {
  readonly autocomplete?: string | null;
  readonly description?: string | null;
  readonly env?: readonly string[] | null;
  readonly help_text?: string | null;
  readonly help_url?: string | null;
  readonly identity?: boolean | null;
  readonly label?: string | null;
  readonly name?: string | null;
  readonly placeholder?: string | null;
  readonly required?: boolean | null;
  readonly secret?: boolean | null;
  readonly type?: string | null;
}

export interface StaticSecretCredentialCaptureLike {
  readonly credential_kind?: string | null;
  readonly description?: string | null;
  readonly fields?: readonly StaticSecretCredentialCaptureFieldLike[] | null;
  readonly kind?: string | null;
  readonly label?: string | null;
  /**
   * Whether capturing this credential at all is mandatory. Defaults to
   * `true` (every existing manifest's actual behavior, preserved for
   * backward compatibility) — a manifest must explicitly opt in to
   * `required: false` to declare "an entirely blank submission is a valid,
   * complete choice" (e.g. Venmo, whose connector always has a
   * browser-driven sign-in fallback with zero saved credentials).
   *
   * This is BLOCK-level, distinct from and independent of each field's own
   * `required`. When `false`, a blank submission is accepted, but the
   * moment ANY field is filled, every field still marked `required: true`
   * on itself is enforced (BOTH-OR-NONE) — see
   * {@link NormalizedStaticSecretCredentialCapture.required}'s consumers
   * (`bundledSecretPayload` in the console, `assertBundledSecretNotEmpty` in
   * the RI) for where that enforcement actually happens; this module only
   * carries the fact.
   */
  readonly required?: boolean | null;
  readonly submit_label?: string | null;
}

export interface NormalizedStaticSecretField {
  readonly autocomplete: string | null;
  readonly description: string | null;
  readonly env: readonly string[];
  readonly helpText: string | null;
  readonly helpUrl: string | null;
  readonly identity: boolean;
  readonly label: string;
  readonly name: string;
  readonly placeholder: string | null;
  readonly required: boolean;
  readonly secret: boolean;
  readonly type: StaticSecretFieldType;
}

export interface NormalizedStaticSecretCredentialCapture {
  readonly description: string | null;
  readonly fields: readonly NormalizedStaticSecretField[];
  readonly kind: string;
  readonly label: string;
  /**
   * `false` only when the manifest explicitly says so; `true` for every
   * manifest that omits the fact (backward-compatible default). See
   * {@link StaticSecretCredentialCaptureLike.required} for the full
   * BOTH-OR-NONE contract this fact establishes.
   */
  readonly required: boolean;
  readonly submitLabel: string | null;
}

/** Thrown when a manifest's `credential_capture` violates the shared contract this module enforces. */
export class StaticSecretCredentialCaptureError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StaticSecretCredentialCaptureError";
    this.code = code;
  }
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeFieldType(raw: StaticSecretCredentialCaptureFieldLike): StaticSecretFieldType {
  const rawType = cleanString(raw.type)?.toLowerCase();
  if (rawType === "email" || rawType === "password" || rawType === "text") {
    return rawType;
  }
  // `type: "password"` implies secrecy even without an explicit `secret:
  // true` — a manifest author writing a password-shaped field is declaring
  // intent to capture a secret, and treating that as non-secret is the exact
  // shape that let a manifest satisfy setup's classifier while being invisible
  // to runtime injection.
  if (raw.secret === true) {
    return "password";
  }
  return "text";
}

function normalizeField(
  connectorKey: string,
  raw: StaticSecretCredentialCaptureFieldLike
): NormalizedStaticSecretField | null {
  const name = cleanString(raw?.name);
  if (!name) {
    return null;
  }
  const type = normalizeFieldType(raw);
  const secret = raw.secret === true || type === "password";
  const label = cleanString(raw?.label);
  if (!label) {
    if (secret) {
      throw new StaticSecretCredentialCaptureError(
        "static_secret_field_label_required",
        `Connector '${connectorKey}' credential_capture field '${name}' is a secret field (secret:true or ` +
          'type:"password") with no label. label is contract-required for a secret field: it is the copy the ' +
          "owner sees when sealing this credential, and a secret field with no presentation copy would classify " +
          "as static-secret for runtime injection while being unable to render a capture form for setup, or vice " +
          "versa. Add a label to this field in the manifest."
      );
    }
    return null;
  }
  const env = Array.isArray(raw.env) ? raw.env.filter((value): value is string => cleanString(value) !== null) : [];
  if (secret && env.length === 0) {
    throw new StaticSecretCredentialCaptureError(
      "static_secret_field_env_required",
      `Connector '${connectorKey}' credential_capture field '${name}' is a secret field with zero env aliases. ` +
        "A secret field with no env var name(s) can never be injected at runtime — add at least one entry to " +
        'this field\'s env array in the manifest, or remove secret:true/type:"password" if it is not actually a ' +
        "secret."
    );
  }
  return {
    autocomplete: cleanString(raw.autocomplete),
    description: cleanString(raw.description),
    env,
    helpText: cleanString(raw.help_text),
    helpUrl: cleanString(raw.help_url),
    identity: raw.identity === true,
    label,
    name,
    placeholder: cleanString(raw.placeholder),
    required: raw.required !== false,
    secret,
    type,
  };
}

/**
 * Normalizes one manifest's `setup.credential_capture` block. Returns `null`
 * when the manifest has no credential_capture, no declared kind, or no
 * secret field (i.e. it is not a static-secret connector at all) — those are
 * absence-of-declaration, not malformed-declaration, so they are not errors.
 *
 * Throws `StaticSecretCredentialCaptureError` when a field IS declared secret
 * but violates the contract both setup and runtime injection depend on
 * (missing label, zero env aliases) — see the module doc for why these fail
 * loud instead of silently dropping the field or the connector.
 *
 * `connectorKey` is used only for diagnostic messages; it does not affect
 * classification (a connector never needs special-casing here — see the
 * module doc).
 */
export function normalizeStaticSecretCredentialCapture(
  connectorKey: string,
  capture: StaticSecretCredentialCaptureLike | null | undefined
): NormalizedStaticSecretCredentialCapture | null {
  if (!capture || typeof capture !== "object") {
    return null;
  }
  const kind = cleanString(capture.credential_kind) ?? cleanString(capture.kind);
  if (!kind) {
    return null;
  }
  const fields = Array.isArray(capture.fields)
    ? capture.fields
        .map((field) => normalizeField(connectorKey, field))
        .filter((field): field is NormalizedStaticSecretField => field !== null)
    : [];
  if (!fields.some((field) => field.secret)) {
    return null;
  }
  return {
    description: cleanString(capture.description),
    fields,
    kind,
    label: cleanString(capture.label) ?? kind,
    required: capture.required !== false,
    submitLabel: cleanString(capture.submit_label),
  };
}
