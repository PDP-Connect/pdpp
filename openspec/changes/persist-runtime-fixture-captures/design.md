## Context

Fixture capture is diagnostic infrastructure for connector repair. It is not part of PDPP Core, but it materially affects reference-implementation reliability because capture initialization runs before connector collection starts.

The observed failure was a live reference stack whose capture bind mount pointed to a deleted temporary deploy worktree. Connector children stalled before emitting useful progress. Restarting from a stable checkout repaired the mount, but relying on deploy-directory hygiene is the wrong boundary.

## Decision

`createCaptureSession()` accepts a configured root via `PDPP_CAPTURE_ROOT_DIR`. If unset, local development continues to write under the package-local `fixtures/` directory.

The composed reference stack sets `PDPP_CAPTURE_ROOT_DIR=/root/.pdpp/fixture-captures`, which is inside the existing persistent `pdpp-home` Docker volume. The stack no longer bind-mounts package `fixtures/` into the reference container.

## Alternatives

- Keep the checkout bind and document "do not delete deploy worktrees": rejected because it leaves runtime health coupled to operator cleanup.
- Use a new Docker named volume mounted over package `fixtures/`: rejected because it shadows committed package fixtures inside the container and makes the path mean two different things.
- Disable capture in the reference stack: rejected because capture is useful repair evidence.

## Acceptance Checks

- Capture root can be overridden in a unit test.
- Docker compose config exposes the persistent capture root env.
- Connector capture remains best-effort and disabled unless capture mode is enabled.
