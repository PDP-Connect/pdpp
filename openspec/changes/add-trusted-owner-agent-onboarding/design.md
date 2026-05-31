## Context

The reference already has two adjacent but different agent access paths.

- Grant-scoped agents use the `pdpp-data-access` workflow: discover metadata, request a scoped client grant, cache the client token locally, and avoid owner bearer tokens.
- Owner/operator automation can issue owner bearers through the dashboard deployment-token flow. Those tokens work on owner-level REST surfaces and are intentionally rejected by `/mcp`.

the owner's Daisy use case is the second profile: a trusted local LLM at `~/applications/daisy` should be able to start from an entrypoint URL, discover how the reference instance works, ask the owner to approve full local-owner access, and then maintain an efficient local view of current and future owner data. Treating that as "just use MCP" is wrong: MCP is the grant/client surface for external clients. Treating it as an unstructured owner-token paste is also wrong: it loses discovery, approval, revocation, and audit.

## Goals / Non-Goals

**Goals:**

- Define a reference-specific trusted owner-agent profile that is explicit, discoverable, and separate from the default grant-scoped agent path.
- Let a local agent begin from `GET /`, `/.well-known/oauth-protected-resource`, or `/.well-known/oauth-authorization-server` and learn the correct next step without route guessing.
- Preserve owner control: approval happens in a browser/dashboard context, bearer material is not printed into chat, and revocation remains visible.
- Preserve the route boundary: owner-agent credentials authorize owner-level REST/control-plane flows where owner bearer auth is supported; `/mcp` remains grant/client-scoped.
- Make "all current and future data" token-efficient by teaching the agent to use metadata, stream discovery, `connection_id`, cursors, `changes_since`, blobs by reference, and event subscriptions or polling.

**Non-Goals:**

- Do not change PDPP Core semantics or present owner-agent onboarding as a protocol requirement.
- Do not allow owner bearers over `/mcp`.
- Do not weaken the default `pdpp-data-access` guidance for ordinary coding agents, external assistants, or task-scoped clients.
- Do not implement cross-source grants or broad client-authored consent packages in this change.
- Do not require a new dependency or local daemon in Daisy for the first tranche.

## Decisions

### 1. Define two agent profiles, not one overloaded path

The reference should name two profiles:

- **Grant-scoped agent**: a client acts under a PDPP grant and should use client tokens, MCP, and least-privilege access.
- **Trusted owner agent**: a local agent acts as the operator and may receive an owner credential after explicit owner approval.

Rationale: this resolves the apparent conflict between "agents should not use owner tokens" and "Daisy should have full access." Both are true for different trust boundaries. The default remains scoped grants; the owner-agent path is a deliberate local-admin mode.

Alternative considered: make Daisy use a maximal package grant over MCP. Rejected for this use case because the owner wants current and future local-owner automation across all data and management surfaces, while MCP is intentionally grant-scoped and external-client-oriented.

### 2. Use discovery metadata as the onboarding entrypoint

The reference should advertise a `pdpp_owner_agent_onboarding` advisory block in protected-resource metadata and the cold-start root pointer when owner-token issuance is enabled. The block should include:

- profile name and warning that this is owner-level local automation;
- AS and RS origins;
- owner approval URL or dashboard route;
- device authorization, token, introspection, revocation, and DCR endpoints when applicable;
- schema, streams, query base, blobs, and event-subscription discovery links;
- the statement that `/mcp` rejects owner bearers and that grant-scoped MCP remains the ordinary external-client path.

Rationale: Daisy can start from an entrypoint URL and derive the flow. The metadata is advisory reference behavior, not PDPP Core normativity.

Alternative considered: add a Daisy-specific route. Rejected as too narrow; the profile should work for any trusted local owner agent.

### 3. Approval is browser-mediated and token material is non-printing

