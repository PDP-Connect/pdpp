# Amazon and Chase live gap status - 2026-06-29

Status: current live status captured for closeout.

Scope: read-only checks against the running reference stack. No connector runs, database writes, restarts, credential reads, source payload inspection, or provider browser actions were performed.

## Implemented fixes

The relevant connector fixes are present on `origin/main`:

- `dab769ab7` - `fix(amazon): bound repeated detail failures (#83)`
- `60f79f920` - `fix(amazon): bound detail hydration and resume gaps (#87)`
- `1f4bad0a8` - `fix(chase): wait for QFX file type selector`

The Amazon order-detail display messages are also present in `reference-implementation/runtime/display-messages.ts` on `origin/main`; the stale `fix/amazon-detail-budget-main` branch does not carry a needed current code delta.

## Current live gap state

Amazon still has pending `order_items` detail gaps. The largest active connection gap set observed was:

- `cin_a8ec003e6d441205d646f178`: `39` pending `order_items` gaps, last attempted `2026-06-26T14:25:10.095Z`.

Other Amazon pending gaps exist across historical or inactive connections. These rows represent retained detail-backlog evidence, not proof that the runtime fixes are missing from `main`.

Chase still has one pending transaction detail gap:

- `cin_029a67a16d8a252f6e3eb896`: `1` pending `transactions` gap, created `2026-06-15T12:14:19.583Z`.

## Interpretation

The code-fix lanes are complete. The remaining Amazon and Chase rows are live provider-coverage residue that require an intentional owner/browser-mediated run to prove recovery. Chase is especially owner-mediated because the path can require OTP or provider-side browser interaction.

Do not describe these rows as unmerged code. Do not clear them by editing the database. The next closure step, if current provider completeness is required, is a targeted live retry under the live-stack process with owner/browser availability.

## Commands

```bash
rtk docker exec pdpp-postgres-1 psql -U pdpp -d pdpp -tAc \
  "SELECT connector_id, connector_instance_id, status, stream, count(*), min(created_at), max(updated_at), max(last_attempt_at), max(recovered_run_id)
   FROM connector_detail_gaps
   WHERE connector_id IN ('amazon','chase')
   GROUP BY connector_id, connector_instance_id, status, stream
   ORDER BY connector_id, connector_instance_id, status, stream;"

git merge-base --is-ancestor dab769ab7 origin/main
git merge-base --is-ancestor 60f79f920 origin/main
git merge-base --is-ancestor 1f4bad0a8 origin/main
```
