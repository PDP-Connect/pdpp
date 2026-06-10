-- canonical-connector-keys / backup-restore-seed.sql
--
-- Pre-migration fixture for the §3.4 backup/restore validation harness
-- (see run-backup-restore-validation.sh and README.md). Loaded into a
-- DISPOSABLE database that already holds the real reference schema. The
-- rows here intentionally span every connector-identity shape the
-- canonical-key migration must rewrite, plus rows that must NOT change,
-- so the post-restore migration can be checked for correctness rather
-- than just "it ran".
--
-- Identity shapes exercised:
--   url_first_party       https://registry.pdpp.org/connectors/gmail   -> gmail
--   canonical_legacy_alias claude_code                                 -> claude-code
--   wrapped_local_device  local-device:codex:cin_dev_codex_01          -> codex
--   canonical_first_party spotify                                      -> spotify (NO rewrite)
--   backup-tier URL row   (in a backup_* table)                        -> SKIPPED by default
--
-- Constraint notes (real schema):
--   - connector_instances.connector_id FK -> connectors.connector_id
--     (ON DELETE RESTRICT). The writer upserts the canonical parent,
--     repoints children, then deletes the old parent inside one txn.
--   - records/record_changes/blobs/blob_bindings/connector_state/
--     version_counter carry connector_id with NO FK, but require
--     connector_instance_id NOT NULL.
--   - grants/grant_package_members/pending_consents embed connector ids
--     inside JSONB (grant_json/storage_binding_json/source_json/params_json).

BEGIN;

