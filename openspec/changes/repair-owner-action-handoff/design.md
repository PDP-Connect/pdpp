## Context

The source detail page already knows the current connection, the returned run id from a successful run-start, and the structured attention record that caused a connection-level owner prompt. The UI should not wait for a refreshed projection to rediscover a run it already knows about, and it should not infer the exact target from unrelated latest-run history.

The connector runtime also already has a clean split between owner-facing instruction strings and separate diagnostics. The defect is not the absence of diagnostics. It is that some owner-facing messages are still carrying those diagnostics verbatim.

## Decision

- Treat a successful or already-running run-start as a connection-scoped acknowledgement that must survive client-side revalidation.
- When structured attention carries a causative run id, surface it as a typed exact-sync target and link directly to `/syncs/<run_id>` instead of the generic runs index.
- Keep owner-facing assistance copy short and task-oriented, and keep the exact target separate from the CTA label.
- Keep raw URL/input/body-preview detail in diagnostic paths and failure evidence, not in the owner instruction string.

## Alternatives

- Rely only on refreshed active-run projection. Rejected: a short run can disappear before refresh observes it.
- Send every owner action to `/syncs`. Rejected: it loses the exact run context the UI already has and creates a generic fallback where the exact target is known.
- Move diagnostics into the owner message and redact later. Rejected: that is brittle and still leaks too much surface area.

## Out of Scope

- Investigating the brief Sources error-boundary flash from the live run is out of scope unless a root cause can be proven from code or logs.
- No auth taxonomy, manifest semantics, provider behavior, live data, deployment, or schedule changes.

## Acceptance Checks

- A started sync still shows a run link after refresh/revalidation.
- A known active/latest owner-action run links to `/syncs/<run_id>`, not `/syncs`.
- USAA manual-action copy stays concise and does not contain raw URL/input/body-preview telemetry.
- Regression tests prevent the same diagnostic leak from returning in other connectors.
