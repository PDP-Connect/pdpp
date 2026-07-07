## Context

Connection health recovers credential-specific signals from generic terminal run failures so a flattened 401/403 can still route to owner credential repair. That behavior is correct for actual auth failures, but it was too broad for source availability failures.

The live USAA run had:

- a stored credential row;
- a generic top-level failure reason;
- a known gap with a `refresh_credentials` recovery hint;
- message text containing `source_unavailable`.

The owner-facing result became `credentials_required`, even though the source evidence said the provider login system was unavailable rather than credential-rejected.

The root cause was upstream of the dashboard projection. Browser-backed connectors pass a `retryablePattern` into the shared connector runtime. USAA's pattern already includes `source_unavailable`. However, failures thrown from `ensureSession` were wrapped by the session-establishment helper as `TerminalError(..., false)`, so the outer runtime catch never got to apply the connector pattern. The persisted terminal event therefore incorrectly carried a non-retryable credential-repair hint.

## Decision

Preserve connector retryability at the shared browser session-establishment boundary. When an `ensureSession` failure is wrapped as a terminal connector error, the wrapper SHALL apply the connector's retryability pattern to the original message and the prefixed terminal message. This keeps source-specific retryability declarations effective for browser connectors, including USAA's `source_unavailable` classifier.

Also treat `source_unavailable` as a veto for credential-reason recovery at the source-health projection boundary. This is a read-repair guard for already-persisted bad events and any future malformed generic terminal event. A generic failure can still become credential repair when the gap message is a definitive auth failure or the recovery hint is credential repair, but not when the same gap carries `source_unavailable`.

This keeps the connector contract general: connectors still declare retryability through the existing runtime pattern, and the reference projection still requires credential-rejection evidence before telling the owner to reconnect credentials. It does not change static-secret credential capture or ChatGPT session-repair semantics.

## Alternatives Considered

- Change the USAA connector only. Rejected because the connector already declares `source_unavailable` retryable; the shared runtime discarded that declaration during session establishment.
- Only fix the runtime. Rejected because old terminal events are already persisted and would keep misleading the owner until aged out or overwritten.
- Remove generic credential recovery entirely. Rejected because flattened ChatGPT/API 401 failures still need to route to credential repair.

## Acceptance Checks

- A browser session-establishment failure that matches a connector retryability pattern remains retryable after wrapping.
- A generic terminal run with a known auth 401 still projects credential repair.
- A generic terminal run with `source_unavailable` does not project credential repair, even if the gap has a `refresh_credentials` recovery hint.
- Existing runtime, connector, connection-health, and source-projection tests pass.
