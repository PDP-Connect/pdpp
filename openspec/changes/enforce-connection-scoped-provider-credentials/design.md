## Context

The owner-console design already states the durable rule: provider-account credentials are source-scoped. Deployment env may configure the reference instance, but it must not impersonate one provider account for every configured source.

The current static-secret run seam is only partially aligned. The low-level store resolver fails closed when a connection credential is missing or revoked, but the reference-server wrapper first checks credential metadata and returns `null` when no row exists. The controller and scheduler interpret `null` as "no setup material applies", so `runConnector` may fall back to `process.env`.

That fallback is useful for standalone connector execution and older direct-run tests. It is not acceptable for configured connector-instance runs, because the connection row already names a specific source.

## Goals / Non-Goals

**Goals:**

- Make the configured reference-server run path source-scoped by construction for static-secret/provider-account connectors.
- Preserve connection-scoped credential injection when a stored credential exists.
- Refuse configured static-secret runs before child spawn when no active source credential exists.
- Keep standalone connector env support intact outside the configured reference-server resolver.

**Non-Goals:**

- Do not redesign ChatGPT session reuse or browser profile persistence in this change.
- Do not remove connector-level env readers; child connectors still receive run-scoped env fragments.
- Do not add credential capture UI or post-login password persistence.
- Do not change provider-auth token flows or manual-upload import env handling.

## Decisions

### 1. Remove the metadata precheck from the reference-server static-secret resolver

The resolver will call `resolveStaticSecretRunEnv` for every static-secret connector. That function already recovers the connection credential and throws `credential_not_found` or `credential_revoked` when unavailable.

This keeps the fail-closed rule in one store-backed seam instead of duplicating metadata logic.

### 2. Keep `null` only for non-static-secret connectors and other setup-material families

`buildConnectionScopedRunEnvResolver` still tries provider-auth and manual-upload setup material when the static-secret resolver returns `null`. Static-secret connectors no longer return `null` for "missing credential"; they throw, so the run is refused and does not continue into unrelated fallback paths.

### 3. Preserve standalone connector env behavior

The child runtime still merges `process.env` and `staticSecretEnv`, with `staticSecretEnv` last. That is the right process boundary: direct connector development can use env, while configured reference runs supply connection-scoped env or fail before spawn.

### 4. Treat this as a correctness/honesty fix, not a ChatGPT-only patch

The problem is connector-family-level. ChatGPT exposed it because browser/session auth is noisy, but the same fallback would be wrong for Amazon, Chase, Gmail, GitHub, Reddit, Slack, USAA, or any future static-secret provider-account connector.

## Risks / Trade-offs

- Existing deployments that relied on deployment-wide provider env for configured source rows will now need to migrate/capture credentials per source. This is intentional; the old behavior could silently collect the wrong account.
- Some local operator workflows may see `credential_not_found` where a child previously ran. The mitigation is the existing env-to-store migration and source setup/reauthorization path.
- This does not prove ChatGPT browser-session reuse is healthy. It removes an unsafe fallback while separate ChatGPT auth/session tests continue to cover the immediate regression path.

## Migration Plan

No data migration is required. Operators with provider-account env credentials should capture/migrate those credentials onto the intended connection before running configured scheduled/manual refreshes.

Rollback is a code revert of the resolver behavior. Rolling back would restore the deployment-wide provider env fallback and should be treated as reintroducing the source-scoping bug.
