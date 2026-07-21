# Stream evidence inventory

Generated artifact. Do not hand-edit — run `pnpm stream-evidence:inventory` to regenerate, and `pnpm stream-evidence:check` to verify it is current.

One row per declared manifest stream, across `packages/polyfill-connectors/manifests/*.json` and `reference-implementation/manifests/*.json`. `required` defaults to `true` when the manifest does not declare it. This inventory records declared strategy, not observed runtime proof — see `openspec/changes/define-stream-coverage-freshness-evidence/specs/reference-connection-health/spec.md` for how the runtime derives per-stream coverage from these strategies plus observed collection facts.

## polyfill/amazon

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| orders | checkpoint_window | manual_as_of | — | true | — | — |
| order_items | parent_detail_accounting | manual_as_of | — | true | — | — |

## polyfill/anthropic

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| conversations | checkpoint_window | manual_as_of | — | true | — | — |
| messages | checkpoint_window | manual_as_of | — | true | — | — |
| projects | full_inventory | manual_as_of | — | true | — | — |

## polyfill/apple-health

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| records | snapshot_import_receipt | manual_as_of | — | true | — | — |
| workouts | snapshot_import_receipt | manual_as_of | — | true | — | — |

## polyfill/chase

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| accounts | full_inventory | manual_as_of | — | true | — | — |
| transactions | parent_detail_accounting | manual_as_of | — | true | — | — |
| current_activity | checkpoint_window | manual_as_of | — | true | — | — |
| statements | parent_detail_accounting | manual_as_of | — | true | — | — |
| balances | parent_detail_accounting | manual_as_of | — | true | — | — |

## polyfill/chatgpt

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| conversations | checkpoint_window | scheduled_window | — | true | — | — |
| messages | parent_detail_accounting | scheduled_window | — | true | — | — |
| memories | full_inventory | scheduled_window | — | true | — | — |
| custom_gpts | full_inventory | scheduled_window | — | true | — | — |
| custom_instructions | singleton_presence | scheduled_window | — | true | — | — |
| shared_conversations | checkpoint_window | scheduled_window | — | true | — | — |

## polyfill/claude-code

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| sessions | checkpoint_window | device_heartbeat | — | true | — | — |
| messages | checkpoint_window | device_heartbeat | — | true | sessions | — |
| attachments | checkpoint_window | device_heartbeat | — | true | sessions | — |
| skills | snapshot_import_receipt | device_heartbeat | — | true | — | — |
| memory_notes | checkpoint_window | device_heartbeat | — | true | sessions | — |
| slash_commands | snapshot_import_receipt | device_heartbeat | — | true | — | — |
| file_history | snapshot_import_receipt | device_heartbeat | inventory_only | false | — | — |
| cache_inventory | snapshot_import_receipt | device_heartbeat | inventory_only | false | — | — |
| coverage_diagnostics | snapshot_import_receipt | device_heartbeat | inventory_only | false | — | — |
| debug_artifacts | snapshot_import_receipt | device_heartbeat | deferred | false | — | — |
| downloads | snapshot_import_receipt | device_heartbeat | deferred | false | — | — |
| backup_inventory | snapshot_import_receipt | device_heartbeat | inventory_only | false | — | — |
| config_inventory | snapshot_import_receipt | device_heartbeat | inventory_only | false | — | — |

## polyfill/codex

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| sessions | checkpoint_window | device_heartbeat | — | true | — | — |
| messages | checkpoint_window | device_heartbeat | — | true | sessions | — |
| function_calls | checkpoint_window | device_heartbeat | — | true | sessions | — |
| rules | full_inventory | device_heartbeat | — | true | — | — |
| prompts | snapshot_import_receipt | device_heartbeat | — | true | — | — |
| skills | snapshot_import_receipt | device_heartbeat | — | true | — | — |
| history | snapshot_import_receipt | device_heartbeat | inventory_only | false | — | — |
| session_index | snapshot_import_receipt | device_heartbeat | inventory_only | false | — | — |
| coverage_diagnostics | snapshot_import_receipt | device_heartbeat | — | true | — | — |
| logs | snapshot_import_receipt | device_heartbeat | deferred | false | — | — |
| shell_snapshots | snapshot_import_receipt | device_heartbeat | inventory_only | false | — | — |
| config_inventory | snapshot_import_receipt | device_heartbeat | inventory_only | false | — | — |
| cache_inventory | snapshot_import_receipt | device_heartbeat | inventory_only | false | — | — |