-- ----------------------------------------------------------------------
-- oauth_clients — the public device-flow client an owner agent uses to
-- mint an owner token. A real operator backup carries the owner's
-- registered clients; the synthetic seed carries the one client the
-- HTTP read-surface verifier (verify-http-surfaces.mjs) drives so the
-- restored DB is actually bootable for an owner read. The canonical-key
-- migration does not touch oauth_clients (no connector_id), so this row
-- is identity-shape-neutral and only enables the live-read smoke.
-- ----------------------------------------------------------------------
INSERT INTO public.oauth_clients
  (client_id, registration_mode, token_endpoint_auth_method, client_secret,
   metadata_json, created_at, updated_at) VALUES
  ('cli_longview', 'pre_registered_public', 'none', NULL,
   '{"client_name":"Longview CLI","token_endpoint_auth_method":"none"}'::jsonb,
   '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
ON CONFLICT (client_id) DO NOTHING;

-- ----------------------------------------------------------------------
-- connectors (parent catalog rows; connector_id is the PK + FK target)
-- ----------------------------------------------------------------------
-- These manifest bodies are intentionally THIN — enough to exercise the
-- storage-layer migration (verify-backup-restore.mjs). The HTTP read path
-- (verify-http-surfaces.mjs) additionally needs a *valid* operational
-- manifest body to resolve streams, so the harness overwrites these rows'
-- `manifest` JSONB with the real first-party manifests from
-- packages/polyfill-connectors/manifests/ (seed-real-manifests.mjs) BEFORE
-- the backup is dumped. Keeping the SQL thin avoids duplicating ~38KB of
-- manifest JSON in the fixture and keeps the manifests single-sourced.
-- gmail seeded under its URL-shaped id (the pre-migration drift state).
INSERT INTO public.connectors (connector_id, manifest, created_at) VALUES
  ('https://registry.pdpp.org/connectors/gmail',
   '{"connector_id":"https://registry.pdpp.org/connectors/gmail","manifest_uri":"https://registry.pdpp.org/connectors/gmail","name":"Gmail"}'::jsonb,
   '2026-01-02T00:00:00Z'),
  ('claude_code',
   '{"connector_id":"claude_code","name":"Claude Code"}'::jsonb,
   '2026-01-02T00:00:01Z'),
  ('codex',
   '{"connector_key":"codex","manifest_uri":"https://registry.pdpp.org/connectors/codex","name":"Codex"}'::jsonb,
   '2026-01-02T00:00:02Z'),
  ('spotify',
   '{"connector_key":"spotify","manifest_uri":"https://registry.pdpp.org/connectors/spotify","name":"Spotify"}'::jsonb,
   '2026-01-02T00:00:03Z');

-- ----------------------------------------------------------------------
-- connector_instances (children of connectors via FK)
-- ----------------------------------------------------------------------
INSERT INTO public.connector_instances
  (connector_instance_id, owner_subject_id, connector_id, display_name, status,
   source_kind, source_binding_key, source_binding_json, created_at, updated_at) VALUES
  ('cin_gmail_01', 'owner_sub_1', 'https://registry.pdpp.org/connectors/gmail',
   'Gmail — personal', 'active', 'account', 'acct:gmail:me@example.com',
   '{"kind":"default_account"}'::jsonb, '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
  ('cin_claude_01', 'owner_sub_1', 'claude_code',
   'Claude Code — laptop', 'active', 'local_device', 'device:claude:laptop',
   '{"kind":"local_device"}'::jsonb, '2026-01-03T00:00:01Z', '2026-01-03T00:00:01Z'),
  ('cin_codex_01', 'owner_sub_1', 'codex',
   'Codex — laptop', 'active', 'local_device', 'device:codex:laptop',
   '{"kind":"local_device"}'::jsonb, '2026-01-03T00:00:02Z', '2026-01-03T00:00:02Z'),
  ('cin_spotify_01', 'owner_sub_1', 'spotify',
   'Spotify — me', 'active', 'account', 'acct:spotify:me',
   '{"kind":"default_account"}'::jsonb, '2026-01-03T00:00:03Z', '2026-01-03T00:00:03Z');

-- ----------------------------------------------------------------------
-- records + record hydration tail (record_changes, version_counter, blobs)
-- gmail (URL) and codex (wrapped local-device storage form) records.
-- ----------------------------------------------------------------------
INSERT INTO public.records
  (id, connector_id, stream, record_key, record_json, emitted_at, version, deleted,
   primary_key_text, connector_instance_id) VALUES
  -- record_json carries the stream's real `id` (primary key) and cursor
  -- field (gmail.messages=received_at, codex.sessions=last_event_at,
  -- spotify.recently_played=played_at) so the LIVE HTTP read path hydrates
  -- and paginates them after migration, not just the storage-layer SQL join.
  (1, 'https://registry.pdpp.org/connectors/gmail', 'messages', 'msg_1',
   '{"id":"msg_1","subject":"Welcome","from":"team@example.com","received_at":"2026-02-01T00:00:00Z"}'::jsonb, '2026-02-01T00:00:00Z', 1, false,
   'msg_1', 'cin_gmail_01'),
  (2, 'https://registry.pdpp.org/connectors/gmail', 'messages', 'msg_2',
   '{"id":"msg_2","subject":"Receipt","from":"shop@example.com","received_at":"2026-02-01T00:01:00Z"}'::jsonb, '2026-02-01T00:01:00Z', 2, false,
   'msg_2', 'cin_gmail_01'),
  (3, 'local-device:codex:cin_dev_codex_01', 'sessions', 'sess_1',
   '{"id":"sess_1","title":"Refactor","tokens":1200,"last_event_at":"2026-02-02T00:00:00Z"}'::jsonb, '2026-02-02T00:00:00Z', 1, false,
   'sess_1', 'cin_codex_01'),
  (4, 'spotify', 'recently_played', 'play_1',
   '{"id":"play_1","track":"Song A","ms":210000,"played_at":"2026-02-03T00:00:00Z"}'::jsonb, '2026-02-03T00:00:00Z', 1, false,
   'play_1', 'cin_spotify_01');

INSERT INTO public.record_changes
  (connector_id, stream, record_key, version, record_json, emitted_at, deleted, connector_instance_id) VALUES
  ('https://registry.pdpp.org/connectors/gmail', 'messages', 'msg_1', 1,
   '{"id":"msg_1","subject":"Welcome","from":"team@example.com","received_at":"2026-02-01T00:00:00Z"}'::jsonb, '2026-02-01T00:00:00Z', false, 'cin_gmail_01'),
  ('https://registry.pdpp.org/connectors/gmail', 'messages', 'msg_2', 2,
   '{"id":"msg_2","subject":"Receipt","from":"shop@example.com","received_at":"2026-02-01T00:01:00Z"}'::jsonb, '2026-02-01T00:01:00Z', false, 'cin_gmail_01'),
  ('local-device:codex:cin_dev_codex_01', 'sessions', 'sess_1', 1,
   '{"id":"sess_1","title":"Refactor","tokens":1200,"last_event_at":"2026-02-02T00:00:00Z"}'::jsonb, '2026-02-02T00:00:00Z', false, 'cin_codex_01');

INSERT INTO public.version_counter (connector_id, stream, max_version, connector_instance_id) VALUES
  ('https://registry.pdpp.org/connectors/gmail', 'messages', 2, 'cin_gmail_01'),
  ('local-device:codex:cin_dev_codex_01', 'sessions', 1, 'cin_codex_01'),
  ('spotify', 'recently_played', 1, 'cin_spotify_01');

INSERT INTO public.connector_state (connector_id, stream, state_json, updated_at, connector_instance_id) VALUES
  ('https://registry.pdpp.org/connectors/gmail', 'messages',
   '{"cursor":"2026-02-01T00:01:00Z"}'::jsonb, '2026-02-01T00:01:00Z', 'cin_gmail_01'),
  ('local-device:codex:cin_dev_codex_01', 'sessions',
   '{"cursor":"2026-02-02T00:00:00Z"}'::jsonb, '2026-02-02T00:00:00Z', 'cin_codex_01');

INSERT INTO public.blobs
  (blob_id, connector_id, stream, record_key, mime_type, size_bytes, sha256, data, connector_instance_id) VALUES
  ('blob_gmail_1', 'https://registry.pdpp.org/connectors/gmail', 'messages', 'msg_2',
   'application/pdf', 1024, 'abc123', '\x255044462d'::bytea, 'cin_gmail_01');

INSERT INTO public.blob_bindings
  (blob_id, connector_id, stream, record_key, json_path, connector_instance_id) VALUES
  ('blob_gmail_1', 'https://registry.pdpp.org/connectors/gmail', 'messages', 'msg_2',
   '/attachments/0', 'cin_gmail_01');

-- ----------------------------------------------------------------------
-- scheduler_run_history (connector_id column + source_json that the
-- inspect surface does NOT extract — column scan still rewrites the id).
-- ----------------------------------------------------------------------
INSERT INTO public.scheduler_run_history
  (id, connector_id, source_json, status, records_emitted, started_at, completed_at, attempt, connector_instance_id) VALUES
  (1, 'https://registry.pdpp.org/connectors/gmail',
   '{"kind":"connector","id":"https://registry.pdpp.org/connectors/gmail"}'::jsonb,
   'succeeded', 2, '2026-02-01T00:00:00Z', '2026-02-01T00:02:00Z', 1, 'cin_gmail_01');

-- ----------------------------------------------------------------------
-- grants — JSONB-embedded connector ids:
--   grant_json.$.source.id            (kind=connector)
--   storage_binding_json.$.connector_id
-- ----------------------------------------------------------------------
INSERT INTO public.grants
  (grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode, status, issued_at) VALUES
  ('grant_gmail_1', 'owner_sub_1', 'client_app_1',
   '{"connector_id":"https://registry.pdpp.org/connectors/gmail"}'::jsonb,
   '{"source":{"kind":"connector","id":"https://registry.pdpp.org/connectors/gmail"},"streams":["messages"]}'::jsonb,
   'read', 'active', '2026-02-01T00:00:00Z'),
  ('grant_claude_1', 'owner_sub_1', 'client_app_1',
   '{"connector_id":"claude_code"}'::jsonb,
   '{"source":{"kind":"connector","id":"claude_code"},"streams":["sessions"]}'::jsonb,
   'read', 'active', '2026-02-01T00:00:01Z'),
  ('grant_spotify_1', 'owner_sub_1', 'client_app_1',
   '{"connector_id":"spotify"}'::jsonb,
   '{"source":{"kind":"connector","id":"spotify"},"streams":["recently_played"]}'::jsonb,
   'read', 'active', '2026-02-01T00:00:02Z');

-- ----------------------------------------------------------------------
-- grant_packages + grant_package_members — source_json.$.id (kind=connector)
-- ----------------------------------------------------------------------
INSERT INTO public.grant_packages
  (package_id, subject_id, client_id, status, package_json, created_at, approved_at) VALUES
  ('pkg_1', 'owner_sub_1', 'client_app_1', 'active',
   '{"version":1,"package_id":"pkg_1","approved_source_count":2,"source_bounded_child_grants":["grant_gmail_1","grant_claude_1"]}'::jsonb,
   '2026-02-01T00:00:00Z', '2026-02-01T00:00:05Z');

INSERT INTO public.grant_package_members
  (package_id, grant_id, token_id, source_json, status, added_at) VALUES
  ('pkg_1', 'grant_gmail_1', 'tok_gmail_1',
   '{"kind":"connector","id":"https://registry.pdpp.org/connectors/gmail","connection_id":"cin_gmail_01"}'::jsonb,
   'active', '2026-02-01T00:00:05Z'),
  ('pkg_1', 'grant_claude_1', 'tok_claude_1',
   '{"kind":"connector","id":"claude_code","connection_id":"cin_claude_01"}'::jsonb,
   'active', '2026-02-01T00:00:05Z');

-- ----------------------------------------------------------------------
-- pending_consents — params_json.$.source_binding.id (kind=connector)
--                    and params_json.$.storage_binding.connector_id
-- ----------------------------------------------------------------------
INSERT INTO public.pending_consents
  (device_code, user_code, params_json, status, created_at, expires_at) VALUES
  ('dev_code_1', 'USER-1',
   '{"source_binding":{"kind":"connector","id":"https://registry.pdpp.org/connectors/gmail"},"storage_binding":{"connector_id":"https://registry.pdpp.org/connectors/gmail"}}'::jsonb,
   'pending', '2026-02-01T00:00:00Z', '2026-02-01T01:00:00Z');

COMMIT;

-- ----------------------------------------------------------------------
-- Backup-tier table seed (DDL + data). A backup_* table that holds a
-- URL-shaped connector_id. The migration MUST leave this untouched
-- unless --include-backup-tables is passed, which the harness asserts.
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_20260601_seed_records (
  id bigint NOT NULL,
  connector_id text NOT NULL,
  stream text NOT NULL,
  record_key text NOT NULL,
  record_json jsonb NOT NULL,
  emitted_at text NOT NULL,
  version bigint DEFAULT 1 NOT NULL,
  deleted boolean DEFAULT false NOT NULL,
  primary_key_text text NOT NULL,
  connector_instance_id text NOT NULL
);

INSERT INTO public.backup_20260601_seed_records
  (id, connector_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text, connector_instance_id) VALUES
  (1, 'https://registry.pdpp.org/connectors/gmail', 'messages', 'msg_1',
   '{"subject":"Welcome"}'::jsonb, '2026-02-01T00:00:00Z', 1, false, 'msg_1', 'cin_gmail_01');
