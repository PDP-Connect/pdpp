#!/usr/bin/env node
/**
 * PDPP Slack Connector (v0.3.0) — subprocess-wraps slackdump + reads its SQLite output.
 *
 * v0.3 adds a `canvases` stream (derived from FILE MODE='quip' rows joined
 * with each channel's canvas metadata) and declares four additional streams
 * (`stars`, `user_groups`, `reminders`, `dm_read_states`) that are P1 Layer-2
 * gaps but are NOT realizable from a slackdump archive today:
 *
 *   - stars: slackdump defines CHUNK type 8 STARRED_ITEMS but archive mode
 *     never emits chunks of that type (stars.list requires an API call
 *     slackdump doesn't run for archive workflows).
 *   - user_groups: requires usergroups.list; slackdump archive does not call it.
 *   - reminders: requires reminders.list; slackdump archive does not call it.
 *   - dm_read_states: conversations.info last_read/unread_count_display is
 *     stripped from archived channel DATA blobs.
 *
 * These four streams emit SKIP_RESULT at runtime with reason "slackdump does
 * not archive this". They are declared in the manifest so Layer-2 consumers
 * can plan around them and so an API-layer fallback (future) can fill them
 * without a manifest change.
 *
 * Slackdump is AGPL-3.0; we spawn it as a subprocess (arms-length) rather
 * than importing it as a Go library. PDPP's codebase is not covered by the
 * copyleft under FSF's own "mere aggregation" interpretation.
 *
 * Install: `go install github.com/rusq/slackdump/v4/cmd/slackdump@latest` or
 * download from https://github.com/rusq/slackdump/releases. Put on PATH or
 * set SLACKDUMP_BIN.
 *
 * Credentials (from env or INTERACTION kind=credentials):
 *   SLACK_WORKSPACE  subdomain (e.g. "myteam" from myteam.slack.com)
 *   SLACK_TOKEN      xoxc-... (from the browser app's JS bootstrap data)
 *   SLACK_COOKIE     d cookie value
 *
 * Options (read via src/connector-options.js; env today, manifest-declared
 * once connector-configuration-open-question.md resolves):
 *   SLACK_LOOKBACK_DAYS       (int, default 7)
 *   SLACK_CHANNEL_ALLOWLIST   (csv of channel IDs — maps to slackdump positional args)
 *   SLACK_CHANNEL_TYPES       (csv: public,private,im,mpim — default all four)
 *   SLACK_MEMBER_ONLY         (bool, default true — -member-only flag)
 *   SLACK_SKIP_FILES          (bool, default true)
 *
 * PDPP scope mapping:
 *   scope.streams[].time_range.from → slackdump -time-from
 *   scope.streams[].time_range.to   → slackdump -time-to
 *   scope.streams[].resources       → slackdump positional channel IDs
 *   state.archive_dir                → slackdump resume target (incremental)
 */

import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resourceSet, requireCredentialsOrAsk, passesTimeRange } from '../../src/scope-filters.js';
import { readOptions } from '../../src/connector-options.js';
import { emitToStdout, stringifyForJsonl } from '../../src/safe-emit.js';

const rl = createInterface({ input: process.stdin, terminal: false });
// WHY emitToStdout (not a bare process.stdout.write): large RECORDs can
// exceed the 64KB Linux pipe buffer. A raw write on a backpressured pipe
// returns false and drops the tail silently, producing truncated JSON on
// the runtime side. emitToStdout awaits 'drain' before resolving so the
// caller can backpressure naturally. Observed 2026-04-20: Slack ingest on
// the v0.3 archive crashed with "Expected ',' or '}' after property value
// in JSON at position 510" exactly at a pipe-buffer boundary.
const emit = (m) => emitToStdout(m);
// Keep stringifyForJsonl import for any spots that write sync string output.
void stringifyForJsonl;
const flushAndExit = (code) => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
};
const fail = (m, r = false) => { emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable: r } }); flushAndExit(1); };
const nowIso = () => new Date().toISOString();

