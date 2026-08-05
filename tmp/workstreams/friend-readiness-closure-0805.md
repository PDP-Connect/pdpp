# Friend-readiness closure report

Date: 2026-08-04

## Result

Implemented one proven correction. When the embedding model is unavailable because it is uncached and downloads are disabled, the deployment readiness panel now reports `warn` instead of `error`. The row explicitly says semantic retrieval is unavailable while lexical retrieval still works, and that this does not block basic self-hosted sharing.

This preserves real blockers: owner authentication, storage, protocol metadata, and other error rows still produce a blocked verdict.

## Evidence

- `openspec/specs/semantic-retrieval/spec.md` defines semantic retrieval as an independently advertised extension and states that lexical and semantic capability advertisements are independent.
- `apps/site/content/docs/spec-ext-lexical-search.md` defines lexical retrieval as an optional additive profile at `GET /v1/search`; its absence does not make a server non-Core-conformant.
- `deploy/docker/docker-compose.yml` documents embedding downloads as opt-out and describes the node as lexical-only when disabled.
- `apps/console/src/app/(console)/components/deployment-readiness-rows.ts` contained the misleading embedding-specific error branch; it is now warning-only.

The local-collector finding is proven but intentionally unchanged. `docs/operator/local-collector-runbook.md` still contains `/dashboard/device-exporters`, while the current console source uses `/device-exporters` and `docs/reference/voice-and-framing.md` says retired `/dashboard/**` paths are not compatibility routes. The audit assigns this to the separate route-fix lane, so this change does not duplicate it.

## Tests and checks

- `pnpm install --frozen-lockfile`: passed.
- Focused readiness tests: 43 passed.
- Changed-file lint/check: passed.
- `pnpm --dir apps/console types:check`: passed.
- `pnpm --dir apps/console check`: failed on 98 diagnostics across unrelated pre-existing console files; the changed readiness file’s formatting/lint issue was fixed and its isolated check passes.
- `pnpm typecheck` and root `pnpm lint` are not repository scripts.
- `git diff --check`: passed.

No deployment, publish, push, or live stack operation was performed.

## Commit

Committed the justified source and test changes with a conventional commit and `Assisted-by: AI` trailer.
