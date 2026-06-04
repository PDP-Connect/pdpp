# Design — split sampled metrics into append-keyed observation streams

## Scope

| Stream | Sampled metric fields | Entity / identity fields | Construction |
| --- | --- | --- | --- |
| github / user | `public_repos`, `public_gists`, `followers`, `following` | `login`, `name`, `email`, `bio`, `company`, `location`, `blog`, `twitter_username`, `avatar_url`, `created_at`, `updated_at` | fingerprint entity; append-key stats |
| slack / channels | `num_members` | `name`, `name_normalized`, `is_*` flags, `creator`, `created_at`, `topic`, `purpose`, `previous_names`, canvas fields | fingerprint entity; append-key stats |

## Observation-stream keying

Observation records use a composite key `{entity_id}:{YYYY-MM-DD}` (UTC date).

This key design satisfies the core requirements:

1. **Time series preserved** — each calendar day gets at most one record per
   entity, so history accumulates as a genuine time series.
2. **Idempotent within a day** — re-running the connector on the same calendar
   day overwrites the existing record with the same key rather than appending a
   duplicate. The runtime's byte-equivalence check collapses same-content
   re-emits; same-key different-content updates the record.
3. **No false churn** — keying by day rather than by run means two runs within
   the same day that observe the same metrics produce the same key and same
   content → zero new versions.
4. **Real change is preserved** — if `followers` moves from 50 to 51 between two
   runs on the same day, the second emit replaces the day's record with the
   new value (a genuine update, not churn). If the runs are on different days,
   both records survive as a time series.

Alternative key `{entity_id}:{run_id}` was rejected: it guarantees exactly one
new version per run per entity, replicating the churn under a different name.

Alternative key `{entity_id}` (plain entity id) was rejected: it collapses all
history into one record, destroying the time series.

## Entity stream fingerprinting

The `user` and `channels` entity streams gain a `openFingerprintCursor` gate
excluding the `fetched_at` field (if any) and the new stat fields. Because the
stat fields move to the `user_stats`/`channel_stats` streams, the entity records
no longer contain them, so no explicit exclusion is needed beyond the pattern
already established for `workspace`/`users`/`files`/`channel_memberships`.

For GitHub `user`: after the split, the entity record contains only stable
identity fields — no run-clock or count fields. A full fingerprint (no
exclusions) is correct; the record changes only when the user edits their
profile.

For Slack `channels`: after the split, the channel record no longer contains
`num_members`. The remaining fields (`name`, `topic`, etc.) already change
rarely. A full fingerprint (no exclusions beyond the existing pattern) is
correct. `fetched_at` is not present on channel records, so no exclusion is
required.

## Backwards compatibility

Both connectors maintain the `user` and `channels` streams as declared in their
manifests. The entity records simply drop the sampled metric fields. Existing
integrations that read those fields from the entity stream will see `null`/absent
values after the first run post-deploy and should migrate to the new streams.
This is an intentional breaking change at the field level, mitigated by:

1. The new streams carrying the same data.
2. Both old and new streams being declared in the manifest.
3. The old fields being removed from the entity schema to make the break
   explicit, not silent.

## Acceptance checks

- `pnpm --filter @pdpp/polyfill-connectors test -- --grep "user_stats|userStats|channel_stats|channelStats|userEntity|channelEntity"`
- `pnpm --dir packages/polyfill-connectors typecheck`
- `openspec validate split-point-in-time-observation-streams --strict`
- `git diff --check`

## Out of scope

- Compaction of historical pre-split entity records (owner-gated separately).
- Other high-churn streams not in scope of this change.
- Production live `--apply` compaction.
