# Connection Health Prior Art

## Status

Decided for this change. This note records the external patterns that informed the evidence model; the normative requirements live in the spec delta.

## Sources Reviewed

- Kubernetes Pod conditions use `type`, `status`, `reason`, `message`, `lastTransitionTime`, and `observedGeneration` to explain resource readiness without replacing the underlying spec or event stream.
- GitHub status checks distinguish in-progress execution status from completed conclusion and support detailed annotations for diagnostics.
- Temporal retry policy and failure history keep durable execution facts separate from retry/backoff scheduling.
- Fivetran connection status UX separates connection health, sync history, and alerts so setup problems are actionable.
- OpenTelemetry error guidance treats error classification as contextual and encourages typed error attributes.
- OAuth error responses establish a precedent for stable, safe error codes that do not disclose secrets.

## Lessons Applied

- Conditions are better than expanding a single status enum.
- Readiness and data health are not the same thing.
- Retry/backoff policy must not be treated as the source's data truth.
- Owner remediation should be structured, not embedded only in prose.
- Diagnostics need a sensitivity boundary before they reach UIs or APIs.

## Relevant References

- Kubernetes Pod Conditions: https://kubernetes.io/docs/concepts/workloads/pods/pod-condition/
- Kubernetes PodCondition API fields: https://kubernetes.io/docs/reference/kubernetes-api/core/pod-v1/
- GitHub status checks: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks
- OpenTelemetry HTTP span status guidance: https://opentelemetry.io/docs/specs/semconv/http/http-spans/
- Fivetran connector status: https://fivetran.com/docs/using-fivetran/fivetran-dashboard/connectors/status
- OAuth 2.0 RFC 6749: https://www.rfc-editor.org/rfc/rfc6749
