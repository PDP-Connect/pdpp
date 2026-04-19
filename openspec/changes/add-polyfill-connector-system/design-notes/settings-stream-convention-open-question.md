# Open question: normalized settings/preferences stream convention

**Status:** open
**Raised:** 2026-04-19
**Trigger:** Layer 2 audits (`layer-2-coverage-gmail-ynab-usaa-github.md`, `layer-2-coverage-chatgpt-claude-codex.md`) found every connector has user-authored settings, but each invents its own representation — or more often omits them. Cross-cutting #3 on the Gmail/YNAB/USAA/GitHub audit called settings "the single most systematically undercovered category."

## Examples across connectors

- **Gmail:** filters, vacation responder, forwarding addresses, auto-forwarding, quota.
- **Slack:** notification preferences, DND hours, status, sidebar config, muted channels.
- **YNAB:** currency format, date format, budget-view preferences.
- **Notion:** workspace settings, page-display preferences.
- **Claude Code:** `~/.claude/settings.json`, slash-command config, theme, enabled MCP servers, hooks.
- **Codex:** `~/.codex/config.toml`, per-project `trust_level` map, machine_id, installation_id.
- **GitHub:** notification settings, repository defaults, SSH/GPG keys (auth-adjacent), profile appearance.
- **USAA:** paperless preferences, alert thresholds, contact-on-fraud config.

## Why a convention matters

- **Portability.** "Export my settings" is a concrete use case the current manifest model doesn't express.
- **Consumer consistency.** "Show all notification prefs" currently requires connector-specific code against N shapes.
- **Service migration.** Gmail → Fastmail or Notion → Obsidian benefits from a comparable shape across tools.
- **Reviewability.** "Here's what you've customized across your tools" is more valuable than scattered blobs.

## Convention candidates

### A. Uniform schema for every connector's settings stream
One row per setting: `{id, key, category, value, value_type: "string" | "number" | "boolean" | "json" | "enum", value_enum_options, description, last_modified, source_connector}`. Pro: queryable across sources; portable; renders cleanly in disclosure UI. Con: nested/collection settings (Gmail filters, muted-channel lists) collapse into opaque JSON, losing typing where it matters most.

### B. Typed field-level schema per connector
Each connector declares its own settings schema (Gmail: `{vacation_enabled, vacation_message, forwarding_address, …}`). Pro: preserves fidelity, no JSON spelunking. Con: zero cross-connector portability; every new connector reinvents a bespoke table.

### C. Hybrid — convention-plus-typing
Uniform row shape (A) as baseline, plus optional per-connector typed *projections* where fidelity matters. Pro: cheap floor, expensive ceiling only where warranted. Con: two concepts to explain; authors may skip projections; unclear whether projections belong in the manifest or as query-layer sugar.

### D. No convention — connectors handle as they see fit
Status quo. Pro: no spec churn. Con: locks in the undercoverage Layer 2 identified; "export your settings" stays invisible.

## Complications

- Many settings are nested (Gmail filters: criteria + actions; Slack DND: window + exceptions).
- Some are themselves collections (muted channels, SSH keys, per-project trust map).
- Derived/computed values (quota usage) vs. authored (quota limit) erode a clean "what I customized" frame when mixed.
- Consent presentation: "includes your settings" is informationally dense but low-volume — arguable it should always be included and cheap to skim.

## Cross-cutting

- **Authored artifacts vs. activity streams.** Settings are pure authored artifacts, next to Custom GPTs / skills / slash commands (`layer-2-coverage-chatgpt-claude-codex.md` #1).
- **Layer 2 completeness** (`layer-2-completeness-open-question.md`). Settings are the single largest systematic undercoverage; a shape decision here moves several manifests at once.
- **Connector configuration** (`connector-configuration-open-question.md`). The proposed manifest `options_schema` shares the JSON-Schema-of-typed-knobs shape. Align so runtime options and user settings can share tooling.

## Action items

- [ ] Decide whether a convention (A or C) is worth the normalization cost, or accept per-connector freedom (B/D).
- [ ] If yes, draft the conventional schema and pilot on one connector (Claude Code or Codex — both have structured on-disk config that maps cleanly onto option A).
- [ ] Cross-check alignment with `options_schema` before either lands in the spec.