let _ic = 0;
const nextInteractionId = () => `int_${Date.now()}_${++_ic}`;
async function sendInteractionAndWait(msg) {
  emit(msg);
  const reqId = msg.request_id;
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      try {
        const p = JSON.parse(line);
        if (p.type === 'INTERACTION_RESPONSE' && p.request_id === reqId) { rl.off('line', onLine); resolve(p); }
      } catch (err) { reject(err); }
    };
    rl.on('line', onLine);
  });
}

function safeAll(db, sql) {
  try { return db.prepare(sql).all(); } catch { return []; }
}

// Default timeout accommodates long-lived workspaces (10+ years) where a
// first-run archive of DMs + history can run 6-20h depending on file count
// and Slack rate-limit bursts. The cost of a too-high default is only "late
// failure signal" — slackdump will normally finish or error out well before
// this. Override via `SLACKDUMP_TIMEOUT_MS` env var.
function runSlackdump(args, { env, timeoutMs = Number(process.env.SLACKDUMP_TIMEOUT_MS) || 24 * 60 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const bin = process.env.SLACKDUMP_BIN || 'slackdump';
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const t = setTimeout(() => { child.kill(); reject(new Error('slackdump_timeout')); }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`slackdump_exit_${code}: ${stderr.slice(0, 400) || stdout.slice(0, 400)}`));
    });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Ensure slackdump has the workspace credentials cached. Idempotent — running
 * `workspace new` with the same token is a no-op if the workspace already
 * exists.
 */
