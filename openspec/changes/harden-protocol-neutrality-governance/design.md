## Context

The existing protocol design is already URI-federated and grant-pinned: connector identifiers and purpose codes are URIs, grants carry the resolved `manifest_version`, and resource servers enforce the resolved grant rather than depending on a live centralized registry lookup.

The change makes that posture explicit without changing protocol mechanics.

## Design

- Keep root spec files as the protocol authority.
- Add implementation-neutral language in standards prose, not marketing copy.
- Avoid adding a new registry dependency or implying that `pdpp.dev` is a required service.
- Keep governance wording repository-specific and factual: changes are proposed through public PRs and OpenSpec where required, and active maintainers/editors are listed in `MAINTAINERS.md`.
- Keep license wording layered: protocol specification text uses Community Specification License 1.0 (`Community-Spec-1.0`) with a repository pointer in `LICENSE-specs`; software package metadata uses Apache-2.0.

## Out Of Scope

- Changing connector identifier semantics.
- Making a registry authoritative for consent integrity.
- Changing any AS, RS, runtime, or site behavior beyond stale URL/copy cleanup.
- Changing copyright notices or adopting a broader formal governance policy.

## Acceptance Checks

- `openspec validate harden-protocol-neutrality-governance --strict`
- `pnpm spec:check`
- Site typecheck or the nearest repo script that covers touched site files.
- Grep confirms no stale Vana-domain protocol-site references remain in `apps/site/src` except intentionally retained source/repo links or fixtures.
- License pointers distinguish protocol specification text (`Community-Spec-1.0`), software packages (Apache-2.0), and general documentation (CC BY 4.0).
- Package metadata for repository software packages declares Apache-2.0.
