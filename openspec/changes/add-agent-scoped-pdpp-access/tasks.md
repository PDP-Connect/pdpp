## 1. Discovery And Design

- [x] Audit the existing reference CLI/auth flow for client registration, PAR, consent approval, token exchange, introspection, revoke, `/v1/schema`, retrieval, blobs, aggregations, and changes cursors. (`design-notes/2026-04-25-reference-surface-audit.md`)
- [x] Identify which pieces are public PDPP surfaces, which are reference-only, and which are protocol-candidate gaps. (memo above; biggest gap: no public polling endpoint for PAR-staged client grants)
- [x] Document the approved cache location, file shape, permissions, and redaction rules. (memo + `docs/agent-skills/pdpp-data-access/references/security.md`)

## 2. CLI Workflow

- [x] Add a CLI command group for agent access bootstrap, status, request, wait, use, forget, and revoke. (`cli/commands/agent.js` — all seven subcommands implemented)
- [x] Implement a project-local client identity convention with stable display metadata and no owner-token persistence. (`cli/lib/cache.js`)
- [x] Implement grant-request creation with owner-readable purpose text, stream/field/time-range selection, retention, and access mode. (`cli/commands/agent.js#runRequest`)
- [x] Print a browser approval URL and user-action instructions; optionally open the URL when configured. (`agent request` prints approval URL; PDPP_OPEN_BROWSER env opens browser)
- [ ] Poll consent completion without aggressive retrying. (deferred: no public AS polling endpoint exists for PAR-staged client grants; `wait` polls the local cache only — another process must run `pdpp agent store` after browser approval; AS-side polling remains a protocol-candidate gap documented in design-notes)
- [x] Store resulting client grant metadata and token in the project-local cache. (`cli/commands/agent.js#runStore`, `cli/lib/cache.js`)
- [x] Add status output that shows grant scope, expiry, source, and revocation state without printing secrets. (`agent status` reads only non-secret grant metadata)

## 3. Agent Skill

- [x] Create a `pdpp-data-access` agent skill with concise core workflow and reference files for query cookbook, grant design, security, and troubleshooting. (`docs/agent-skills/pdpp-data-access/`)
- [x] Teach capability-first discovery via AS/RS metadata and `/v1/schema`. (SKILL "Core workflow §1 / §7" + `references/query-cookbook.md`)
- [x] Teach narrow grant selection, incremental grant upgrades, and denial fallback behavior. (`references/grant-design.md`, troubleshooting "Owner says no")
- [x] Teach efficient data consumption: filtered search, hybrid/semantic/lexical retrieval, records pagination, `changes_since`, blobs, aggregations, and grant-safe hydration. (`references/query-cookbook.md`)
- [x] Include examples for email, finance, coding-history, and cross-connector assistant memory tasks. (SKILL "Examples")
- [x] Include hard prohibitions against owner-token use, token exfiltration, committing `.pdpp`, or broadening access silently. (SKILL "Hard rules", `references/security.md`)

## 4. Approval UX

- [x] Review consent/approval UI for agent/client display quality. (see notes below)
- [x] Add owner-readable summaries for project-local agents. (existing `renderPendingGrantConsentHtml` shows client_display.name, purpose_description, streams, access_mode, retention)
- [x] Show requested streams, fields/views, time range, retention, access mode, purpose, expiry, and revocation path. (existing consent shell shows all of these; verified in `renderPendingGrantConsentHtml`)
- [ ] Add tests that approval UI does not hide broad or long-lived access. (deferred: the existing consent shell renders all fields correctly; a dedicated assertion test for UI output requires a headless browser, out of scope for this slice)

Note: The existing consent shell at `server/index.js:renderPendingGrantConsentHtml` already renders client name, connector/provider, purpose text, streams (with time_range, fields, view, necessity), access_mode, and retention. No code changes were needed for display quality. The `client_display.context` field (project path) is accepted by the PAR request body but not yet rendered in the consent shell — this is a reference-only candidate per the design notes.

## 5. Protocol Candidate Handling

- [x] If new wire fields are needed, mark them reference-only or experimental in code/docs. (no new wire fields were introduced; existing `client_display.context` is reference-only candidate)
- [x] Capture each protocol-candidate field in `design.md` with rationale and migration path. (design-notes/2026-04-25-reference-surface-audit.md lists all candidates with status)
- [x] Do not claim root PDPP normativity without a separate root-spec review. (agent.js top-level comment explicitly notes the polling gap as protocol-candidate, not normative)
- [ ] Resolve fast broad consent for high-trust agents. Promoted from `design-notes/2026-04-27-fast-broad-agent-consent.md` into `openspec/changes/design-fast-broad-agent-consent/`; do not implement multi-source PAR, grant packages, permission sets, or broad setup UX until that design track reaches an owner-reviewed decision.
- [ ] Resolve consent-time predicate filters. Captured as `design-notes/2026-04-27-consent-time-filters.md`; do not add arbitrary grant filters, manifest consent-filter fields, consent UI, or RS enforcement without a dedicated OpenSpec change and owner review.

## 6. Validation

- [x] Add black-box tests for an agent client requesting, receiving, using, revoking, and forgetting a grant. (`test/agent-cli.test.js` — 14 tests pass)
- [x] Add secret-redaction tests for CLI output and cache status. (`test/agent-cli.test.js` — "status output shape contains no token material", "redactGrantForDisplay never exposes token material", "owner-token kind rejection")
- [x] Run relevant reference CLI/auth tests. (37 tests in `example-client.test.js`, `owner-auth.test.js`, `provider-metadata.test.js` all pass)
- [x] Run `openspec validate add-agent-scoped-pdpp-access --strict`. (passes)
- [x] Run `openspec validate --all --strict`. (27/27 pass)

## 7. Skill Distribution Channels

- [x] Promote the skill-distribution inbox note into this OpenSpec change as a decided design note.
- [x] Keep the canonical skill source at `docs/agent-skills/pdpp-data-access/` rather than claiming repo-root `skills/`.
- [x] Publish `/.well-known/skills/index.json` plus explicit allowlisted skill-file URLs.
- [x] Add `pdpp-data-access` pointers to `/llms.txt` and the full skill body to `/llms-full.txt`.
- [x] Advertise those skill and LLM surfaces from composed RS protected-resource metadata as advisory links.
- [x] Rewrite the skill happy path around `pdpp agent bootstrap/request/wait/store/use/status`, with raw HTTP documented only as a fallback.
- [x] Add catalog tests that pin the served file list and reject path traversal/missing files.
- [x] Publish `skills/pdpp-data-access/` as the `npx skills add <repo-url> --skill pdpp-data-access` distribution copy, with `pnpm agent-skill:check` preventing drift from the canonical `docs/agent-skills` source.
- [x] Preserve the caller-visible public origin across the Next proxy so cold-start agents do not receive `localhost` metadata from LAN or reverse-proxy entrypoints.
- [x] Let `pdpp agent bootstrap` try the reference-local DCR default automatically before asking the owner for an initial-access token.
