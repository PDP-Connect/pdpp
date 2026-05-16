#!/usr/bin/env node
// Read-only scheduler-loop probe for operators and agents.
//
// Hits the running reference server's `/_ref/schedules` listing and renders
// a structured verdict an agent can grep or parse: which schedules exist,
// which are eligible to actually fire, which are paused/ineligible, and
// which have never run. Designed to answer "are schedules actually firing
// inside the Docker `reference` container?" without spelunking server logs.
//
// Usage:
//   node reference-implementation/scripts/scheduler-doctor.mjs           # AS=http://localhost:7662
//   node reference-implementation/scripts/scheduler-doctor.mjs --json    # JSON to stdout only
//   AS_URL=... PDPP_OWNER_PASSWORD=... node ... scheduler-doctor.mjs
//
// Auth:
//   - When PDPP_OWNER_PASSWORD is set (the production/Docker default),
//     mint a short-lived owner-session cookie locally using the same
//     derivation as `server/owner-session.ts`.
//   - When unset (open local-dev mode), the server lets the request through.

import {
  OWNER_SESSION_COOKIE_NAME,
  deriveOwnerSessionSecret,
  encodeOwnerSession,
} from '../server/owner-session.ts';

const args = parseArgs(process.argv.slice(2));
const asUrl =
  args['as-url'] ||
  process.env.AS_URL ||
  process.env.PDPP_AS_URL ||
  `http://localhost:${process.env.AS_PORT || 7662}`;
const ownerPassword = process.env.PDPP_OWNER_PASSWORD || '';
const ownerSubjectId = process.env.PDPP_OWNER_SUBJECT_ID || 'owner_local';
const jsonOnly = !!args.json;

const cookieHeader = ownerPassword ? buildOwnerCookieHeader(ownerPassword, ownerSubjectId) : '';

const listingUrl = `${asUrl.replace(/\/$/, '')}/_ref/schedules`;
let listing;
try {
  const headers = {
    Accept: 'application/json',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
  const resp = await fetch(listingUrl, { headers });
  if (!resp.ok) {
    fail(`HTTP ${resp.status} ${resp.statusText} GET ${listingUrl}`, await safeText(resp));
  }
  listing = await resp.json();
} catch (err) {
  fail(`cannot reach ${listingUrl}: ${err?.message ?? err}`);
}

const schedules = Array.isArray(listing?.data) ? listing.data : [];
const verdicts = schedules.map(verdictFor);

const summary = {
  as_url: asUrl,
  total: verdicts.length,
  enabled: verdicts.filter((v) => v.enabled).length,
  automatic: verdicts.filter((v) => v.would_fire).length,
  ineligible: verdicts.filter((v) => v.enabled && !v.would_fire).length,
  never_ran: verdicts.filter((v) => v.would_fire && !v.last_started_at).length,
  has_active_run: verdicts.filter((v) => Boolean(v.active_run_id)).length,
  schedules: verdicts,
};

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  renderAscii(summary, process.stderr);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) {
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[tok.slice(2)] = argv[++i];
    } else {
      out[tok.slice(2)] = true;
    }
  }
  return out;
}

function buildOwnerCookieHeader(password, subjectId) {
  const secret = deriveOwnerSessionSecret(password);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cookieValue = encodeOwnerSession(
    { sub: subjectId, iat: nowSeconds, exp: nowSeconds + 300 },
    secret,
  );
  return `${OWNER_SESSION_COOKIE_NAME}=${encodeURIComponent(cookieValue)}`;
}

function verdictFor(entry) {
  const enabled = entry?.enabled === true;
  const effectiveMode = typeof entry?.effective_mode === 'string' ? entry.effective_mode : null;
  const ineligibilityReason =
    typeof entry?.ineligibility_reason === 'string' ? entry.ineligibility_reason : null;
  const wouldFire = enabled && effectiveMode === 'automatic' && !ineligibilityReason;
  return {
    connector_id: entry?.connector_id ?? null,
    enabled,
    effective_mode: effectiveMode,
    ineligibility_reason: ineligibilityReason,
    interval_seconds: entry?.interval_seconds ?? null,
    last_started_at: entry?.last_started_at ?? null,
    last_successful_at: entry?.last_successful_at ?? null,
    last_error_code: entry?.last_error_code ?? null,
    next_due_at: entry?.next_due_at ?? null,
    active_run_id: entry?.active_run_id ?? null,
    would_fire: wouldFire,
  };
}

function renderAscii(s, stream) {
  stream.write(`scheduler-doctor → ${s.as_url}\n`);
  stream.write(
    `  total=${s.total} enabled=${s.enabled} would-fire=${s.automatic} ineligible-when-enabled=${s.ineligible} never-ran=${s.never_ran} active=${s.has_active_run}\n`,
  );
  if (s.schedules.length === 0) {
    stream.write('  (no persisted schedules; create one via PUT /_ref/connectors/:id/schedule)\n');
    return;
  }
  for (const v of s.schedules) {
    const tag = v.would_fire ? 'FIRE' : v.enabled ? 'GATE' : 'PAUS';
    const last = v.last_started_at ?? 'never';
    const reason = v.ineligibility_reason ? `  ineligible="${v.ineligibility_reason}"` : '';
    stream.write(
      `  [${tag}] ${v.connector_id ?? '?'}  every ${v.interval_seconds}s  last=${last}  mode=${v.effective_mode ?? '?'}${reason}\n`,
    );
  }
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

function fail(message, detail = '') {
  process.stderr.write(`scheduler-doctor: ${message}\n`);
  if (detail) {
    process.stderr.write(`${detail}\n`);
  }
  process.exit(1);
}
