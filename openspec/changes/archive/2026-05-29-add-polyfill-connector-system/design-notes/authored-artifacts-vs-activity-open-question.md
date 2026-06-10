# Open question: authored artifacts vs activity streams

**Status:** open
**Raised:** 2026-04-19
**Trigger:** Layer 2 audits across all 7 connectors reviewed to date (Gmail, YNAB, USAA, GitHub in `layer-2-coverage-gmail-ynab-usaa-github.md`; ChatGPT, Claude Code, Codex in `layer-2-coverage-chatgpt-claude-codex.md`) found the same top-ranked gap in every one: we capture **activity streams** (what the user did) but omit **authored artifacts** (what the user built to shape their tools).

## The pattern

| | Activity streams | Authored artifacts |
|---|---|---|
| Volume | High (thousands → millions) | Low (tens → hundreds) |
| Mutation | Append-only (sometimes tombstones) | Mutable; edited over time |
| Cursor | Timestamp / monotonic | Revision or content-hash |
| Consent weight | Sensitive by volume (bulk access) | Sensitive by leverage (encodes user strategy) |
| Disclosure framing | "Your Gmail messages" | "Your custom ChatGPT prompts" |
| Restoration | Server retains source of truth; re-collectable | Lost forever if not preserved |

Concrete instances flagged as P0 gaps in the Layer 2 audits:

- **ChatGPT** — `custom_gpts` (`/gizmos/mine`), `custom_instructions` (`/user_system_messages`). Current manifest has `conversations` + `memories` but no authored-GPT surface.
- **Claude Code** — `skills/*/SKILL.md`, `commands/*.md`, `projects/<p>/memory/*.md`. Current manifest captures session jsonl transcripts only.
- **Codex** — `prompts/*.md`, `skills/*/SKILL.md`, `rules/default.rules`. Current manifest captures rollout jsonl only.
- **Gmail** — `users.settings.filters`, vacation responder, forwarding rules. Current manifest is message envelopes.
- **USAA** — user-configured alert preferences, bill-pay payee list. Current manifest is posted activity.
- **GitHub** — authored gists, notification subscription config. Current manifest is `user` / `repositories` / `starred`.
- **YNAB** — categories + payee renaming rules are authored-ish (line blurs with state).

## Why this is a spec-level question

- **Stream semantics today capture data shape, not authorship origin.** `spec-core.md` §6 defines exactly two values on `streams[].semantics`: `append_only` and `mutable_state`. Authored artifacts and activity streams can both be `mutable_state` (settings, custom GPTs) or both be `append_only` (messages, gist revisions). The axis the audits surfaced is orthogonal to the one the spec models.
- **Consent presentation has no vocabulary for it.** Manifests currently rely on `display.detail` prose to convey "this includes your authored work" vs "this includes your activity." There is no structured field a client UI could key off.
- **Restoration guarantees differ fundamentally.** Activity can be re-collected from the source; authored artifacts are gone if the user loses the export. The spec does not currently distinguish.
- **Disclosure weight differs.** The ethical frame for losing an email archive is not the same as losing a user's system prompts; the spec gives both the same surface.

## Candidate resolutions

### A. New manifest field `origin: "activity" | "authored" | "computed"`
Streams declare origin explicitly alongside `semantics`. Pro: cheap, additive, unblocks consent copy and future preservation policy. Con: another axis for authors to reason about; boundary cases (Gmail filters applied to an authored rule list) need guidance.

### B. A new top-level concept: "Artifact Streams"
Parallel to Collection Profile streams, separately spec'd, with stronger preservation and disclosure guarantees. Pro: sharpest contract. Con: doubles the data-model surface; most runtimes would have to handle both identically anyway.

### C. Leave origin implicit, rely on stream descriptions
Manifests describe their streams naturally; clients and UIs infer class from language. Pro: no spec change. Con: the Layer 2 audits just demonstrated that without a structured cue, every author forgets the authored class.

### D. Conventional naming (e.g., `<source>_settings`, `<source>_customizations`)
Pattern without spec enforcement. Pro: zero ceremony. Con: no lever for the consent card or retention policy to act on.

## Cross-cutting observations

- Connects to `layer-2-completeness-open-question.md` — if a manifest omits authored artifacts, is it "complete"? Completeness and origin are separable but co-arrive.
- Connects to `credential-storage-open-question.md` — authored artifacts and credentials are the two classes of payload a user can't re-collect from the source.
- Connects to `rs-storage-topology-open-question.md` — authored artifacts may warrant different retention, backup, and partitioning than high-volume activity streams.

## Action items
- [ ] Decide on an origin-axis approach before adding authored-artifact streams to existing connectors.
- [ ] If resolution A wins, audit existing manifests and add `origin` to every declared stream.
- [ ] Update consent-card copy guidance to distinguish these two classes regardless of which resolution wins.
