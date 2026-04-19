# Gmail connector — design notes

**Status:** design captured 2026-04-19 overnight.
**Source:** Gmail IMAP audit subagent 2026-04-19.

## Auth
- **IMAP + Google app-specific password** for v1. OAuth deferred.
- Credentials: `GOOGLE_APP_PASSWORD_PDPP` env var. Email address prompted at first run and stored (see runtime decision below).
- Connection: `imap.gmail.com:993` over TLS.

**Library: `imapflow` (Node).** Handles CONDSTORE natively, tolerates Gmail's lack of QRESYNC, clean async/await API, maintained.

## Core architectural decision: iterate only "All Mail"

Gmail represents labels as IMAP folders. A message with labels [INBOX, Work] appears in three folders: `[Gmail]/All Mail`, `INBOX`, and `Work`. If the connector iterates per folder, it multi-counts. **Always iterate the `\All` special-use folder (typically `[Gmail]/All Mail`) only.** Derive label membership from `X-GM-LABELS` fetched per message.

## Streams

### `messages` (`mutable_state`, primary_key `["id"]`, consent_time_field `"received_at"`)
- `id` = X-GM-MSGID (64-bit integer as string, stable for message lifetime)
- `thread_id` = X-GM-THRID
- `subject`
- `from_name`, `from_email`
- `to` (array of `{name, email}`)
- `cc`, `bcc` (array, nullable)
- `date` (ISO 8601 — header Date; may be sender-forged)
- `received_at` (ISO 8601 — IMAP INTERNALDATE, server receipt time, authoritative)
- `message_id` (RFC 2822 Message-ID header)
- `in_reply_to` (nullable)
- `references` (array of Message-IDs, nullable)
- `size_bytes` (RFC822.SIZE)
- `labels` (array of strings — current X-GM-LABELS including system labels mapped to canonical names)
- `is_draft`, `is_flagged`, `is_seen`, `is_answered` (booleans from IMAP flags)
- `snippet` (first ~256 chars of text/plain body; fetched on initial import only)
- `has_attachments` (boolean)

### `threads` (`mutable_state`, primary_key `["id"]`, consent_time_field `"first_message_date"`)
- `id` = X-GM-THRID
- `subject` (of first message)
- `participant_emails` (array)
- `message_count`
- `first_message_date`
- `last_message_date`
- `labels` (union across thread)
- `unread_count`, `flagged_count`

Derived from `messages`. Emitted as its own stream for query convenience.

### `labels` (`mutable_state`, primary_key `["name"]`)
- `name` (raw IMAP label e.g. `INBOX`, `[Gmail]/Sent Mail`, `Projects/Q2`)
- `canonical_name` (normalized: `inbox`, `sent`, `projects/q2`)
- `is_system` (boolean; `[Gmail]/*` or `INBOX`)
- `parent_name` (nullable)
- `message_count`, `unread_count`

### `attachments` (`append_only`, primary_key `["id"]`, consent_time_field `"message_received_at"`)
- `id` = `{X-GM-MSGID}:{part_index}` (compound; part_index is the BODYSTRUCTURE path)
- `message_id` = X-GM-MSGID
- `filename`
- `content_type`
- `size_bytes` (encoded size if base64 — document this)
- `content_id` (for inline attachments; nullable)
- `is_inline` (boolean)
- `encoding` (`base64`, `quoted-printable`, etc.)
- `part_index` (string — BODYSTRUCTURE path, for later hydration)
- `message_received_at` (INTERNALDATE of parent — for time_range filtering)

**v1 does NOT fetch attachment bytes.** Separate `blob_ref` hydration step deferred to v2.

## Incremental sync
- **Cursor shape:** `{ uidnext: N, modseq: N, all_mail_folder: "[Gmail]/All Mail" }`
- **First run:** `UIDVALIDITY` captured, `FETCH 1:* (FLAGS INTERNALDATE ENVELOPE RFC822.SIZE BODYSTRUCTURE X-GM-MSGID X-GM-THRID X-GM-LABELS MODSEQ)` on `[Gmail]/All Mail`.
- **Subsequent runs:**
  1. `SELECT "[Gmail]/All Mail"` — get new UIDNEXT, HIGHESTMODSEQ.
  2. If UIDVALIDITY changed, full refetch (rare).
  3. `FETCH UID:prev_uidnext..* (...)` — new messages since last run.
  4. `FETCH 1:* (FLAGS X-GM-LABELS MODSEQ) CHANGEDSINCE prev_modseq` — label/flag changes on existing messages.
  5. Detect expunged: `UID SEARCH UID <previously_seen_uids>` → UIDs missing = expunged. Emit tombstones.

## Deletion semantics
- `\Deleted` flag in a non-Trash folder = label removed, not deletion. Message may still exist in `[Gmail]/All Mail`.
- Only messages missing from `[Gmail]/All Mail` on subsequent sync → true deletion → tombstone.

## Rate limits
- Google caps at 15 concurrent IMAP connections. We use **4** max.
- No published bandwidth cap but bulk ops can trigger 24-hour block. Keep runs small.

## Humanlike-ness
- Pace bulk FETCH in windows of 200 messages; pause 500 ms between windows.
- Keep a single long-lived connection per run, not connection-per-message.

## Autonomous decision (2026-04-19): email address prompt
On first run, connector emits `INTERACTION kind=credentials` with a simple form asking for the Gmail address. Response stored in connector state. Avoids hard-coding the owner's address in the manifest or env.

Alternative: derive from `GOOGLE_APP_PASSWORD_PDPP` name. Rejected — brittle, obscures intent.

## Explicit non-goals v1
- Downloading full message bodies or attachment bytes.
- Chat/Meet content (not in IMAP surface).
- Real-time IDLE push. Deferred — scheduler polls every 30 min is sufficient.
- Multiple Gmail accounts — one at a time.
- Non-Gmail IMAP providers — the connector is Gmail-specific today; generic IMAP is a follow-up.
