# Open question: connector configuration surface

**Status:** open
**Raised:** 2026-04-19
**Context:** while building the Claude Code connector we discovered several knobs we'd want user-configurable (content preview cap, project-dir include/exclude, stream selection). Today those land as ad-hoc env vars. The fleet is going to grow more of these quickly (Gmail label filters, Amazon year floor, Reddit subreddit allowlist, USAA account allowlist, Slack channel scopes…). We need a principled answer before adding another.

## Current state (accidental, not designed)

Each connector grows its own env-var namespace, documented only in its header comment:

| Connector | Config knob | Surface |
|---|---|---|
| claude_code | `CLAUDE_CODE_PROJECTS_DIR` | env |
| claude_code | `CLAUDE_CODE_PROJECT_INCLUDE` / `_EXCLUDE` | env (added today) |
| ynab | `YNAB_PAT` | env |
| reddit | `REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD` | env |
| gmail | `GMAIL_USER` / `GMAIL_APP_PASSWORD` / `GMAIL_IMAP_HOST` | env |
| usaa | `USAA_MEMBER_ID` / `USAA_PASSWORD` | env |
| chatgpt | `CHATGPT_EMAIL` / `CHATGPT_PASSWORD` | env |

Credentials and tuning knobs share the same layer. Both leak into every child process via `process.env`. There's no manifest-declared schema for either, so orchestrators can't surface them as UI, CLI flags, or consent-card detail.

## What we actually need to answer

1. **Who authors the config — user, manifest, or client?**
   - User-authored (credentials, scope knobs like project-include): must not appear in the manifest registry; should live next to the grant.
   - Manifest-authored (default content caps, stream definitions): fixed at publish time; Collection Profile already covers this via `consent_time_field`, `schema`, etc.
   - Client-authored (per-run scope): already handled by `START.scope` — time_range, resources, fields.

2. **Is "config" a subset of `START.scope` or a sibling?**
   - Scope governs *what data comes back* (already enforced by runtime: resources filter, fields filter, time_range).
   - Config governs *how the connector gets there* (IMAP host, project-dir exclude, pagination behavior). Runtime can't validate it — it's connector-private.
   - Strawman: rename config to `connector_options`, ship it alongside `scope` in START, manifest declares a JSON-Schema for validation.

3. **Where does credentials authority sit?**
   - Today: env vars read from `.env.the owner.local` at orchestrator startup. Simple for single-user polyfill, wrong for multi-tenant.
   - Future: credentials should arrive via the owner's `grant_id` — the AS looks up stored secrets, the runtime injects them into the connector's env (or stdin) at START time. Manifest declares `credentials_schema`.

4. **Does configurability belong in the Collection Profile spec, or is it a Polyfill Runtime concern?**
   - Collection Profile today is message-shape + validation. It doesn't mandate an env-var layer.
   - Argument for spec: connector portability. If a manifest moves between personal servers (Vercel-hosted PDPP → self-hosted), its config schema must travel with it.
   - Argument against: the spec is about the wire protocol between AS/RS and connector. How secrets materialize inside the connector process is orchestrator-specific.

## Candidate direction (to review, not decided)

- **Manifest declares two optional schemas:** `credentials_schema` (JSON-Schema of required secrets) and `options_schema` (JSON-Schema of tuning knobs with defaults).
- **Credentials are grant-scoped**, injected by the AS at grant time and forwarded via runtime as connector env (never logged, never spine-persisted).
- **Options are scope-scoped**, passed on `START.connector_options` alongside `scope`. Runtime validates against `options_schema` before spawning the connector.
- **Consent card** can render declared options as user-tunable toggles (e.g. "include SillyTavern sessions: off/on"), tightening the authorship principle: manifest authors the knob, user authors the value.
- **Runtime enforces no leakage**: credentials never appear in `spine_events.data_json`; options are captured at run start and frozen in the spine.

## What happens if we don't decide

- Every new connector invents its own env-var namespace, none are discoverable.
- Moving a polyfill manifest to a different runtime requires reading its source to learn the env contract.
- Consent card can't show options at all; spec's promise of "user sees and consents to what will happen" weakens every time we add a knob.
- Multi-tenant personal servers are impossible — global env vars don't separate by owner.

## Blockers before deciding

- Want a second pass from ChatGPT + Gemini on the credentials-grant flow (parallel to the consent-card review).
- Need to inventory all existing env vars across the 28 manifests and classify them (credential vs. option vs. debug).
- Should cross-check whether existing OAuth-pattern connectors (Spotify, Strava, Reddit) already have a cleaner path via token exchange that we can generalize.

## Action items (paused, awaiting direction)

- [ ] Inventory env-var usage across all connectors.
- [ ] Draft `credentials_schema` + `options_schema` manifest fields as a spec RFC.
- [ ] Prototype option schema in one connector (claude_code is a good candidate — already has 3 knobs).
- [ ] Decide: Collection Profile spec change vs. Polyfill Runtime convention.

## Worked example: Slack

The Slack connector exercises this problem concretely — slackdump exposes ~8 operator knobs (lookback, channel types, channel allowlist/blocklist, member-only, skip files, etc.). See `packages/polyfill-connectors/connectors/slack/index.js` for the env-var contract used today. The connector reads options via `src/connector-options.js#readOptions`, which already accepts `START.connector_options` — when the manifest field lands, the connector doesn't change.
