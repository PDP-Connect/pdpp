// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Declared-reason-token lookup — the ONE place the RS-side runtime
 * (`connector-gap-bounding.ts`'s `boundConnectorErrorMessage`) reads which
 * >=24-char snake_case tokens a connector's own thrown-error vocabulary is
 * allowed to keep verbatim through `stderr-redact.ts`'s `LONG_OPAQUE_RE`
 * entropy heuristic.
 *
 * Why this exists: `runtime/stderr-redact.ts`'s `declaredReasonTokens`
 * mechanism (added for a 2026-08-18 HEB incident —
 * `heb_session_failed: [REDACTED]`) was wired into `run-logger.ts` (internal
 * scheduler/executor logging) but never into `boundConnectorErrorMessage`,
 * the function that actually redacts `connector_error_json.message` before
 * it reaches a durable spine event and the owner's UI. That gap is why
 * Venmo's first live run (`run_1787101857760`, 2026-08-18) hit the SAME
 * defect the mechanism was built to fix: `venmo_session_failed: [REDACTED]:
 * Failed to fetch`, the eaten token being `venmo_probe_transport_error` (27
 * chars) — a categorical, PII-free fault-class name, not a secret.
 *
 * WHY THIS IS A MANIFEST READ AND NOT A REGISTRY
 * ----------------------------------------------
 * Which fault-class names a connector throws is a CONNECTOR FACT, so the
 * connector declares it, in the one place connectors already declare their
 * facts to the RI: `capabilities.declared_reason_tokens` in the manifest.
 *
 * This module previously held a hardcoded `Map` keyed by connector id whose
 * one entry imported `VENMO_DECLARED_REASON_TOKENS` straight out of
 * `packages/polyfill-connectors/src/auto-login/venmo.ts`. That is a literal
 * connector identity plus a direct cross-package import of connector code
 * into RI production source — both of which the zero-connector-knowledge
 * conformance guard forbids, and rightly: the RI would need a code change to
 * support the next connector that needs this.
 *
 * The token list is now read generically off whatever manifest the run
 * resolved. The RI never learns a connector name. A connector that declares
 * nothing gets `undefined` and therefore exactly today's
 * `boundConnectorErrorMessage` behavior, byte-identical — an absent
 * declaration is treated as an empty set, same as before.
 *
 * SAFETY: the >=24-char/snake_case shape is enforced at manifest REGISTRATION
 * time by `server/connector-manifest-validation.ts`'s
 * `validateDeclaredReasonTokensCapability`, not here. A declared token is an
 * instruction to skip redaction, so an unvalidated one would let a connector
 * declare a string matching its own live credential and have the runtime
 * print that credential into a durable event. Rejecting the manifest is the
 * correct place to stop that: it fails before the connector can ever run.
 * This function deliberately does not re-validate — a token that reached a
 * registered manifest already passed that gate, and a second, weaker copy of
 * the rule here would be the thing that drifts.
 */

/**
 * The manifest shape this lookup needs: nothing but the declared tokens.
 *
 * The index signature keeps this structurally compatible with the callers'
 * fuller `ConnectorManifest` types without importing one — this module reads
 * a single optional field and should not couple itself to the whole manifest
 * interface to do it.
 */
interface DeclaredReasonTokensManifest {
  readonly capabilities?: { readonly declared_reason_tokens?: unknown } | null;
  readonly [key: string]: unknown;
}

/**
 * Read the declared reason tokens off a resolved connector manifest.
 *
 * Returns `undefined` (not an empty Set) when the manifest declares none,
 * matching `StderrRedactionOptions.declaredReasonTokens`'s own optional shape
 * so a caller can spread this straight into `redactStderrTail`'s options
 * without an extra "is this empty" branch.
 *
 * Non-string and empty entries are skipped rather than throwing: this runs on
 * the terminal-error path, where throwing would replace the operator's real
 * failure with a manifest complaint. Registration already rejected those
 * shapes, so reaching one here means the manifest was bypassed, and the safe
 * answer is to redact more, never less.
 */
export function declaredReasonTokensFor(
  manifest: DeclaredReasonTokensManifest | null | undefined
): ReadonlySet<string> | undefined {
  const declared = manifest?.capabilities?.declared_reason_tokens;
  if (!Array.isArray(declared)) {
    return;
  }
  const tokens = new Set<string>();
  for (const token of declared) {
    if (typeof token === "string" && token.length > 0) {
      tokens.add(token);
    }
  }
  return tokens.size > 0 ? tokens : undefined;
}