async function ensureWorkspaceCached({ token, cookie, env }) {
  try {
    const { stdout } = await runSlackdump(['workspace', 'list'], { env, timeoutMs: 10000 });
    if (/=>/.test(stdout)) return;
  } catch { /* fall through to register */ }
  await runSlackdump(
    ['workspace', 'new', '-token', token, '-cookie', cookie, '-no-encryption'],
    { env, timeoutMs: 30000 },
  );
}

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  // Credentials — workspace is not a secret but belongs in the workspace context.
  let workspace = process.env.SLACK_WORKSPACE;
  let token = process.env.SLACK_TOKEN;
  let cookie = process.env.SLACK_COOKIE;
  const missing = [];
  if (!workspace) missing.push('SLACK_WORKSPACE');
  if (!token) missing.push('SLACK_TOKEN');
  if (!cookie) missing.push('SLACK_COOKIE');
  if (missing.length) {
    try {
      const creds = await requireCredentialsOrAsk({
        required: missing,
        connectorName: 'Slack',
        sendInteractionAndWait,
        nextInteractionId,
      });
      workspace = workspace || creds.SLACK_WORKSPACE;
      token = token || creds.SLACK_TOKEN;
      cookie = cookie || creds.SLACK_COOKIE;
    } catch (e) { return fail(e.message, false); }
  }

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const opts = readOptions(startMsg, {
    envPrefix: 'SLACK_',
    fields: {
      LOOKBACK_DAYS:     { parse: 'int',  default: 7 },
      CHANNEL_ALLOWLIST: { parse: 'csv',  default: [] },
      CHANNEL_TYPES:     { parse: 'csv',  default: ['public', 'private', 'im', 'mpim'] },
      MEMBER_ONLY:       { parse: 'bool', default: true },
      SKIP_FILES:        { parse: 'bool', default: true },
    },
  });

  // Resource filters (pre-fetch: pass as positional args; post-fetch: enforce too)
  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));
  const messagesScope = requested.get('messages');

  const dumpDir = join(homedir(), '.pdpp/slackdump', workspace);
  await mkdir(dumpDir, { recursive: true });
  const archivePath = join(dumpDir, 'archive');
  const sqlitePath = join(archivePath, 'slackdump.sqlite'); // default DB name under the archive dir

  // Incremental via slackdump resume, full via archive.
  // Resume path: (a) explicit state.archive_dir from a prior successful run,
  // or (b) an archive directory already exists on disk from a timed-out or
  // crashed prior run. Resuming salvages partial progress — slackdump picks
  // up from the last recorded chunk for each channel, so a previously-timed-
  // out 1.1 GB archive turns into "finish the rest" rather than "restart".
  const state = startMsg.state || {};
  // STATE is stream-keyed per Collection Profile: state is returned as
  // { <stream>: <cursor>, ... }. We write `archive_dir` into the messages
  // stream's cursor, so reads must qualify by that stream.
  const priorArchive = state.messages?.archive_dir || state.archive_dir; // fallback for pre-fix state
  const discoveredArchive = existsSync(archivePath) ? archivePath : null;
  const resumeTarget = (priorArchive && existsSync(priorArchive)) ? priorArchive : discoveredArchive;
  const useResume = !!resumeTarget;

  // Map time_range from messages stream scope into -time-from / -time-to.
  let timeFrom = null, timeTo = null;
  if (messagesScope?.time_range) {
    timeFrom = messagesScope.time_range.from || null;
    timeTo = messagesScope.time_range.to || null;
  }

  // IMPORTANT: we do NOT pass SLACK_WORKSPACE to slackdump — slackdump names
  // its cached workspaces by auto-detection (usually "default"), and setting
  // SLACK_WORKSPACE to the subdomain makes slackdump look for a cached
  // workspace with that literal name and fail. We keep `workspace` for our
  // own path naming + logging only.
  const childEnv = { ...process.env, SLACK_TOKEN: token, SLACK_COOKIE: cookie };
  delete childEnv.SLACK_WORKSPACE;
  const positionalChannels = [
    ...(resFilters.get('messages') ? [...resFilters.get('messages')] : []),
    ...opts.CHANNEL_ALLOWLIST,
  ];

  // Escape hatch: when the on-disk archive is valid but slackdump keeps
  // failing (e.g. Slack 500 errors on a specific channel, exit 6 loops),
  // set PDPP_SLACK_SKIP_SLACKDUMP=1 to ingest whatever's already on disk
  // without touching the network. This salvages a partial archive into
  // PDPP records instead of leaving the data stranded.
  const skipSlackdump = process.env.PDPP_SLACK_SKIP_SLACKDUMP === '1';

  try {
    if (skipSlackdump) {
      emit({ type: 'PROGRESS', message: `Skipping slackdump refresh (PDPP_SLACK_SKIP_SLACKDUMP=1); reading existing archive at ${archivePath}` });
      if (!existsSync(sqlitePath)) return fail(`PDPP_SLACK_SKIP_SLACKDUMP=1 but no archive found at ${sqlitePath}`, false);
    } else {
    emit({ type: 'PROGRESS', message: `Ensuring slackdump workspace is cached (SLACKDUMP_BIN=${process.env.SLACKDUMP_BIN || '<unset>'})` });
    await ensureWorkspaceCached({ token, cookie, env: childEnv });

    emit({ type: 'PROGRESS', message: useResume ? `Resuming slackdump at ${resumeTarget}${priorArchive ? '' : ' (discovered on disk)'}` : `Running slackdump archive → ${archivePath}` });
    // slackdump time format is 'YYYY-MM-DDTHH:MM:SS' (no Z, UTC implied).
    const toSlackTime = (iso) => iso ? iso.replace(/\..+$/, '').replace(/Z$/, '') : null;

    // WHY we ship an API-limits config: slackdump's defaults set tier_3 /
    // tier_4 retries to 3, which exhausts quickly on bot-heavy channels
    // (thousands of threads × even a low rate of 500 Internal Server Errors
    // from Slack = process aborts with exit 6). Bumping those retries to 20
    // aligns them with tier_2 (rate-limit retries), letting the same
    // exponential-backoff policy ride out server-side hiccups. Verified live
    // 2026-04-20: `eng_github` (C017NG64T24), 2,645 threads, exhausted
    // default retries. A handful of OTHER channels also hit 500s but
    // recovered — eng_github got unlucky on retry-count, not access.
    // See config/slackdump-api-config.toml.
    const apiConfigPath = new URL('../../config/slackdump-api-config.toml', import.meta.url).pathname;

    if (useResume) {
      // `resume` does not accept `-y` (unlike `archive`): passing it aborts
      // with "flag provided but not defined".
      // `-lookback` uses ISO 8601 duration syntax (e.g. "p1w", "p30d"), not
      // Go's `72h` — slackdump parses it with its own `p`-prefixed parser.
      const args = ['resume', '-no-encryption', '-api-config', apiConfigPath,
                    '-lookback', `p${opts.LOOKBACK_DAYS}d`, resumeTarget];
      await runSlackdump(args, { env: childEnv });
    } else {
      const args = ['archive', '-y', '-no-encryption', '-api-config', apiConfigPath,
                    '-o', archivePath];
      const tf = toSlackTime(timeFrom);
      const tt = toSlackTime(timeTo);
      if (tf) args.push('-time-from', tf);
      if (tt) args.push('-time-to', tt);
      if (opts.MEMBER_ONLY) args.push('-member-only');
      if (opts.SKIP_FILES) args.push('-files=false');
      // NOTE: CHANNEL_TYPES maps to `list channels -chan-types`; archive has
      // no equivalent flag. We filter post-fetch via channel.is_im/is_mpim/etc.
      args.push(...positionalChannels);
      await runSlackdump(args, { env: childEnv });
    }
    } // end: if (skipSlackdump) else
  } catch (e) {
    return fail(`slackdump failed: ${e.message}`, /timeout|ECONN/.test(e.message));
  }

  if (!existsSync(sqlitePath)) {
    return fail(`slackdump output not found at ${sqlitePath}`, false);
  }

  const db = new DatabaseSync(sqlitePath, { readOnly: true });

  const emittedAt = nowIso();
  let total = 0;
  const emitRecord = async (s, d) => {
    if (d.id == null) return;
    const rs = resFilters.get(s);
    if (rs && rs.size && !rs.has(String(d.id))) return;
    const scope = requested.get(s);
    if (scope?.time_range && !passesTimeRange(d, scope.time_range, 'sent_at')) return;
    await emit({ type: 'RECORD', stream: s, key: d.id, data: d, emitted_at: emittedAt });
    total++;
  };

  // Slackdump's sqlite schema stores most of the richness inside a DATA BLOB
  // (full Slack API JSON). Tables are UPPERCASE singular.
  // node:sqlite returns BLOB as Uint8Array, not Buffer — use TextDecoder.
  const td = new TextDecoder('utf-8');
  const parseBlob = (blob) => {
    if (!blob) return {};
    try {
      const s = typeof blob === 'string' ? blob
        : blob instanceof Uint8Array ? td.decode(blob)
        : String(blob);
      return JSON.parse(s);
    } catch { return {}; }
  };
  const tsToIso = (ts) => ts ? new Date(parseFloat(ts) * 1000).toISOString() : null;
  const epochToIso = (sec) => Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;

  if (requested.has('workspace')) {
    const rows = safeAll(db, `SELECT ID, TEAM, TEAM_ID, USERNAME, USER_ID, URL, ENTERPRISE_ID, DATA FROM WORKSPACE`);
    for (const r of rows) {
      const d = parseBlob(r.DATA);
      await emitRecord('workspace', {
        id: r.TEAM_ID ?? d.team_id ?? String(r.ID),
        name: r.TEAM ?? d.team ?? null,
        domain: d.domain ?? null,
        email_domain: d.email_domain ?? null,
        enterprise_id: r.ENTERPRISE_ID || null,
        enterprise_name: d.enterprise_name ?? null,
        url: r.URL ?? null,
        icon_url: d.icon?.image_230 ?? d.icon?.image_102 ?? null,
        authenticated_user_id: r.USER_ID ?? d.user_id ?? null,
        authenticated_username: r.USERNAME ?? d.user ?? null,
        authenticated_bot_id: d.bot_id || null,
        fetched_at: emittedAt,
      });
    }
  }

  if (requested.has('channels')) {
    // Dedupe across chunks; keep the latest (max CHUNK_ID) snapshot per ID.
    const rows = safeAll(db, `
      SELECT c.ID AS id, c.NAME AS name, c.DATA AS data
      FROM CHANNEL c
      JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM CHANNEL GROUP BY ID) m
        ON m.ID = c.ID AND m.mx = c.CHUNK_ID
    `);
    for (const r of rows) {
      const d = parseBlob(r.data);
      await emitRecord('channels', {
        id: r.id,
        name: r.name ?? d.name ?? null,
        name_normalized: d.name_normalized ?? null,
        is_channel: d.is_channel ?? null,
        is_group: d.is_group ?? null,
        is_im: d.is_im ?? null,
        is_mpim: d.is_mpim ?? null,
        is_private: d.is_private ?? null,
        is_shared: d.is_shared ?? null,
        is_ext_shared: d.is_ext_shared ?? null,
        is_org_shared: d.is_org_shared ?? null,
        is_archived: d.is_archived ?? null,
        is_general: d.is_general ?? null,
        is_member: d.is_member ?? null,
        is_read_only: d.is_read_only ?? null,
        creator: d.creator || null,
        created: d.created ?? null,
        created_at: epochToIso(d.created),
        topic: d.topic?.value ?? null,
        topic_creator: d.topic?.creator || null,
        topic_last_set: d.topic?.last_set ?? null,
        purpose: d.purpose?.value ?? null,
        purpose_creator: d.purpose?.creator || null,
        purpose_last_set: d.purpose?.last_set ?? null,
        num_members: d.num_members ?? null,
        user: d.user || null,
        shared_team_ids: Array.isArray(d.shared_team_ids) ? d.shared_team_ids : null,
        context_team_id: d.context_team_id ?? null,
        previous_names: Array.isArray(d.previous_names) ? d.previous_names : null,
        has_canvas: d.properties?.canvas ? !d.properties.canvas.is_empty : null,
        canvas_file_id: d.properties?.canvas?.file_id || null,
        posting_restricted: d.properties?.posting_restricted_to?.type != null,
        threads_restricted: d.properties?.threads_restricted_to?.type != null,
      });
    }
  }

  if (requested.has('channel_memberships')) {
    const rows = safeAll(db, `
      SELECT DISTINCT CHANNEL_ID, USER_ID FROM CHANNEL_USER
    `);
    for (const r of rows) {
      await emitRecord('channel_memberships', {
        id: `${r.CHANNEL_ID}:${r.USER_ID}`,
        channel_id: r.CHANNEL_ID,
        user_id: r.USER_ID,
        fetched_at: emittedAt,
      });
    }
  }

  if (requested.has('users')) {
    const rows = safeAll(db, `
      SELECT u.ID AS id, u.USERNAME AS username, u.DATA AS data
      FROM S_USER u
      JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM S_USER GROUP BY ID) m
        ON m.ID = u.ID AND m.mx = u.CHUNK_ID
    `);
    for (const r of rows) {
      const d = parseBlob(r.data);
      const profile = d.profile || {};
      await emitRecord('users', {
        id: r.id,
        team_id: d.team_id ?? null,
        name: r.username ?? d.name ?? null,
        real_name: d.real_name ?? null,
        real_name_normalized: profile.real_name_normalized ?? null,
        display_name: profile.display_name ?? null,
        display_name_normalized: profile.display_name_normalized ?? null,
        first_name: profile.first_name ?? null,
        last_name: profile.last_name ?? null,
        email: profile.email ?? null,
        phone: profile.phone ?? null,
        title: profile.title ?? null,
        status_text: profile.status_text || null,
        status_emoji: profile.status_emoji || null,
        status_expiration: profile.status_expiration ?? null,
        tz: d.tz ?? null,
        tz_label: d.tz_label ?? null,
        tz_offset: d.tz_offset ?? null,
        color: d.color || null,
        is_bot: d.is_bot ?? null,
        is_admin: d.is_admin ?? null,
        is_owner: d.is_owner ?? null,
        is_primary_owner: d.is_primary_owner ?? null,
        is_restricted: d.is_restricted ?? null,
        is_ultra_restricted: d.is_ultra_restricted ?? null,
        is_stranger: d.is_stranger ?? null,
        is_invited_user: d.is_invited_user ?? null,
        is_app_user: d.is_app_user ?? null,
        deleted: d.deleted ?? null,
        has_2fa: d.has_2fa ?? null,
        two_factor_type: d.two_factor_type || null,
        image_192_url: profile.image_192 ?? null,
        enterprise_id: d.enterprise_user?.enterprise_id || null,
        updated: d.updated ?? null,
      });
    }
  }

  // Messages, reactions, message_attachments share one pass for efficiency.
  let maxMessageTs = null;
  if (requested.has('messages') || requested.has('reactions') || requested.has('message_attachments')) {
    // Incremental sync: honor prior state.messages.last_ts by filtering in SQL.
    // Slack message TS strings collate lexically the same way they order
    // chronologically (fixed-width integer-dot-decimal), so string > works.
    //
    // KNOWN LIMITATION: filtering by ts > prior_ts misses thread replies that
    // arrive on old parents (parent ts from 2022, new reply in 2026). The
    // `cursor_field: "ts"` manifest declaration captures the naive cursor;
    // the "append with mutable children" gap is tracked as an open question
    // in cursor-finality-and-gap-awareness-open-question.md. For now:
    // first-run grabs everything, subsequent runs may miss late thread
    // replies unless the owner re-runs with a lookback or wipes state.
    const priorTs = state.messages?.last_ts || null;
    const tsParam = priorTs ? [priorTs] : [];
    const tsClause = priorTs ? 'WHERE m.TS > ?' : '';

    // Slackdump can store the same (CHANNEL_ID, TS) message across multiple
    // CHUNK_IDs (e.g. from channel enumeration + subsequent thread fetch).
    // Pick the latest chunk's row per (CHANNEL_ID, TS) to avoid duplicate
    // RECORDs on the wire.
    const stmt = db.prepare(`
      SELECT m.CHANNEL_ID, m.TS, m.THREAD_TS, m.IS_PARENT, m.TXT, m.NUM_FILES, m.DATA
      FROM MESSAGE m
      JOIN (
        SELECT CHANNEL_ID, TS, MAX(CHUNK_ID) AS mx
        FROM MESSAGE
        GROUP BY CHANNEL_ID, TS
      ) latest ON latest.CHANNEL_ID = m.CHANNEL_ID AND latest.TS = m.TS AND latest.mx = m.CHUNK_ID
      ${tsClause}
    `);
    const rows = stmt.all(...tsParam);

    if (priorTs) {
      await emit({
        type: 'PROGRESS',
        stream: 'messages',
        message: `incremental: filtering messages newer than ${priorTs} (${rows.length} to process)`,
      });
    }

    const wantMessages = requested.has('messages');
    const wantReactions = requested.has('reactions');
    const wantMsgAttachments = requested.has('message_attachments');

    for (const r of rows) {
      const d = parseBlob(r.DATA);
      const ts = r.TS;
      const sentAt = tsToIso(ts) ?? nowIso();
      const messageId = `${r.CHANNEL_ID}:${ts}`;
      const attachments = Array.isArray(d.attachments) ? d.attachments : [];
      const pinnedTo = Array.isArray(d.pinned_to) ? d.pinned_to : null;

      // Track the max ts seen in this run for the post-loop STATE emit.
      // Slack ts is a fixed-shape "seconds.micros" string; string compare
      // matches numeric order because both halves are zero-padded by Slack.
      if (ts && (maxMessageTs === null || ts > maxMessageTs)) maxMessageTs = ts;

      if (wantMessages) {
        await emitRecord('messages', {
          id: messageId,
          channel_id: r.CHANNEL_ID,
          user_id: d.user || null,
          bot_id: d.bot_id || null,
          team_id: d.team || d.team_id || null,
          client_msg_id: d.client_msg_id || null,
          ts,
          sent_at: sentAt,
          thread_ts: r.THREAD_TS || null,
          parent_user_id: d.parent_user_id || null,
          is_thread_parent: r.IS_PARENT === 1 || !!d.reply_count,
          reply_count: d.reply_count ?? null,
          reply_user_ids: Array.isArray(d.reply_users) ? d.reply_users : null,
          latest_reply: d.latest_reply || null,
          subtype: d.subtype || null,
          is_tombstone: d.subtype === 'tombstone',
          text: r.TXT ?? d.text ?? null,
          edited_ts: d.edited?.ts || null,
          edited_by: d.edited?.user || null,
          has_files: (r.NUM_FILES ?? 0) > 0 || Array.isArray(d.files),
          file_count: (r.NUM_FILES ?? null) ?? (Array.isArray(d.files) ? d.files.length : null),
          has_attachments: attachments.length > 0,
          attachment_count: attachments.length || null,
          has_blocks: Array.isArray(d.blocks) && d.blocks.length > 0,
          reaction_count: Array.isArray(d.reactions) ? d.reactions.reduce((a, x) => a + (x.count ?? (x.users?.length || 0)), 0) : 0,
          is_pinned: pinnedTo != null && pinnedTo.length > 0,
          pinned_to: pinnedTo,
          metadata_event_type: d.metadata?.event_type || null,
        });
      }

      if (wantReactions && Array.isArray(d.reactions)) {
        for (const reaction of d.reactions) {
          const name = reaction?.name;
          if (!name) continue;
          const users = Array.isArray(reaction.users) ? reaction.users : [];
          for (const u of users) {
            await emitRecord('reactions', {
              id: `${messageId}:${name}:${u}`,
              message_id: messageId,
              channel_id: r.CHANNEL_ID,
              user_id: u,
              emoji: name,
            });
          }
        }
      }

      if (wantMsgAttachments) {
        for (let i = 0; i < attachments.length; i++) {
          const a = attachments[i] || {};
          await emitRecord('message_attachments', {
            id: `${messageId}:att:${i}`,
            message_id: messageId,
            channel_id: r.CHANNEL_ID,
            index: i,
            fallback: a.fallback ?? null,
            service_name: a.service_name ?? null,
            service_icon: a.service_icon ?? null,
            title: a.title ?? null,
            title_link: a.title_link ?? null,
            text: a.text ?? null,
            from_url: a.from_url ?? null,
            image_url: a.image_url ?? null,
            thumb_url: a.thumb_url ?? null,
            author_name: a.author_name ?? null,
            author_link: a.author_link ?? null,
            color: a.color ?? null,
          });
        }
      }
    }
  }

  if (requested.has('files')) {
    // Exclude quip/canvas files from the generic `files` stream — they are
    // first-class records in the `canvases` stream (v0.3). Other file modes
    // (hosted, snippet, external, tombstone) still flow here.
    const rows = safeAll(db, `
      SELECT f.ID AS id, f.FILENAME AS filename, f.URL AS url, f.MODE AS mode, f.DATA AS data
      FROM FILE f
      JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM FILE GROUP BY ID) m
        ON m.ID = f.ID AND m.mx = f.CHUNK_ID
      WHERE f.MODE != 'quip'
    `);
    for (const r of rows) {
      const d = parseBlob(r.data);
      await emitRecord('files', {
        id: r.id,
        name: r.filename ?? d.name ?? null,
        title: d.title ?? null,
        mimetype: d.mimetype ?? null,
        filetype: d.filetype ?? null,
        pretty_type: d.pretty_type ?? null,
        size: d.size ?? null,
        created: d.created ?? null,
        created_at: epochToIso(d.created),
        uploader_id: d.user || null,
        is_public: d.is_public ?? null,
        is_external: d.is_external ?? null,
        is_starred: d.is_starred ?? null,
        external_type: d.external_type || null,
        mode: r.mode ?? d.mode ?? null,
        permalink: d.permalink ?? null,
        url_private: d.url_private ?? r.url ?? null,
        original_w: d.original_w ?? null,
        original_h: d.original_h ?? null,
      });
    }
  }

  if (requested.has('canvases')) {
    // Canvases are stored as FILE rows with MODE='quip' (mimetype
    // application/vnd.slack-docs). A single canvas can appear multiple times
    // across CHUNK_IDs (channel share + thread shares); dedupe on file ID by
    // picking the latest chunk. We also look up the owning channel's
    // properties.canvas blob to surface is_empty / quip_thread_id, which sit
    // on the channel record rather than the file record.
    //
    // The archive does NOT include canvas BODY content — only metadata and
    // an authenticated files.slack.com URL. `content_markdown` is therefore
    // always null here; if/when slackdump or an API-layer fallback fetches
    // the body, this field is where it belongs.
    const canvasRows = safeAll(db, `
      SELECT f.ID AS id, f.FILENAME AS filename, f.URL AS url, f.CHANNEL_ID AS channel_id,
             f.MESSAGE_ID AS message_id, f.DATA AS data
      FROM FILE f
      JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM FILE GROUP BY ID) m
        ON m.ID = f.ID AND m.mx = f.CHUNK_ID
      WHERE f.MODE = 'quip'
    `);
    // Map channel_id -> { file_id, is_empty, quip_thread_id } from latest-chunk channel data.
    const channelCanvasIndex = new Map();
    const chanRows = safeAll(db, `
      SELECT c.ID AS id, c.DATA AS data
      FROM CHANNEL c
      JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM CHANNEL GROUP BY ID) m
        ON m.ID = c.ID AND m.mx = c.CHUNK_ID
    `);
    for (const r of chanRows) {
      const d = parseBlob(r.data);
      const cv = d.properties?.canvas;
      if (cv?.file_id) {
        channelCanvasIndex.set(cv.file_id, {
          channel_id: r.id,
          is_empty: cv.is_empty ?? null,
          quip_thread_id: cv.quip_thread_id || null,
        });
      }
    }
    for (const r of canvasRows) {
      const d = parseBlob(r.data);
      const chanMeta = channelCanvasIndex.get(r.id) || {};
      const createdSec = d.created ?? null;
      const updatedSec = d.updated ?? d.timestamp ?? null;
      await emitRecord('canvases', {
        id: r.id,
        file_id: r.id,
        channel_id: r.channel_id || chanMeta.channel_id || null,
        message_id: r.message_id != null ? String(r.message_id) : null,
        title: d.title ?? null,
        name: r.filename ?? d.name ?? null,
        author_id: d.user || null,
        is_empty: chanMeta.is_empty ?? null,
        quip_thread_id: chanMeta.quip_thread_id || null,
        content_bytes: d.size ?? null,
        content_markdown: null,
        mimetype: d.mimetype ?? null,
        filetype: d.filetype ?? null,
        pretty_type: d.pretty_type ?? null,
        created: createdSec,
        created_at: epochToIso(createdSec),
        updated: updatedSec,
        updated_at: epochToIso(updatedSec),
        permalink: d.permalink ?? null,
        url_private: d.url_private ?? r.url ?? null,
      });
    }
  }

  // Streams declared in the manifest for Layer-2 completeness but NOT
  // realizable from a slackdump archive today. If a caller requests them we
  // emit SKIP_RESULT so the run completes cleanly without spoofing empty data.
  const unavailableStreams = [
    { name: 'stars',          reason: 'slackdump does not archive starred/saved items (stars.list is not called in archive mode)' },
    { name: 'user_groups',    reason: 'slackdump does not archive user groups (usergroups.list is not called in archive mode)' },
    { name: 'reminders',      reason: 'slackdump does not archive reminders (reminders.list is not called in archive mode)' },
    { name: 'dm_read_states', reason: 'slackdump archive strips last_read / unread_count_display from channel data' },
  ];
  for (const s of unavailableStreams) {
    if (requested.has(s.name)) {
      emit({ type: 'SKIP_RESULT', stream: s.name, reason: 'not_available', message: s.reason });
    }
  }

  // Per-stream STATE checkpoints. Per Collection Profile spec, STATE is emitted
  // per stream with a cursor object opaque to the runtime but interpreted by
  // this connector on the next run.
  //
  // - messages: `last_ts` is the max Slack ts seen this run. Preserve the
  //   existing max if we filtered incrementally and saw nothing new (otherwise
  //   the cursor would go backward after a no-op run).
  // - other mutable_state streams (channels, users, files, canvases): low
  //   cardinality, we full-sync each run; the cursor is just a freshness
  //   marker for visibility.
  // `archive_dir` moves onto the messages cursor so `-resume` continues to
  // work; it's workspace-global but messages is the canonical stream for
  // slackdump state on the PDPP side.
  const priorMaxTs = state.messages?.last_ts || null;
  const committedMaxTs = (maxMessageTs && (priorMaxTs === null || maxMessageTs > priorMaxTs))
    ? maxMessageTs : priorMaxTs;
  emit({
    type: 'STATE',
    stream: 'messages',
    cursor: {
      last_ts: committedMaxTs,
      archive_dir: archivePath,
      fetched_at: nowIso(),
    },
  });
  // Declare the other incremental streams' cursors as synced-now. Small
  // volume + full-refresh semantics, so no per-record filter — but the
  // spec wants a STATE per incremental stream.
  for (const stream of ['channels', 'users', 'files', 'canvases', 'workspace']) {
    if (requested.has(stream)) {
      emit({ type: 'STATE', stream, cursor: { synced_at: nowIso() } });
    }
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: /ECONN|timeout/i.test(msg) } });
  flushAndExit(1);
});
