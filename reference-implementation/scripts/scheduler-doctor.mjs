#!/usr/bin/env node
// Read-only scheduler-loop probe for operators and agents.
//
// Hits the running reference server's `/_ref/schedules` listing and cross-
// references it against `/_ref/connectors` so an agent can grep or parse
// the structured verdict and tell the difference between:
//   - FIRE    enabled schedule, currently auto-eligible (would actually fire)
//   - GATE    enabled schedule whose connector manifest has since drifted
//             to manual/paused/background-unsafe (ineligibility_reason set)
//   - PAUS    persisted schedule explicitly disabled
//   - NOSCHED registered connector with automatic, background-safe refresh
//             policy but no persisted schedule row (operator never enrolled)
//   - MANUAL  registered connector whose refresh policy is manual/paused
//             or not background-safe; no row is the correct state
//
// Designed to answer "are schedules actually firing inside the Docker
// `reference` container?" and "which auto-eligible connectors am I not
// running yet?" without spelunking server logs.
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

const baseUrl = asUrl.replace(/\/$/, '');
const headers = {
  Accept: 'application/json',
  ...(cookieHeader ? { Cookie: cookieHeader } : {}),
};

const listingUrl = `${baseUrl}/_ref/schedules`;
let listing;
try {
  const resp = await fetch(listingUrl, { headers });
  if (!resp.ok) {
    fail(`HTTP ${resp.status} ${resp.statusText} GET ${listingUrl}`, await safeText(resp));
  }
  listing = await resp.json();
} catch (err) {
  fail(`cannot reach ${listingUrl}: ${err?.message ?? err}`);
}

// Cross-reference against the registered connector catalog so the doctor
// can surface auto-eligible connectors the operator never enrolled.
// `/_ref/connectors` is reachable best-effort; if it isn't (older
// reference build, owner-auth mismatch, network blip), the doctor still
// returns persisted-schedule verdicts unchanged.
const connectorsUrl = `${baseUrl}/_ref/connectors`;
let connectorsListing = null;
try {
  const resp = await fetch(connectorsUrl, { headers });
  if (resp.ok) {
    connectorsListing = await resp.json();
  }
} catch {
  // Silent fallback: catalog cross-reference is opportunistic, not required.
}

const schedules = Array.isArray(listing?.data) ? listing.data : [];
const persistedVerdicts = schedules.map(verdictFor);
const persistedIds = new Set(
  persistedVerdicts.map((v) => v.connector_id).filter((id) => typeof id === 'string'),
);

const registeredConnectors = Array.isArray(connectorsListing?.data) ? connectorsListing.data : [];
const enrollmentVerdicts = registeredConnectors
  .filter((c) => typeof c?.connector_id === 'string' && !persistedIds.has(c.connector_id))
  .map(enrollmentVerdictFor);

const verdicts = [...persistedVerdicts, ...enrollmentVerdicts];

const summary = {
  as_url: asUrl,
  total: persistedVerdicts.length,
  enabled: persistedVerdicts.filter((v) => v.enabled).length,
  automatic: persistedVerdicts.filter((v) => v.would_fire).length,
  ineligible: persistedVerdicts.filter((v) => v.enabled && !v.would_fire).length,
  never_ran: persistedVerdicts.filter((v) => v.would_fire && !v.last_started_at).length,
  has_active_run: persistedVerdicts.filter((v) => Boolean(v.active_run_id)).length,
  eligible_unscheduled: enrollmentVerdicts.filter((v) => v.kind === 'no_schedule_eligible').length,
  manual_unscheduled: enrollmentVerdicts.filter((v) => v.kind === 'no_schedule_manual').length,
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
    kind: 'persisted',
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

function enrollmentVerdictFor(connector) {
  const policy =
    connector?.refresh_policy && typeof connector.refresh_policy === 'object'
      ? connector.refresh_policy
      : null;
  const mode = typeof policy?.recommended_mode === 'string' ? policy.recommended_mode : null;
  const backgroundSafe = policy?.background_safe;
  const eligible = mode === 'automatic' && backgroundSafe !== false;
  return {
    kind: eligible ? 'no_schedule_eligible' : 'no_schedule_manual',
    connector_id: connector.connector_id,
    enabled: false,
    effective_mode: null,
    ineligibility_reason: eligible ? null : enrollmentIneligibilityReason(mode, backgroundSafe),
    interval_seconds: null,
    last_started_at: null,
    last_successful_at: null,
    last_error_code: null,
    next_due_at: null,
    active_run_id: null,
    would_fire: false,
    recommended_mode: mode,
    background_safe: typeof backgroundSafe === 'boolean' ? backgroundSafe : null,
  };
}

function enrollmentIneligibilityReason(mode, backgroundSafe) {
  if (mode === 'manual') return 'manifest refresh_policy recommends manual';
  if (mode === 'paused') return 'manifest refresh_policy recommends paused';
  if (backgroundSafe === false) return 'manifest refresh_policy is not background-safe';
  if (!mode) return 'manifest declares no refresh_policy';
  return `manifest refresh_policy mode=${mode}`;
}

function renderAscii(s, stream) {
  stream.write(`scheduler-doctor → ${s.as_url}\n`);
  stream.write(
    `  total=${s.total} enabled=${s.enabled} would-fire=${s.automatic} ineligible-when-enabled=${s.ineligible} never-ran=${s.never_ran} active=${s.has_active_run} eligible-unscheduled=${s.eligible_unscheduled} manual-unscheduled=${s.manual_unscheduled}\n`,
  );
  if (s.schedules.length === 0) {
    stream.write('  (no persisted schedules and no registered connectors)\n');
    return;
  }
  for (const v of s.schedules) {
    const tag = verdictTag(v);
    const reason = v.ineligibility_reason ? `  ineligible="${v.ineligibility_reason}"` : '';
    if (v.kind === 'persisted') {
      const last = v.last_started_at ?? 'never';
      stream.write(
        `  [${tag}] ${v.connector_id ?? '?'}  every ${v.interval_seconds}s  last=${last}  mode=${v.effective_mode ?? '?'}${reason}\n`,
      );
    } else {
      stream.write(
        `  [${tag}] ${v.connector_id ?? '?'}  no schedule row  policy=${v.recommended_mode ?? '?'}/background_safe=${v.background_safe ?? '?'}${reason}\n`,
      );
    }
  }
}

function verdictTag(v) {
  if (v.kind === 'no_schedule_eligible') return 'NOSCHED';
  if (v.kind === 'no_schedule_manual') return 'MANUAL';
  if (v.would_fire) return 'FIRE';
  if (v.enabled) return 'GATE';
  return 'PAUS';
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
