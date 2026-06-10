# Connection & Device UX — Prior-Art Deep Dive

Status: captured
Owner: RI prior-art right-hand
Created: 2026-05-27
Updated: 2026-05-27
Companion to: `slvp-reference-implementation-prior-art-2026-05-27.md`
Related: `design-notes/connection-first-collection-identity-2026-05-18.md`, `design-notes/source-instances-and-multi-account-configurations-2026-04-24.md`, `openspec/changes/define-connector-instances`

All URLs accessed 2026-05-27.

## Headline recommendations

1. **[SLVP] Connection is a stable owner-facing object with a separate user-editable label, color/icon, and disclosed identifier.** Universal pattern (Plaid, 1Password, Slack, GitHub, Tailscale, Dropbox). The override never replaces the system identifier — both are surfaced.
2. **[SLVP] "Remove connection" defaults to retaining previously collected records.** Separate, explicit "clear data" action with typed confirmation. Pattern: Plaid `/item/remove`, Fivetran delete, Airbyte delete, Dropbox unlink, Tailscale device removal. Only Airbyte's renamed "Clear" wipes destination rows.
3. **[SLVP] Attach schedules to the connection, not the connector type.** Universal at Fivetran, Airbyte, Hevo, Stitch. Expose at minimum: interval, pause toggle, manual-only mode, last-run / next-run timestamps.
4. **[SLVP] Six-state setup machine.** `draft` → `ready` → `paused` ↔ `error` → `needs_reconnect` → `retired`. Union of Stripe Connect restricted/disabled, Fivetran auto-pause-after-14-days, Plaid `ITEM_LOGIN_REQUIRED`.
5. **[OPEN] Multi-binding under one connection** (PDPP's "aggregate OAuth + browser profile + device path"). No clean prior art. Closest analogue is Tailscale's "device with multiple tags" and 1Password's "vault accessed by multiple devices" — both flat. Keep bindings as a child collection visible in a disclosure panel rather than a primary axis.

## 1. Multi-account labels & disambiguation

| Product | Default label | Rename | Disclosed identifier |
|---|---|---|---|
| Plaid Items | `institution.name` + `account.mask` + `subtype` ("Chase ••0000 Checking") | Host app responsibility; Plaid exposes `persistent_account_id` for dedupe. Docs recommend a user-defined nickname layer. https://plaid.com/docs/link/duplicate-items/ | Mask, subtype, institution_id |
| Fivetran connectors | Schema name (user-set at create) | **Not renameable post-create**; must clone or recreate. https://fivetran.com/docs/connectors/troubleshooting/rename-a-connector | Schema prefix |
| Slack workspaces | Workspace name + icon (org-controlled) | Per-device reordering; per-user no rename. https://slack.com/help/articles/1500002200741-Switch-between-workspaces | Icon stack + workspace URL |
| GitHub multi-account | Username + avatar in profile menu | No alias — login is the label. https://github.blog/changelog/2023-11-03-multi-account-support-on-github-com/ | Username, SSO badge, grayed-out when expired |
| 1Password vaults | Vault name + color + icon (32 predefined keywords via CLI) | Edit Vault → name/description/icon. https://support.1password.com/create-share-vaults/ | Account/team name above vault |
| Tailscale machines | Hostname auto-derived | Admin can rename; preserves device key. | OS, version, last-seen |

**[SLVP]** Auto-generate label as `<provider> · <account_identifier> · <suffix>`; owner override is a free-text alias; always show the system label as a smaller subtitle. Adopt color + icon (1Password) for fast visual scanning. Avoid Fivetran's no-rename-after-create.

## 2. Device / exporter inventory

| Product | Naming | Retire without data loss | Last seen |
|---|---|---|---|
| Tailscale | Hostname; admin-renameable | Remove from admin console; tailnet membership ends, peers unaffected. Node keys auto-expire 180d; tagged devices exempt. https://tailscale.com/docs/features/access-control/key-expiry, https://tailscale.com/kb/1260/device-remove/ | Yes, sortable; API can purge by stale last-seen |
| Syncthing | Per-device name | Remove device — folder data on disk untouched; re-adding triggers DB rebuild merge. https://docs.syncthing.net/users/faq.html | Yes |
| Dropbox linked devices | Device name from OS | Unlink keeps locally-synced files; remote-wipe is separate, paid, opt-in. https://help.dropbox.com/security/device-list-remote-sign-out | Yes, per device |
| Google "Your devices" | Device model | Sign-out revokes token; historical entry stays visible up to 28d for audit. https://myaccount.google.com/intro/device-activity | 28-day active window |

**[SLVP]** Adopt the Tailscale + Dropbox dual pattern: removing a device revokes its credential and ends future capture; records remain owned by the connection; "last seen" + version surfaces on the connection detail panel. **[SLVP]** Add key-expiry / re-auth window (Tailscale's 180d default) — disable expiry for "server"-class exporters via a tag. **[OPEN]** Whether to expose Dropbox-style remote-wipe of records-on-device; defer for SLVP.

## 3. Schedules at the connection level

Universal pattern: schedule belongs to the connection.

- **Fivetran**: per-connection fixed-interval (default 6h) or cron (Enterprise). Auto-pause after 14d failure. Manual mode = REST-only trigger. Long syncs auto-reschedule. https://fivetran.com/docs/core-concepts/syncoverview
- **Airbyte**: per-connection Scheduled / Cron (Quartz) / Manual. Manual = effective pause. Hourly minimum unless support override. ±30min jitter accepted. https://docs.airbyte.com/platform/using-airbyte/core-concepts/sync-schedules
- **Hevo / Stitch**: same shape — per-pipeline interval + pause.

**[SLVP]** `connection.schedule = { mode: "interval" | "cron" | "manual", value, paused: bool }`. Don't aggregate by connector type — owner expectations differ per account. **[SLVP]** Auto-pause after N consecutive failures (Fivetran's 14d ladder is gold standard); surface auto-pause as a distinct state. **[DEFER]** cron — start with interval + manual; cron is a power-user surface.

## 4. Deletion vs retirement without data loss

| Action | Records previously collected | Future capture |
|---|---|---|
| Plaid `/item/remove` | Retained in your DB; Plaid invalidates token only. https://plaid.com/docs/api/items/ | Stops |
| Fivetran pause | Retained | Stops, resumable |
| Fivetran delete connector | Retained in destination | Stops |
| Airbyte delete connection | Retained. https://docs.airbyte.com/platform/cloud/managing-airbyte-cloud/configuring-connections | Stops |
| Airbyte "Clear" (was "Reset") | Wiped from destination, tables kept empty; heavy confirmation modal. https://docs.airbyte.com/platform/operator-guides/clear | Resumable |
| Linear Slack revoke / Slack `auth.revoke` | Retained on both sides; deletion requires emailing support. https://linear.app/docs/slack, https://docs.slack.dev/reference/methods/auth.revoke/ | Stops |
| Tailscale remove device | Retained on other peers | Stops |
| Stripe API key rotation | All historical objects retained | Old key inert |

**[SLVP]** Three distinct verbs on the connection menu:

- **Pause** — stops scheduled runs, keeps everything else.
- **Retire / Disconnect** (default destructive action) — revokes binding credentials, marks connection terminal, **records retained and remain queryable**.
- **Delete records…** — separate flow with heavy confirmation; typed confirmation required.

Avoid a single "Delete" verb that conflates the three — every product that conflates them generates support tickets (see Airbyte's rename from Reset → Clear + Refresh).

## 5. Setup state machine

Synthesized from Plaid Link, Stripe Connect, Fivetran, Airbyte, Linear/Slack OAuth (https://docs.stripe.com/connect/upcoming-requirements-updates, https://docs.stripe.com/connect/dashboard/review-actionable-accounts):

```
draft           — created, configured but no first sync (Airbyte sync_on_create:false)
ready           — credentials valid, at least one successful run
paused          — owner-paused, no failure
error           — recent run failed, retry ladder active (Fivetran tier 1-3)
needs_reconnect — credentials invalid; requires user re-auth
                  (Plaid ITEM_LOGIN_REQUIRED, Stripe past_due, Tailscale key expired)
retired         — owner removed binding; records retained, read-only
```

**[SLVP]** Map Plaid's `PENDING_DISCONNECT` / migration webhook concept into a `needs_reconnect` sub-state with a clear "Reconnect" CTA. Stripe's `currently_due` vs `eventually_due` split is a useful deferred-action pattern: surface "this connection will need attention by X" without blocking current capture.

**[OPEN]** Where to put "configured-but-never-run" — Airbyte uses `sync_on_create: false`; Plaid does not surface it. Recommend a single `draft` state with a "Run now" CTA, but accept that some connectors need a real run to validate config.

**[N/A]** Stripe's full `requirements.eventually_due / past_due / disabled_reason` payload — too domain-specific. Reuse the shape (deadline + remediation link) but not the field set.

## Cross-cutting watchouts

- **Persistent identifier for dedupe.** Plaid's `persistent_account_id` solves "same account re-linked = different Item" duplicates. SLVP-equivalent: hash of `(provider, account_sub, exporter_kind)`. **[SLVP]**
- **Multi-workspace / multi-org switcher UX.** Slack and GitHub both went with left-rail icon stack + ⌘+number shortcut. If PDPP grows to multi-owner, copy this. **[DEFER]**
- **Built-in connections cannot be deleted** (1Password Personal vault). Useful pattern if PDPP ships a "self" connection seeded at install. **[OPEN]**
- **Webhook on revocation upstream** (Plaid `USER_ACCOUNT_REVOKED`). Emit a corresponding `connection.retired` event when retiring a connection so downstream consumers can react. **[SLVP]**

## Decision log

- 2026-05-27: Captured connection/device UX deep dive. Companion to the SLVP RI synthesis. PDPP first tranche adopts three-verb model (Pause / Retire / Delete records…), six-state setup machine, per-connection schedules, and persistent dedupe identifier.
