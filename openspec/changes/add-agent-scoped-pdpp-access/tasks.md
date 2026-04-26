## 1. Discovery And Design

- [x] Audit the existing reference CLI/auth flow for client registration, PAR, consent approval, token exchange, introspection, revoke, `/v1/schema`, retrieval, blobs, aggregations, and changes cursors. (`design-notes/2026-04-25-reference-surface-audit.md`)
- [x] Identify which pieces are public PDPP surfaces, which are reference-only, and which are protocol-candidate gaps. (memo above; biggest gap: no public polling endpoint for PAR-staged client grants)
- [x] Document the approved cache location, file shape, permissions, and redaction rules. (memo + `docs/agent-skills/pdpp-data-access/references/security.md`)

## 2. CLI Workflow

- [ ] Add a CLI command group for agent access bootstrap, status, request, wait, use, forget, and revoke.
- [ ] Implement a project-local client identity convention with stable display metadata and no owner-token persistence.
- [ ] Implement grant-request creation with owner-readable purpose text, stream/field/time-range selection, retention, and access mode.
- [ ] Print a browser approval URL and user-action instructions; optionally open the URL when configured.
- [ ] Poll consent completion without aggressive retrying.
- [ ] Store resulting client grant metadata and token in the project-local cache.
- [ ] Add status output that shows grant scope, expiry, source, and revocation state without printing secrets.

## 3. Agent Skill

- [x] Create a `pdpp-data-access` agent skill with concise core workflow and reference files for query cookbook, grant design, security, and troubleshooting. (`docs/agent-skills/pdpp-data-access/`)
- [x] Teach capability-first discovery via AS/RS metadata and `/v1/schema`. (SKILL "Core workflow §1 / §7" + `references/query-cookbook.md`)
- [x] Teach narrow grant selection, incremental grant upgrades, and denial fallback behavior. (`references/grant-design.md`, troubleshooting "Owner says no")
- [x] Teach efficient data consumption: filtered search, hybrid/semantic/lexical retrieval, records pagination, `changes_since`, blobs, aggregations, and grant-safe hydration. (`references/query-cookbook.md`)
- [x] Include examples for email, finance, coding-history, and cross-connector assistant memory tasks. (SKILL "Examples")
- [x] Include hard prohibitions against owner-token use, token exfiltration, committing `.pdpp`, or broadening access silently. (SKILL "Hard rules", `references/security.md`)

## 4. Approval UX

- [ ] Review consent/approval UI for agent/client display quality.
- [ ] Add owner-readable summaries for project-local agents.
- [ ] Show requested streams, fields/views, time range, retention, access mode, purpose, expiry, and revocation path.
- [ ] Add tests that approval UI does not hide broad or long-lived access.

## 5. Protocol Candidate Handling

- [ ] If new wire fields are needed, mark them reference-only or experimental in code/docs.
- [ ] Capture each protocol-candidate field in `design.md` with rationale and migration path.
- [ ] Do not claim root PDPP normativity without a separate root-spec review.

## 6. Validation

- [ ] Add black-box tests for an agent client requesting, receiving, using, revoking, and forgetting a grant.
- [ ] Add secret-redaction tests for CLI output and cache status.
- [ ] Run relevant reference CLI/auth tests.
- [ ] Run `openspec validate add-agent-scoped-pdpp-access --strict`.
- [ ] Run `openspec validate --all --strict`.
