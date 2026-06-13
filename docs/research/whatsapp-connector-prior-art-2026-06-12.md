# WhatsApp Connector Prior Art

Access date: 2026-06-12

## Conclusion

Recommendation: treat the first serious PDPP WhatsApp connector as a local import connector, not a live/browser connector. The best starting point is the existing PDPP chat-export connector shape, upgraded with lessons from Timelinize's import philosophy and chat-miner's WhatsApp export parser. If one external codebase must be used as a parser substrate, `joweich/chat-miner` is the least-bad open-source starting point for export text parsing; it is narrow, MIT-licensed, has tests, and already models WhatsApp exports as structured rows. It is not sufficient by itself for PDPP because it is analytics/dataframe-oriented, does not solve media blobs, stable IDs, source identity, or connector UX.

Do not start with `whatsapp-web.js`, Baileys, or open-wa for the first connector. They are attractive because they expose richer live events and Baileys has actual history-sync hooks, but they bind PDPP's reference path to unofficial WhatsApp Web sessions, key/session storage risk, account-ban/ToS fragility, and a more developer-shaped setup flow. Browser automation remains a portability polyfill, not the ideal end state.

## Evaluation Summary

| Candidate/path | Setup UX | Completeness | Incremental posture | Safety/compliance | Data model fit | Maintenance/license | Verdict |
|---|---|---|---|---|---|---|---|
| Official mobile chat export text/zip | Owner can do it from phone, but per-chat and manual | Text messages, timestamps, author labels, optional media files; weak global contact/thread identity; export can omit older or privacy-blocked data | Export-only; dedupe/fingerprint, not true cursor | Safest: user-initiated export, no credentials | Good enough for `threads`, `messages`, `attachments` if normalized carefully | Official path, but format varies by locale/platform | Best first path |
| Google Drive/iCloud backups | Hard for owner; often needs device/account/key extraction | Potentially broadest history if decrypted; media may be separate | Snapshot import only | High privacy/key-handling risk; platform restrictions | Stronger IDs possible from SQLite, but extraction is brittle | Tooling exists but is forensic/developer-oriented | Defer |
| WhatsApp Business/Cloud API | Developer/business account flow, not personal | Only business-account messages/events visible to the app; not personal historical archive | Webhooks for future inbound/outbound business traffic | Official but wrong product surface | Good API envelopes, wrong source scope | Official docs, stable for business use | Not suitable for personal history |
| Timelinize | Owner-local import model, archive-first | No confirmed first-class WhatsApp datasource found in current repo docs; strong prior art for timeline/entity/media import | Repeated imports skip existing data | Safe local data ownership model | Excellent conceptual fit: entities, conversations, local files | AGPL-3.0; active but unstable schema warning | Use as design prior art, not dependency |
| HPI ecosystem | Developer-oriented Python modules/config | No first-class WhatsApp module found in searched HPI README/module list | Usually pull/export modules, depends on source | Local and safe, but personal scripts | Good philosophy for personal data access, weak packaged UX | Python ecosystem; module-specific quality | Prior art only |
| chat-miner | Simple local file parser; Python/PyPI | Parses WhatsApp export text into dataframe/CSV; not media/blob complete | Export-only | Safe local parsing | Useful parse core; needs PDPP IDs, threads, participants, attachments | MIT; 582 stars, tests directory, PyPI install | Best parser substrate if reusing code |
| whatsapp-chat-parser/similar small parsers | Usually simple text parsing | Similar to chat-miner but often less maintained/less tested | Export-only | Safe | Narrow parser fit | Varies widely | Consider only as fixture corpus/reference |
| WhatsApp Viewer | Requires root/key/database files | Android `msgstore.db` can expose richer message records; latest format not supported per README | Snapshot import | High owner friction and key/device risk | SQLite gives better IDs/relationships if available | MIT; maintainer says latest DB unsupported | Not first path |
| wa-crypt-tools | Requires key file or 64-char key | Decrypts `.crypt12/.crypt14/.crypt15`, not a full normalized importer | Snapshot decrypt step | Sensitive key handling; developer/forensic UX | Useful only before parser stage | GPL-3.0; active-looking repo with tests | Defer as optional advanced adapter |
| whapa | Forensic GUI/toolset | Android/iOS forensic parser/exporter; README says old DB/WIP and iCloud not working | Snapshot | Forensic setup, phone/media copying | Could inform backup schema handling | Python; updated May 2022 in README | Defer |
| whatsapp-web.js | QR/session owner flow, but browser dependency | Live messages, contacts, groups, media, replies, reactions supported by Web client | Poll/live event; history limited by Web state | Unofficial; README warns blocking risk and WhatsApp disallows bots/unofficial clients | Has message/chat IDs but session state is fragile | Apache-2.0; 22k stars; active | Not first path |
| Baileys | QR/pairing-code flow, developer-shaped | Richest WebSocket event/history surface; has `syncFullHistory`, `messaging.history-set`, message updates, media download | Best live/history-sync semantics among unofficial libs | Unofficial; session/key store risk; ToS ambiguity | Strongest live data model fit | MIT; TS; 9.8k stars; active but breaking changes | Best live fallback, not first connector |
| open-wa/wa-automate | QR/browser automation style | Chatbot-oriented Web automation | Live/poll; history semantics less compelling than Baileys | Unofficial/browser fragility | Usable but bot-first | Apache-2.0; 3.6k stars; large older codebase | Not preferred |

