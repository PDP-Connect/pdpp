# Slack coverage live verification - 2026-06-29

Status: current live verification captured.

Scope: read-only checks against the running reference stack for the active Slack connection. No connector runs, database writes, restarts, credential reads, Slack payload text inspection, or upstream Slack API calls were performed.

## Result

The active Slack connection is current and internally reconciled against the local scoped Slackdump archives inspected.

Live run state:

- Latest ten Slack runs observed on 2026-06-29 all succeeded.
- Latest observed run completed at `2026-06-29T15:06:28.483Z`.
- `controller_active_runs` was `0`.
- No current Slack detail-gap rows were present.
- No open Slack attention rows were present; only four historical cancelled credential-required rows remained.

Retained records:

- Total retained Slack rows: `371133`.
- Retained Slack `messages`: `206272`.
- Newest retained Slack message semantic time: `2026-06-29T14:47:05.530Z`.
- Newest retained Slack message emitted time: `2026-06-29T14:47:58.367Z`.
- Every retained Slack row had both `semantic_time` and `emitted_at`.

Recent message coverage:

| Day | Retained Slack messages |
| --- | ---: |
| 2026-06-29 | 156 |
| 2026-06-28 | 26 |
| 2026-06-27 | 10 |
| 2026-06-26 | 278 |
| 2026-06-25 | 349 |
| 2026-06-24 | 252 |
| 2026-06-23 | 136 |
| 2026-06-22 | 80 |

Per-channel state:

- `messages.observed_channel_ids` contains `666` observed channels.
- `messages.channel_last_ts` contains high-water entries for `569` channels.
- Retained Slack `channels`: `973`.
- Distinct channels with retained messages: `569`.

Scoped archive parity:

- Scoped Slackdump archive message rows inspected: `540990`.
- Distinct scoped archive message keys: `123205`.
- Retained Slack message keys: `206272`.
- Scoped archive keys retained: `123205`.
- Scoped archive keys missing from retained records: `0`.

## Interpretation

This closes the scoped historical-hole repair verification: every distinct message key present in the inspected scoped archives is present in retained Slack `messages`.

This does not prove absolute upstream Slack completeness. It proves the reference store is current and internally reconciled against the local archives available to the running connector. Proving absolute upstream completeness would require a fresh upstream Slack inventory comparison under the active source credentials.

## Commands

The verification used aggregate-only SQL and a temporary Postgres table loaded from local SQLite archive keys. Message payload text and credential material were not printed.

Key checks:

```bash
rtk docker exec pdpp-postgres-1 psql -U pdpp -d pdpp -tAc \
  "SELECT connector_instance_id, connector_id, run_id, status, started_at, completed_at, records_emitted
   FROM scheduler_run_history
   WHERE connector_id='slack'
   ORDER BY started_at DESC
   LIMIT 10;"

rtk docker exec pdpp-postgres-1 psql -U pdpp -d pdpp -tAc \
  "SELECT stream, count(*), min(NULLIF(semantic_time,'')), max(NULLIF(semantic_time,'')), max(NULLIF(emitted_at,''))
   FROM records
   WHERE connector_instance_id='cin_f565a96cb0a114b0a27e9606'
     AND connector_id='slack'
     AND deleted IS NOT TRUE
   GROUP BY stream
   ORDER BY count(*) DESC;"
```

The scoped archive parity check streamed `CHANNEL_ID || ':' || TS` from each local scoped Slackdump `MESSAGE` table into a temporary Postgres table, compared it to retained `records.record_key`, and printed only aggregate counts.