The owner-agent flow should reuse the existing device-authorization / dashboard approval shape where possible. The local agent can initiate or be instructed to initiate a request, but the owner approves in the dashboard. The successful flow should write token material to a local agent credential store or copy target under owner control; UI and CLI output should print only non-secret status, token kind, subject, expiry, and revocation handle.

Rationale: this keeps the smooth "tell Daisy to set it up" experience without training users to paste bearer tokens into chat.

Alternative considered: dashboard page shows a bearer for the owner to paste. Rejected as acceptable only for low-level debugging, not the SLVP onboarding path.

### 4. Owner-agent tokens remain REST/control-plane credentials, not MCP credentials

Owner-agent tokens should continue to work on owner-level REST/query surfaces that already accept owner bearers. `/mcp` should reject owner bearers with a clear error that points to grant-scoped MCP setup for external clients and owner-agent REST setup for local owner agents.

Rationale: MCP tool sessions are client/grant artifacts. Allowing owner bearers over MCP would collapse the consent/disclosure boundary and make a local-admin credential look like an ordinary client grant.

Alternative considered: add owner-mode MCP tools. Rejected for this change. If future owner-mode MCP is desired, it needs a separate design with a different tool namespace, explicit local-only assumptions, and a separate security review.

### 5. Efficient local sync is part of onboarding, not an afterthought

The owner-agent profile should require an agent runbook/skill section that tells Daisy to:

- fetch metadata first, then `/v1/schema`;
- enumerate streams and connections and store stable `connection_id` cursors locally;
- use `changes_since`, pagination, declared filters, and field projections instead of broad rescans;
- fetch blobs only when needed through `blob_ref.fetch_url`;
- use event subscriptions when it has a durable HTTPS receiver; otherwise poll with stored cursors and backoff;
- re-check schema and stream metadata periodically so new streams/connections become visible without guessing.

Rationale: "all current and future data" is only practical if the agent learns incrementally. A full rescan on every question is not token-efficient and will not meet the owner target.

## Risks / Trade-offs

- **Owner bearer is broad** -> Gate it behind explicit owner-agent labeling, browser-mediated approval, non-printing token handling, dashboard visibility, introspection, and revocation.
- **Users may confuse trusted owner agents with external clients** -> Metadata, docs, and UI must show the distinction: grant-scoped MCP for external clients; owner-agent REST for local owner automation.
- **Daisy may not have a durable HTTPS callback** -> The sync profile must support cursor polling as the baseline and event subscriptions only when a reachable callback exists.
- **Current dashboard token page may expose debug-oriented copy** -> The implementation tasks must review and adjust copy so the smooth path does not require copying bearer strings into chat.
- **This overlaps with broad agent consent work** -> Keep this change scoped to owner-local automation. It does not decide multi-source client consent, permission sets, or cross-source grant policy.

## Migration Plan

1. Add metadata and documentation without changing token semantics.
2. Add or adapt a local owner-agent runbook/skill so Daisy can follow the flow from an entrypoint URL.
3. Add tests that owner-agent metadata is present only when the deployment can support owner-token onboarding.
4. Add smoke tests proving owner bearer REST access still works and `/mcp` still rejects owner bearers.
5. Add a live Daisy/local-agent acceptance run once metadata, docs, and non-printing token handoff are implemented.

Rollback is straightforward for the first tranche: remove the metadata advisory block and docs/runbook. Existing owner-token issuance and `/mcp` rejection behavior remain unchanged.

## Open Questions

- Should the first implementation include a CLI command that writes Daisy's credential store directly, or should it rely on dashboard-mediated token creation plus a documented local file target?
- What exact local credential path should Daisy use under `~/applications/daisy`, and what file permissions should the reference require in its acceptance test?
- Should owner-agent tokens be long-lived by default, or should the dashboard force an expiry/rotation policy for local agents?
- Should the metadata include a machine-readable "full owner access" scope label, or is `pdpp_token_kind: owner` plus route documentation sufficient?