## Official Paths

### Mobile chat export

WhatsApp's own help center documents "How to export your chat history" at `https://faq.whatsapp.com/1180414079177245/`. The export path is the safest basis for PDPP because it is user-initiated and does not require retaining WhatsApp credentials or replaying Web sessions. The connector should expect one export per chat, support text-only and zip-with-media inputs, and declare the limitation clearly: this is not account-wide live sync.

Important risk: WhatsApp introduced Advanced Chat Privacy in 2025, which can block others from exporting full chat histories and auto-saving media. A PDPP connector must surface export failure/absence as an upstream privacy limitation, not a connector bug.

### Google Drive/iCloud backups

WhatsApp documents backup configuration at `https://faq.whatsapp.com/481135090640375/`. Backup imports are tempting because they can contain a fuller local account history than per-chat exports, but they are not owner-friendly in the normal case. Open-source backup tooling generally requires Android root, local key files, encrypted backup keys, Google Drive extraction, or forensic workflows. This fails the SLVP setup bar for a reference connector.

If PDPP ever supports backups, it should be an explicit "advanced local-device import" path with warnings, not the default WhatsApp connector.

### WhatsApp Business/Cloud API

The WhatsApp Business/Cloud API is official but aimed at business accounts and webhook-driven business messaging. It is not an API for personal account history. It should not be used for a personal-data WhatsApp connector except as a separate business-account connector with a different capability statement.

## Parser And Import Projects

### Timelinize

Source: `https://github.com/timelinize/timelinize`.

Timelinize is the closest philosophical prior art: local-first import of personal data into a unified timeline, entity-aware conversations, media handling, and repeat imports that skip existing data. Its README says imports are indexed in SQLite and stored on disk organized by date, and that repeated imports skip existing data. It also warns the schema is still changing and users should keep original source data.

I did not find confirmed first-class WhatsApp import support in the current repo README or visible datasource listing. That makes Timelinize design prior art, not an implementation dependency. The useful lesson for PDPP is the import posture: preserve original exports, normalize entities/conversations/media, and be honest that repeated imports are dedupe-based, not true upstream cursors.

### HPI

Source: `https://github.com/purarue/HPI` and upstream `https://github.com/karlicoss/HPI`.

HPI is relevant as personal-data access prior art, but the searched README/module list did not surface a WhatsApp module. Its strengths are local ownership and Python modules over exported data; its weaknesses for PDPP are developer-centric configuration and inconsistent module maturity. Use HPI as ecosystem precedent, not as a WhatsApp substrate.

### chat-miner

Source: `https://github.com/joweich/chat-miner`.

chat-miner is the best parser-specific starting point. Its README advertises lean parsers for major chat platforms, gives a `WhatsAppParser(FILEPATH)` example, and exposes a CLI that parses WhatsApp chat logs to CSV. It is MIT-licensed, has a tests directory, PyPI install docs, and modest but real adoption signals (582 GitHub stars on access date).

Gaps for PDPP:

- Parser output is dataframe/CSV oriented, not PDPP stream oriented.
- It does not solve stable source identity across repeated exports.
- It does not model attachments as blobs/locators.
- It does not normalize participants beyond names present in export text.
- It does not provide account-wide incremental sync.

Still, those are expected connector-layer responsibilities. Reusing or studying chat-miner's locale/date parsing and fixtures is better than expanding ad hoc regex parsing blind.

### Backup/database tools

Sources:

- `https://github.com/andreas-mausch/whatsapp-viewer`
- `https://github.com/ElDavoo/wa-crypt-tools`
- `https://github.com/B16f00t/whapa`

WhatsApp Viewer reads Android `msgstore.db`, but its README says it does not work with the latest WhatsApp database format and requires root access plus `/data/data/com.whatsapp/files/key`, `msgstore.db`, and `wa.db`. That is too much owner friction for a default connector.

wa-crypt-tools handles `.crypt12`, `.crypt14`, and `.crypt15` encryption/decryption and explicitly requires a key file or 64-character key. It could be useful for a future advanced decrypt step, but it is not a normalized importer.

Whapa is a forensic toolset. Its README says the Android parser/merger are only working with old databases or WIP, `Whacipher` does not support Crypt15, and iCloud extraction is not working. It is useful as evidence that backup parsing is possible but operationally brittle.

## Live/API/Browser Libraries

### whatsapp-web.js

Source: `https://github.com/wwebjs/whatsapp-web.js`.

whatsapp-web.js is popular and convenient. Its README describes a Node library that uses Puppeteer to access WhatsApp Web internal functions, supports multi-device, messages, media, replies, groups, contacts, reactions, channels, and more. It also explicitly disclaims affiliation and warns that blocking is possible because WhatsApp does not allow bots or unofficial clients. This is enough to disqualify it as the first reference path for owner personal history.