## polyfill/doordash

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| orders | checkpoint_window | manual_as_of | — | true | — | — |
| order_items | parent_detail_accounting | manual_as_of | — | true | — | — |

## polyfill/github

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| user | singleton_presence | scheduled_window | — | true | — | — |
| user_stats | singleton_presence | scheduled_window | — | true | — | — |
| repositories | full_inventory | scheduled_window | — | true | — | — |
| starred | full_inventory | scheduled_window | — | true | — | — |
| issues | checkpoint_window | scheduled_window | — | true | — | — |
| pull_requests | checkpoint_window | scheduled_window | — | true | — | — |
| gists | full_inventory | scheduled_window | — | true | — | — |

## polyfill/gmail

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| messages | checkpoint_window | scheduled_window | — | true | — | — |
| threads | checkpoint_window | scheduled_window | — | true | — | — |
| labels | full_inventory | scheduled_window | — | true | — | — |
| message_bodies | checkpoint_window | scheduled_window | — | true | messages | — |
| attachments | parent_detail_accounting | scheduled_window | — | true | — | — |

## polyfill/google-maps

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| timeline_points | checkpoint_window | manual_as_of | — | true | — | — |
| timeline_segments | checkpoint_window | manual_as_of | — | true | — | — |

## polyfill/google-maps-data-portability

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| archive_jobs | checkpoint_window | manual_as_of | — | true | — | — |

## polyfill/google-takeout

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| location_history | snapshot_import_receipt | manual_as_of | — | true | — | — |
| youtube_watch_history | snapshot_import_receipt | manual_as_of | — | true | — | — |
| search_history | snapshot_import_receipt | manual_as_of | — | true | — | — |

## polyfill/heb

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| orders | checkpoint_window | manual_as_of | — | true | — | — |
| order_items | parent_detail_accounting | manual_as_of | — | true | — | — |

## polyfill/ical

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| events | snapshot_import_receipt | manual_as_of | — | true | — | — |

## polyfill/imessage

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| messages | snapshot_import_receipt | manual_as_of | — | true | — | — |

## polyfill/linkedin

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| profile | singleton_presence | manual_as_of | — | true | — | — |
| experience | full_inventory | manual_as_of | — | true | — | — |
| education | full_inventory | manual_as_of | — | true | — | — |
| skills | full_inventory | manual_as_of | — | true | — | — |

## polyfill/loom

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| videos | checkpoint_window | manual_as_of | — | true | — | — |
| transcripts | parent_detail_accounting | manual_as_of | — | true | — | — |

## polyfill/meta

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| profile | singleton_presence | manual_as_of | — | true | — | — |
| posts | checkpoint_window | manual_as_of | — | true | — | — |

## polyfill/notion

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| pages | full_inventory | scheduled_window | — | true | — | — |
| databases | full_inventory | scheduled_window | — | true | — | — |

## polyfill/oura

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| sleep | checkpoint_window | scheduled_window | — | true | — | — |
| readiness | checkpoint_window | scheduled_window | — | true | — | — |
| activity | checkpoint_window | scheduled_window | — | true | — | — |

## polyfill/pocket

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| items | checkpoint_window | manual_as_of | — | true | — | — |

## polyfill/reddit

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| submitted | checkpoint_window | manual_as_of | — | true | — | — |
| comments | checkpoint_window | manual_as_of | — | true | — | — |
| saved | checkpoint_window | manual_as_of | — | true | — | — |
| upvoted | checkpoint_window | manual_as_of | — | true | — | — |
| downvoted | checkpoint_window | manual_as_of | — | true | — | — |
| hidden | checkpoint_window | manual_as_of | — | true | — | — |

## polyfill/shopify

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| orders | checkpoint_window | manual_as_of | — | true | — | — |

