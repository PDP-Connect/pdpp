# MCP Read Evidence Live Smoke

Status: completed
Owner: reference implementation
Created: 2026-06-24
Related: `openspec/changes/complete-mcp-read-evidence-ladder`

## Scope

This note records the live smoke performed after merging PR #27, `feat(mcp): complete read evidence ladder`, and deploying the live reference stack from the existing Explore deploy lineage.

The deploy intentionally preserved the live Explore branch rather than replacing it with rewritten `main`. The MCP packages and read-evidence behavior already matched the merged branch on the deploy lineage; the only runtime patch added during deploy closeout was the diagnostics sanitizer fix for local secret path fragments.

## Deployment

- Main merge: PR #27 merged as `653418d106920b8981e17af579b3772518f1249f`.
- Live deploy tree: `/home/tnunamak/.tmp/pdpp-deploy`.
- Live deploy revision: `cb00d1f62`.
- Deploy command: `COMPOSE_PROJECT_NAME=pdpp scripts/reference-stack.sh up --build-app`.
- Live stack result: `reference-stack: ok`; reference container healthy; web container started.

## Pre-Deploy Gates

Run in the deploy tree before live rebuild:

- `pnpm --dir reference-implementation run typecheck`
- `pnpm --dir reference-implementation exec node --test --test-name-pattern "device-exporter diagnostics scope" test/device-exporter-routes.test.js`
- `pnpm --dir packages/mcp-server test`
- `pnpm --dir reference-implementation exec node --test test/record-field-window-substrate.test.js test/rs-record-field-window-route.test.js`

All passed.

## Live Smoke

HTTP smoke:

- `https://pdpp.vivid.fish/.well-known/oauth-protected-resource` returned `200`.
- Response header `PDPP-Reference-Revision` was `cb00d1f62`.
- `https://pdpp.vivid.fish/dashboard/explore` returned `307` to owner login, as expected for an unauthenticated request.

MCP/read-evidence smoke using Vana Slack `messages` and query `Hyperlane`:

- `search` returned a Slack-scoped result for `cin_f565a96cb0a114b0a27e9606/messages:C08CDMJ8206:1733441013.139829`.
- Search output included `evidence_excerpts.preview_text` around the matched Slack `text`: `...bridging using Hyperlane or LayerZero? *Layer Zero for sure.*...`.
- Search output included model-callable `read_record_field` continuation arguments for the `text` field.
- Search output did not expose model-visible `pdpp://field-window/...` resource URIs in `field_windows`.
- `read_record_field` on `messages.text` with `q=Hyperlane`, `before_chars=500`, `after_chars=1000`, and `limit_chars=2000` returned bounded window metadata with `total_chars=1215`, `complete=true`, `has_more=false`, and match offsets.
- Projected `fetch` for `id`, `text`, `channel_id`, `user_id`, `sent_at`, and `thread_ts` returned inline JSON rather than a materialized file artifact.

## Result

The live hosted MCP path now satisfies the intended practical ladder for ordinary evidence inspection:

1. Search provides bounded visible evidence for classification.
2. Search provides explicit model-callable continuation through `read_record_field`.
3. Bounded reads return truthful truncation and match metadata.
4. Ordinary projected fetches stay inline.
5. Field-window resource handles remain available for capable clients but are not exposed as dead model-visible handles for hosted clients that cannot read them.

This does not claim every MCP host implements generic `resources/read` for `pdpp://field-window/...`; the deployed design avoids depending on that capability for hosted ChatGPT-style clients.
