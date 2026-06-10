# Design gaps surfaced by slackdump

**Status:** open for consideration
**Raised:** 2026-04-19
**Context:** wrapping slackdump as a PDPP Slack connector surfaced several features in slackdump's CLI that map awkwardly (or not at all) to the Collection Profile spec today. Each is a signal that the spec may need a concept we haven't named.

## Gap 1: Entity-type taxonomy as a first-class scope dimension

Slackdump's `-chan-types public,private,im,mpim` lets the operator say "give me public channels and DMs but skip group DMs." This is **not** a `resources` filter (that's by ID) and **not** a `streams` filter (that's by record kind). It's a sub-type within a stream.

Analogous in other connectors:
- Gmail: label-class filter (INBOX vs SENT vs spam)
- Amazon: order class (physical vs digital vs subscribe-and-save)
- Reddit: submission vs comment
- USAA: account-type filter (checking vs credit vs savings)

PDPP could either:
- **(a) Collapse each sub-type into its own stream.** Slack becomes `messages_public_channels`, `messages_private_channels`, `messages_im`, `messages_mpim`. Pro: no new concept. Con: cartesian blowup; some sub-types really are the same thing with one bit different.
- **(b) Add `scope.streams[].categories` or similar.** Pro: elegant. Con: new spec surface; per-connector definition of categories; consent card has to render them.
- **(c) Punt to connector-options.** Pro: zero spec change; works today. Con: user can't inspect the choice via consent card; no enforcement at runtime.

Today we've chosen (c) by default (see `connector-configuration-open-question.md`). Slackdump argues (b) might be worth adding — it's a category the user genuinely cares about and should see before granting.

## Gap 2: "Member-only" as a permission-proxy filter

Slackdump's `-member-only` flag excludes channels the user *could* access but isn't a member of. It's not a security filter (the API enforces that) — it's an ergonomic filter that narrows to "channels the user actively participates in."

There's no PDPP concept for this. "Relevance" or "participation" filters are user-meaningful (they narrow the consent surface) but invisible to the spec.

Worth naming? Either as a scope dimension (`scope.streams[].only_participated = true`) or as an options_schema convention. Probably the latter.

## Gap 3: File-attachment handling as a first-class dimension

Slackdump's `-files=false` skips downloading file attachments even when messages reference them. This is a **size-controlling** knob, not a privacy knob — attachments can be large and the user may want metadata-only.

PDPP today would model this as either a separate stream (`messages` + `attachments`, grantable independently) or an option. Slackdump's CLI shows operators conflate "metadata vs. binary" more naturally than "two streams." Some precedent: Gmail already has `attachments_metadata` as a distinct stream.

**Pattern worth naming in the spec:** a convention that streams exist in a metadata/binary pair, and the user can grant one without the other. We've done it ad hoc; making it explicit would help consent cards render it consistently.

## Gap 4: Incremental resume via opaque state blob

Slackdump's `resume` command takes an archive directory and picks up where it left off. The state is in the archive itself (a SQLite file), not in a cursor returned to the caller. Our connector today passes the archive path in `state.archive_dir` — the cursor is a filesystem pointer.

This is actually a clean design pattern: **the connector's state is allowed to be a pointer to external storage, not just a monotonic cursor.** The Collection Profile spec talks about `cursor` as if it's always an opaque JSON blob, but pointers-to-external-state are a legitimate variant worth naming.

Related: the `Checkpoint json.RawMessage` in Timelinize works the same way — opaque to the caller, meaningful only to the source.

**Spec clarification worth making:** `state.<stream>.cursor` can be any JSON-serializable value, including external-storage handles. The runtime MUST NOT inspect or normalize cursors.

## Gap 5: Rate limiting as a configurable dimension

Slackdump has `-limiter-boost`, `-limiter-burst`, `-download-limits` flags. These are operational knobs the user may want to adjust (aggressive scrape before session expires vs. conservative to avoid tripping anti-bot).

Not spec-surface. But the consent card could reasonably ask "slow/medium/fast" and translate. Cross-cuts with options_schema.

## Gap 6: Data export modes

Slackdump has three output formats: native chunk files, SQLite, and "Slack Export" (Mattermost-compatible). The PDPP runtime only consumes RECORDs — we don't care about the internal format. But slackdump-the-project treats export format as a first-class user choice.

**Relevant to PDPP: the re-export question.** Once PDPP has 233k records in its RS, can the user export them back into a slackdump-compatible archive, or a Mattermost export, or …? The spec is silent on disclosure artifacts beyond the grant-level view. Slackdump-style format-choice hints that disclosure exports might themselves need a format-negotiation dimension.

## Gap 7: Workspace as a first-class scope

Slackdump is workspace-scoped. A PDPP grant for "Slack" without specifying *which* workspace is meaningless. Today we treat workspace as an option (`SLACK_WORKSPACE`), but it's really closer to "provider instance" — comparable to Plaid's per-bank routing.

The PDPP spec has `provider_id` for provider selection at the top level. Does it support "provider instance" for multi-account providers? A user with three Slack workspaces might want three distinct grants. Today our manifest is singular — `slack.json` connector_id doesn't vary per workspace.

**Potential spec clarification:** connector manifests may declare an instance-discriminator field that the grant must populate. Multi-workspace Slack is the motivating case; multi-account Gmail, multi-org GitHub, multi-brand Shopify are analogous.

## Gap 8: Channel-scope operator controls (validated in practice 2026-04-19)

Observed during the first full vana-org ingest: the operator has no way, at grant time, to say "I want Slack data from these channels but not those" beyond whatever `SLACK_CHANNEL_ALLOWLIST` env var the connector happens to expose. This is a specific, recurring flavor of Gap 1 — and it's the one users hit first, because:

- Most Slack workspaces have a small set of channels a user actively cares about and a long tail they don't. Fetching all of them costs API time (rate-limit throttling) and storage.
- Grants that say "access Slack" feel unsafely broad; grants that say "access your 4 chosen channels" feel honest.
- The consent card can show a checkable list of channel names if the manifest advertises that channel selection is a first-class scope dimension.

Today this is collapsed into `SLACK_CHANNEL_ALLOWLIST` env var via `options_schema` (see `connector-configuration-open-question.md`). Principled resolution needs either:

- **Promote to `scope.streams[].resources`** — treat channel IDs as resource keys of a containing stream. Requires the channel list to be discoverable pre-grant so the consent UI can render it.
- **Add `scope.streams[].categories`** — first-class category dimension within a stream, orthogonal to resources. See Gap 1.

Either way, it should be a spec decision, not per-connector env-var sprawl.

## Recommendation

Don't change the spec over these yet. But when `options_schema` and `credentials_schema` land (tracked in `connector-configuration-open-question.md`), revisit with these eight cases as validation — the design should express at least gaps 1, 3, 4, 7, and 8 natively.

## Related

- `connector-configuration-open-question.md`
- `rs-storage-topology-open-question.md`
- `credential-storage-open-question.md`