## polyfill/slack

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| workspace | singleton_presence | scheduled_window | — | true | — | — |
| channels | full_inventory | scheduled_window | — | true | — | — |
| channel_stats | singleton_presence | scheduled_window | — | true | — | — |
| channel_memberships | full_inventory | scheduled_window | — | true | — | — |
| users | full_inventory | scheduled_window | — | true | — | — |
| messages | checkpoint_window | scheduled_window | — | true | — | — |
| message_attachments | checkpoint_window | scheduled_window | — | true | messages | — |
| reactions | checkpoint_window | scheduled_window | — | true | messages | — |
| files | checkpoint_window | scheduled_window | — | true | — | — |
| canvases | full_inventory | scheduled_window | — | true | — | — |
| stars | full_inventory | scheduled_window | — | false | — | — |
| user_groups | full_inventory | scheduled_window | — | false | — | — |
| reminders | full_inventory | scheduled_window | — | false | — | — |
| dm_read_states | full_inventory | scheduled_window | — | false | — | — |

## polyfill/spotify

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| playlists | full_inventory | manual_as_of | — | true | — | — |
| saved_tracks | checkpoint_window | manual_as_of | — | true | — | — |
| top_artists | full_inventory | manual_as_of | — | true | — | — |
| recently_played | checkpoint_window | manual_as_of | — | true | — | — |

## polyfill/strava

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| activities | checkpoint_window | scheduled_window | — | true | — | — |

## polyfill/twitter-archive

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| tweets | snapshot_import_receipt | manual_as_of | — | true | — | — |
| direct_messages | snapshot_import_receipt | manual_as_of | — | true | — | — |

## polyfill/uber

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| trips | checkpoint_window | manual_as_of | — | true | — | — |

## polyfill/usaa

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| accounts | full_inventory | manual_as_of | — | true | — | — |
| account_stats | singleton_presence | manual_as_of | — | true | — | — |
| transactions | parent_detail_accounting | manual_as_of | — | true | — | — |
| statements | parent_detail_accounting | manual_as_of | — | true | — | — |
| inbox_messages | checkpoint_window | manual_as_of | — | true | — | — |
| credit_card_billing | checkpoint_window | manual_as_of | — | true | — | — |
| credit_card_billing_stats | singleton_presence | manual_as_of | — | true | — | — |

## polyfill/whatsapp

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| chats | snapshot_import_receipt | manual_as_of | — | true | — | — |
| messages | snapshot_import_receipt | manual_as_of | — | true | — | — |
| attachments | parent_detail_accounting | manual_as_of | — | true | — | — |

## polyfill/wholefoods

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| orders | checkpoint_window | manual_as_of | — | true | — | — |
| order_items | parent_detail_accounting | manual_as_of | — | true | — | — |

## polyfill/ynab

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| budgets | full_inventory | scheduled_window | — | true | — | — |
| accounts | full_inventory | scheduled_window | — | true | — | — |
| account_stats | singleton_presence | scheduled_window | — | true | — | — |
| category_groups | full_inventory | scheduled_window | — | true | — | — |
| categories | full_inventory | scheduled_window | — | true | — | — |
| payees | full_inventory | scheduled_window | — | true | — | — |
| payee_locations | full_inventory | scheduled_window | — | true | — | — |
| transactions | checkpoint_window | scheduled_window | — | true | — | — |
| scheduled_transactions | checkpoint_window | scheduled_window | — | true | — | — |
| months | full_inventory | scheduled_window | — | true | — | — |
| month_categories | full_inventory | scheduled_window | — | true | — | — |

## reference/github

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| repositories | full_inventory | manual_as_of | — | true | — | — |
| starred | full_inventory | manual_as_of | — | true | — | — |

## reference/northstar-hr

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| pay_statements | full_inventory | manual_as_of | — | true | — | — |
| equity_grants | full_inventory | manual_as_of | — | true | — | — |
| benefits_enrollments | full_inventory | manual_as_of | — | true | — | — |

## reference/reddit

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| posts | checkpoint_window | manual_as_of | — | true | — | — |
| comments | checkpoint_window | manual_as_of | — | true | — | — |
| saved | full_inventory | manual_as_of | — | true | — | — |

## reference/spotify

| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |
| --- | --- | --- | --- | --- | --- | --- |
| top_artists | full_inventory | manual_as_of | — | true | — | — |
| saved_tracks | full_inventory | manual_as_of | — | true | — | — |
| recently_played | checkpoint_window | manual_as_of | — | true | — | — |

## Summary

0 stream(s) missing a coverage_strategy or freshness_strategy declaration (debt).
0 stream(s) combine required=true/default-required with an accepted-absence coverage_policy (debt).