### Baileys

Source: `https://github.com/WhiskeySockets/Baileys`.

Baileys is the strongest live candidate. It is TypeScript, WebSocket-based, browserless, and documents QR/pairing-code setup, `syncFullHistory`, first-connection `messaging.history-set`, message update events, group metadata caching, media download, WhatsApp JIDs, and custom stores. Those map better to PDPP streams than browser automation does.

The problem is not capability; it is posture. A PDPP reference connector would need to hold WhatsApp Web auth state and Signal key material, handle session churn, and rely on an unofficial protocol. That should be a separate experimental/live connector only after the export connector is honest and useful.

### open-wa / wa-automate

Source: `https://github.com/open-wa/wa-automate-nodejs`.

open-wa is mature-looking by commit count and has a long chatbot/automation history, but it is browser/automation-oriented and less directly aligned with PDPP's import/archive model than Baileys. It should not be the first substrate.

## Minimum Viable PDPP Stream Model

Use a multiple-path connector design eventually, but ship the first path as local export import.

Minimum streams:

- `sources`: one record per imported export package/file, with connector version, export filename, hash, parse locale/date assumptions, import timestamp, and coverage warnings.
- `threads`: one record per chat export or backup thread, with title, source-local thread ID when available, participant IDs, first/last message time, message count, and import coverage.
- `participants`: normalized sender/contact records keyed by source identity where available; for text exports, preserve display name/phone ambiguity.
- `messages`: one record per message with stable ID derived from source package hash + thread key + timestamp + sender + ordinal/content hash for text exports, or native message ID for database/live paths.
- `attachments`: one record per media marker or zip media file with message relationship, filename/path/blob locator, MIME if known, size/hash if present, and explicit `missing` state when text references media that was not exported.
- `reactions` and `message_events`: defer until source path supports them reliably; live/database paths may produce them later.

Cursor posture:

- Export path: `incremental=false` at source level; repeated imports use fingerprints/dedupe and emit coverage metadata.
- Backup/database path: snapshot import with native IDs where available; do not promise true live cursor.
- Baileys/live path if later added: experimental cursor/checkpoint over WhatsApp Web event history plus session-state version, with strong risk labels.

## Explicit Deferrals

- Account-wide live sync.
- Sending messages or any write action.
- Google Drive/iCloud backup extraction in the default owner flow.
- Rooted-device extraction.
- Decryption-key custody beyond a future local-only advanced import.
- Calls, statuses/stories, channels, communities, payments, disappearing-message recovery, deleted message contents, edit history unless present in source.
- Perfect participant identity. Text exports can preserve labels, not prove global identity.
- Cross-chat contact merge. Leave that to a later identity-resolution layer.

## Why Not The Obvious Alternatives

- `whatsapp-web.js`: most popular, but popularity does not remove the unofficial-client/session/account-risk problem.
- Baileys: technically the best live library and the only one I would consider later, but too risky for the first reference connector because it requires WhatsApp Web auth/key state and relies on protocol behavior WhatsApp can change.
- WhatsApp Business/Cloud API: official, but it is for business messaging, not personal historical WhatsApp accounts.
- Backup database tools: richer data when they work, but owner setup is forensic, root/key-heavy, and brittle across WhatsApp versions.
- Timelinize: strong local personal-data prior art, but not confirmed as a reusable WhatsApp implementation dependency and AGPL may be a reference-image concern.

## Source List

- WhatsApp Help Center, "How to export your chat history", `https://faq.whatsapp.com/1180414079177245/`, accessed 2026-06-12.
- WhatsApp Help Center, "How to back up your chat history", `https://faq.whatsapp.com/481135090640375/`, accessed 2026-06-12.
- The Verge, "WhatsApp now lets you block people from exporting your entire chat history", `https://www.theverge.com/news/654592/whatsapp-advanced-chat-privacy-block-exporting-chats`, accessed 2026-06-12.
- Timelinize GitHub README, `https://github.com/timelinize/timelinize`, accessed 2026-06-12.
- HPI GitHub README, `https://github.com/purarue/HPI`, accessed 2026-06-12.
- chat-miner GitHub README, `https://github.com/joweich/chat-miner`, accessed 2026-06-12.
- whatsapp-web.js GitHub README, `https://github.com/wwebjs/whatsapp-web.js`, accessed 2026-06-12.
- Baileys GitHub README/docs index, `https://github.com/WhiskeySockets/Baileys`, accessed 2026-06-12.
- open-wa/wa-automate GitHub README, `https://github.com/open-wa/wa-automate-nodejs`, accessed 2026-06-12.
- WhatsApp Viewer GitHub README, `https://github.com/andreas-mausch/whatsapp-viewer`, accessed 2026-06-12.
- wa-crypt-tools GitHub README, `https://github.com/ElDavoo/wa-crypt-tools`, accessed 2026-06-12.
- whapa GitHub README, `https://github.com/B16f00t/whapa`, accessed 2026-06-12.
