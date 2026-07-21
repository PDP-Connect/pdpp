/**
 * Server-side adapter for the static-secret credential probe.
 *
 * The pure probe orchestration (`probeCredential`) and the live transport both
 * live in `@pdpp/polyfill-connectors` (the connector package owns the provider
 * dependency: imapflow for Gmail, the GitHub `fetch` shape). This adapter is the
 * single seam the owner-session capture route consumes: it builds the live
 * transport for the connector, runs the probe, and maps the result to the
 * route's typed `{ ok }` shape — turning a thrown `CredentialProbeError` into a
 * non-throwing `{ ok: false, code, message }` so the route can reject without
 * storing.
 *
 * The probe + transport are injected so the route stays transport-agnostic and
 * tests inject deterministic doubles directly (this adapter is never imported
 * under test). Nothing here logs or returns the secret.
 */

/**
 * Build the route-facing `probeStaticSecretCredential(input)` function.
 *
 * @param {object} deps
 * @param {(args: { connectorKey: string, context: object, secret: string, transport: object }) => Promise<{ identity: string, detail?: string|null }>} deps.probeCredential
 *   the pure probe orchestration from the connector package.
 * @param {(connectorKey: string) => boolean} deps.hasCredentialProbe
 *   true when the connector advertises a synchronous probe.
 * @param {(connectorKey: string) => object} deps.createLiveCredentialProbeTransport
 *   the live transport factory from the connector package.
 * @returns {(input: { connectorKey: string, context: object, secret: string }) => Promise<object>}
 */
export function createStaticSecretCredentialProber({
  probeCredential,
  hasCredentialProbe,
  createLiveCredentialProbeTransport,
}) {
  if (
    typeof probeCredential !== 'function' ||
    typeof hasCredentialProbe !== 'function' ||
    typeof createLiveCredentialProbeTransport !== 'function'
  ) {
    throw new TypeError(
      'createStaticSecretCredentialProber requires probeCredential, hasCredentialProbe, and createLiveCredentialProbeTransport functions.',
    );
  }
  return async function probeStaticSecretCredential({ connectorKey, context, secret }) {
    // A connector with no synchronous probe self-reports skipped; the route
    // then preserves the first-sync activation path.
    if (!hasCredentialProbe(connectorKey)) {
      return { ok: true, skipped: true };
    }
    const transport = createLiveCredentialProbeTransport(connectorKey);
    try {
      const identity = await probeCredential({ connectorKey, context: context ?? {}, secret, transport });
      return { ok: true, identity: identity.identity, detail: identity.detail ?? null };
    } catch (err) {
      // CredentialProbeError carries an owner-causal, provider-named code +
      // message. Any other error is mapped to a generic, retryable failure so
      // the route still rejects without storing and without leaking detail.
      const code = typeof err?.code === 'string' ? err.code : 'credential_probe_failed';
      const message =
        typeof err?.message === 'string' && err.message.trim()
          ? err.message
          : 'Could not validate this credential right now. Try again in a moment.';
      const retryable = err?.retryable === true;
      return { ok: false, code, message, retryable };
    }
  };
}
