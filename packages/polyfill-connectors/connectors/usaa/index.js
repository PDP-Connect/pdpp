#!/usr/bin/env node
/**
 * PDPP USAA Connector (v0.2.0)
 *
 * Uses shared Playwright persistent profile. Drives real selectors captured
 * from a live session on 2026-04-19.
 *
 * Streams: accounts, transactions, transfers, bill_payments,
 *          scheduled_transactions, credit_card_billing, statements,
 *          inbox_messages, external_accounts.
 *
 * Transactions path: drive the USAA "Export" button → "Select Date Range"
 * CSV flow. Primary key is a synthetic SHA-256 hash since USAA does not
 * expose transaction IDs (documented design choice — see design-notes/usaa.md).
 *
 * Session: cookie-based probe on UsaaMbWebMemberLoggedIn + LtpaToken2.
 * On session death, emits INTERACTION manual_action → inbox.
 */

import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { readFile, unlink, readdir } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBrowser } from '../../src/browser-profile.js';
import { ensureUsaaSession } from '../../src/auto-login/usaa.js';
import { resourceSet } from '../../src/scope-filters.js';
import { stringifyForJsonl } from '../../src/safe-emit.js';
import { hydrateStatementPdfs, parsePdfStatement, fileUrlForPath } from './statement-pdfs.js';

const rl = createInterface({ input: process.stdin, terminal: false });
function emit(msg) { process.stdout.write(stringifyForJsonl(msg)); }
function flushAndExit(code) {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
}
function fail(m, retryable = false) {
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable } });
  flushAndExit(1);
}
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let interactionCounter = 0;
const nextInteractionId = () => `int_${Date.now()}_${++interactionCounter}`;
async function sendInteractionAndWait(msg) {
  emit(msg);
  const reqId = msg.request_id;
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'INTERACTION_RESPONSE' && parsed.request_id === reqId) { rl.off('line', onLine); resolve(parsed); }
      } catch (err) { reject(err); }
    };
    rl.on('line', onLine);
  });
}

function hashId(s) { return createHash('sha256').update(s).digest('hex').slice(0, 32); }
function currencyToCents(s) {
  if (!s) return null;
  const m = String(s).match(/-?\$?([\d,]+\.\d{2})/);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, '')) * (/^-|\(/.test(s) ? -1 : 1);
  return Math.round(num * 100);
}
function isoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// Legacy passive probe retained for reference; real session management goes
// through ensureUsaaSession which can drive re-login when dead.
// eslint-disable-next-line no-unused-vars
async function sessionProbe(context) {
  const cookies = await context.cookies('https://www.usaa.com/');
  const loggedIn = cookies.find((c) => c.name === 'UsaaMbWebMemberLoggedIn');
  if (loggedIn && loggedIn.value && loggedIn.value !== 'false') return true;
  return cookies.some((c) => /^(LtpaToken2|AST|MemberGlobalSession)$/.test(c.name));
}

// ─── Account extraction from the /my/usaa dashboard ───────────────────────

async function extractAccounts(page) {
  await page.goto('https://www.usaa.com/my/usaa', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('a[href^="/my/checking"], a[href^="/my/credit-card"], a[href^="/my/external-account"]', { timeout: 20000 }).catch(() => {});
  await sleep(4000);
  return page.evaluate(() => {
    const out = [];
    const links = document.querySelectorAll('a[href^="/my/checking"], a[href^="/my/savings"], a[href^="/my/credit-card"], a[href^="/my/external-account"], a[href^="/my/loan"], a[href^="/my/mortgage"], a[href^="/my/investing"], a[href^="/my/retirement"]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
      // Skip nav/CTA links that happen to match the URL prefix but have generic text.
      if (!text || text.length < 12 || /^(Get started|Add account|View|Manage|Open|Apply|Browse)/i.test(text)) continue;
      // Type from URL stem.
      const typeMatch = href.match(/^\/my\/([^/?]+)/);
      const accountType = typeMatch ? typeMatch[1] : 'unknown';
      const idMatch = href.match(/(?:accountId|acctId)=([^&]+)/);
      const accountId = idMatch ? decodeURIComponent(idMatch[1]) : null;
      // Text sample: "Checking Ending in 3 6 0 2 *3602 $405.57 $405.57 View Details"
      const last4Match = text.match(/\*(\d{4})/);
      const name = text.split(/\bEnding in\b|\bending in\b/i)[0].trim();
      const amounts = [...text.matchAll(/\$([\d,]+\.\d{2})/g)].map((m) => m[1]);
      const balanceCents = amounts[0] ? Math.round(Number(amounts[0].replace(/,/g, '')) * 100) : null;
      out.push({
        account_id_raw: accountId,
        account_url: href,
        account_type: accountType,
        name: name || null,
        last_four: last4Match ? last4Match[1] : null,
        balance_cents: balanceCents,
        raw_text: text.slice(0, 200),
      });
    }
    return out;
  });
}

// ─── CSV export driver for transactions ───────────────────────────────────

function mmddyyyy(iso) {
  // iso = "YYYY-MM-DD"
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

// Locate the Export affordance on the current account page. Checking/savings
// summary pages surface it as `button.ent-as-utility-bar__item.export`.
// Credit-card summary pages surface it as
// `button.as_credit__utility-bar-item.as_credit__export` (verified live
// 2026-04-20 via scripts/usaa-cc-walk.mjs). We try both exact classes first,
// then fall back to any button whose text is literally "Export".
async function findExportAffordance(page) {
  const bankClass = page.locator('button.ent-as-utility-bar__item.export');
  if (await bankClass.count().catch(() => 0)) return bankClass.first();

  const creditClass = page.locator('button.as_credit__utility-bar-item.as_credit__export');
  if (await creditClass.count().catch(() => 0)) return creditClass.first();

  // Fallback: any button whose visible text is exactly "Export" (case-insensitive).
  const buttonText = page.locator('button, [role="button"]').filter({ hasText: /^\s*Export\s*$/i });
  if (await buttonText.count().catch(() => 0)) return buttonText.first();

  return null;
}

// Quick DOM fingerprint for failure diagnostics — emitted with SKIP_RESULT so
// the next connector operator has evidence of what the page actually contained
// without having to re-drive 2FA themselves. Kept terse to stay within
// emit-line size limits.
async function capturePageDiagnostics(page) {
  return page.evaluate(() => {
    const take = (sel, max = 8) => [...document.querySelectorAll(sel)]
      .slice(0, max)
      .map((el) => ({
        tag: el.tagName,
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50),
        cls: (el.className || '').toString().slice(0, 80),
        id: el.id || null,
      }));
    return {
      url: location.href,
      title: document.title,
      has_utility_bar: !!document.querySelector('.ent-as-utility-bar, [class*="utility-bar" i]'),
      export_candidates: take('button, [role="button"]')
        .filter((c) => /export|download/i.test(c.text)),
      nav_candidates: take('a[href*="/my/credit-card"], a[role="tab"], [role="tab"]'),
      dialogs_open: document.querySelectorAll('[role="dialog"]').length,
    };
  }).catch(() => null);
}

// Navigate to the account view that surfaces Export. For checking/savings the
// account summary URL works. For credit-card accounts the summary page may
// not have the utility bar — we try the landing URL first, then a handful of
// sibling paths (/activity, /transactions) that modern-bank SPAs commonly use.
async function locateExportPage(page, accountUrl, _accountType) {
  // Verified 2026-04-20 that the bare `a.account_url` lands on a page with
  // the Export affordance for all three product variants:
  //   checking/savings → button.ent-as-utility-bar__item.export
  //   credit-card     → button.as_credit__utility-bar-item.as_credit__export
  // No sibling `/activity`/`/transactions` sub-routes exist — those 404.
  const candidates = [accountUrl];

  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      continue;
    }
    await sleep(6000);
    const btn = await findExportAffordance(page);
    if (btn) return { url, export: btn };
  }
  return null;
}

async function driveExport(_context, page, accountUrl, { sinceDate, untilDate, accountType = 'unknown', onDiagnostics }) {
  // Returns a path to a downloaded CSV, or null if USAA didn't cooperate.
  //
  // Selectors verified live on 2026-04-19 (checking/savings only):
  //   - Export button:      button.ent-as-utility-bar__item.export
  //   - Date-range select:  select[name="selectionType"] → option "date-range"
  //   - From/End inputs:    input[name="fromDate"] / input[name="endDate"]
  //                         (React self-formatting, requires pressSequentially
  //                         not fill)
  //   - Submit in dialog:   [role="dialog"] button[type="submit"]
  //
  // Credit-card export UI was NOT verified live on 2026-04-19: the USAA
  // session died (OAuth bounce to /my/logon) before the credit-card UI
  // could be inspected, and re-authing is gated on 2FA that we don't want
  // to trigger a second time in the same session. This function therefore:
  //   1. tries the checking/savings selector pattern first,
  //   2. falls through to a handful of sibling activity routes for
  //      credit-card accounts,
  //   3. emits a diagnostic fingerprint via the onDiagnostics callback
  //      when the Export button can't be located or the dialog opens in
  //      an unexpected shape, so the next run has evidence to adapt.
  // See design note "Fallback path: DOM scrape" in
  // openspec/changes/add-polyfill-connector-system/design-notes/usaa.md.

  const located = await locateExportPage(page, accountUrl, accountType);
  if (!located) {
    if (onDiagnostics) {
      const diag = await capturePageDiagnostics(page);
      onDiagnostics({ phase: 'no_export_affordance', diag });
    }
    return null;
  }

  try {
    await located.export.click({ timeout: 5000 });
  } catch (err) {
    if (onDiagnostics) {
      const diag = await capturePageDiagnostics(page);
      onDiagnostics({ phase: 'export_click_failed', diag, error: err.message.slice(0, 160) });
    }
    return null;
  }
  await sleep(2500);

  // Verify the date-range dialog we expect actually opened. If not (credit-card
  // flow may present a different modal entirely — e.g., "pick statement period"
  // — instead of a free date range), bail with diagnostics rather than thrash
  // against inputs that don't exist. This replaces the previous silent-failure
  // path where the code would press keys into nothing and then time out on
  // the download event.
  const selectCount = await page.locator('[role="dialog"] select[name="selectionType"], select[name="selectionType"]').count().catch(() => 0);
  if (!selectCount) {
    if (onDiagnostics) {
      const base = await capturePageDiagnostics(page);
      const dialogHtml = await page.locator('[role="dialog"]').first().innerHTML().catch(() => null);
      onDiagnostics({
        phase: 'export_dialog_unexpected_shape',
        diag: {
          ...base,
          dialog_html_preview: dialogHtml ? dialogHtml.replace(/\s+/g, ' ').slice(0, 600) : null,
        },
      });
    }
    await page.keyboard.press('Escape').catch(() => {});
    return null;
  }

  // Select "Select Date Range" in the native select
  await page.selectOption('select[name="selectionType"]', 'date-range').catch(() => {});
  await sleep(1500);

  // Fill From and End date inputs. USAA uses self-formatting React inputs
  // that need real keystrokes (page.fill skips React's validators). Input
  // names differ by product variant (verified live 2026-04-20):
  //   checking/savings : fromDate / endDate
  //   credit-card      : startDate / endDate (endDate pre-populates with today)
  const fromIn = page.locator('input[name="fromDate"], input[name="startDate"]').first();
  const endIn = page.locator('input[name="endDate"]').first();
  await fromIn.click().catch(() => {});
  // Select all + delete first in case the field pre-populated (CC endDate does).
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await fromIn.pressSequentially(mmddyyyy(sinceDate), { delay: 30 }).catch(() => {});
  await endIn.click().catch(() => {});
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await endIn.pressSequentially(mmddyyyy(untilDate), { delay: 30 }).catch(() => {});
  await sleep(1500);

  // Let the SPA reconcile form state after the dates are filled.
  await sleep(1500);

  // Prepare to capture the download (USAA can take 2+ minutes for multi-year ranges)
  const tempDir = mkdtempSync(join(tmpdir(), 'usaa-export-'));
  const downloadPromise = page.waitForEvent('download', { timeout: 180000 });

  // Submit — the primary button in the dialog. Scope to role=dialog so we
  // don't accidentally click the page's background "Export" link.
  const submit = page.locator('[role="dialog"] button[type="submit"]').first();
  await submit.click().catch(() => {});

  // Race download against an in-dialog error message — USAA surfaces
  // "No transactions" style errors for empty ranges without cancelling.
  //
  // BUG-PREVENTION: the error locator's `.waitFor({ timeout: 15000 })` rejects
  // if the error element never appears (the normal/happy case — USAA hasn't
  // decided whether to give us data yet). We must NOT let that rejection
  // resolve the Promise.race as `null`, or we'll bail after 15s while the
  // download is still 1-2 minutes out. Catch returns a never-resolving
  // Promise so the race is driven purely by (a) actual download, (b) actual
  // error element, or (c) downloadPromise's 180s timeout rejecting.
  const errorPromise = page.locator('[role="dialog"] [class*="errorMessage"]:not(:empty), [role="dialog"] :text-matches("no transactions|nothing to export", "i")')
    .first()
    .waitFor({ state: 'visible', timeout: 180000 })
    .then(() => ({ kind: 'error' }))
    .catch(() => new Promise(() => {})); // never resolve if no error appears

  let download = null;
  try {
    const outcome = await Promise.race([
      downloadPromise.then((d) => ({ kind: 'download', d })),
      errorPromise,
    ]);
    if (!outcome || outcome.kind === 'error') {
      rmSync(tempDir, { recursive: true, force: true });
      await page.locator('[role="dialog"] #export-cancel-button').click().catch(() => {});
      return null;
    }
    download = outcome.d;
    const targetPath = join(tempDir, download.suggestedFilename() || 'usaa-export.csv');
    await download.saveAs(targetPath);
    return targetPath;
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    return null;
  }
}

// ─── CSV parsing ──────────────────────────────────────────────────────────

function parseCsv(text) {
  // Minimal CSV parser — USAA exports are simple quoted-comma form.
  const rows = [];
  let cur = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuote = false;
      else field += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); field = ''; rows.push(cur); cur = []; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

function rowsToTransactions(rows, { accountId, accountName }) {
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idxDate = header.findIndex((h) => /date/i.test(h));
  const idxDesc = header.findIndex((h) => /^(description|payee|merchant|memo)$/i.test(h));
  const idxOrig = header.findIndex((h) => /original/i.test(h));
  const idxCat = header.findIndex((h) => /category/i.test(h));
  const idxAmt = header.findIndex((h) => /amount/i.test(h));
  const idxBal = header.findIndex((h) => /balance/i.test(h));
  const out = [];
  // Count occurrences of each (date, amount, original) tuple as we go so
  // USAA-legitimate duplicates (two identical transfers on the same day) get
  // distinct IDs. USAA's CSV ordering within a day is stable.
  const tupleOrdinal = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((f) => !f || !f.trim())) continue;
    const rawDate = idxDate >= 0 ? r[idxDate] : null;
    const date = isoDate(rawDate);
    if (!date) continue;
    const description = idxDesc >= 0 ? (r[idxDesc] || '').trim() : '';
    const original = idxOrig >= 0 ? (r[idxOrig] || '').trim() : description;
    const amount = idxAmt >= 0 ? (r[idxAmt] || '').trim() : '';
    const tupleKey = `${date}|${amount}|${original}`;
    const ord = tupleOrdinal.get(tupleKey) || 0;
    tupleOrdinal.set(tupleKey, ord + 1);
    const checkMatch = original.match(/CHECK\s*#?\s*0*(\d+)/i);
    // Include ordinal so legitimate same-day-same-amount-same-memo duplicates
    // (e.g., two "USAA FUNDS TRANSFER CR" on the same day) are preserved in
    // the primary key. The ordinal itself is an internal disambiguator and is
    // deliberately NOT emitted on the record (it was always 0 in practice and
    // exposing it as data was misleading).
    const id = hashId(`${accountId}|${tupleKey}|#${ord}`);
    // USAA retail accounts (checking/savings/credit-card) are USD-only for
    // US members. We hardcode so the declared `currency` field is populated.
    // If/when USAA ships multi-currency retail products this needs revisiting.
    out.push({
      id,
      account_id: accountId,
      account_name: accountName,
      date,
      description,
      original_description: original,
      category: idxCat >= 0 ? (r[idxCat] || '').trim() || null : null,
      // `amount` is cents (integer) — matches the manifest declaration and
      // the `credit_card_billing` stream's *_cents convention. The USAA CSV
      // ships a signed decimal dollar amount; `currencyToCents` preserves sign.
      amount: currencyToCents(amount) ?? 0,
      currency: 'USD',
      balance_after_cents: idxBal >= 0 ? currencyToCents(r[idxBal]) : null,
      check_number: checkMatch ? checkMatch[1] : null,
      source: 'csv_export',
      fetched_at: nowIso(),
    });
  }
  return out;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const startMsg = await new Promise((resolve, reject) => {
    rl.once('line', (line) => { try { resolve(JSON.parse(line)); } catch (e) { reject(e); } });
  });
  if (startMsg.type !== 'START') return fail('Expected START');

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const state = startMsg.state || {};
  const emittedAt = nowIso();
  let total = 0;
  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));
  const emitRecord = (stream, data) => {
    if (data.id == null) return;
    const rs = resFilters.get(stream);
    if (rs && !rs.has(String(data.id))) return;
    emit({ type: 'RECORD', stream, key: data.id, data, emitted_at: emittedAt });
    total++;
  };

  let context;
  let release = async () => {};
  try {
    ({ context, release } = await acquireBrowser({ headless: true }));
  } catch (err) {
    return fail(`could not open browser profile: ${err.message}`, false);
  }

  try {
    const page = await context.newPage();
    // Automated session management: probe + if dead, drive full login with
    // stored creds + 2FA via INTERACTION kind=otp. No human laptop needed.
    try {
      await ensureUsaaSession({ context, page, sendInteractionAndWait, nextInteractionId });
    } catch (e) {
      return fail(`usaa_session_failed: ${e.message}`, false);
    }

    // ACCOUNTS
    emit({ type: 'PROGRESS', message: 'Extracting accounts from dashboard' });
    const accounts = await extractAccounts(page);
    emit({ type: 'PROGRESS', message: `Found ${accounts.length} account(s)` });

    // Keep a.account_url internally for transaction drilldown but don't emit it
    // on the record (P2 finding from Layer 1 audit — internal scrape artifact,
    // not in manifest, meaningless to consumers).
    const accountRecords = accounts.map((a) => ({
      id: a.account_id_raw || hashId(a.raw_text),
      type: a.account_type,
      name: a.name,
      last_four: a.last_four,
      balance_cents: a.balance_cents,
      available_balance_cents: null,
      status: 'open',
      fetched_at: emittedAt,
    }));

    if (requested.has('accounts')) {
      for (const a of accountRecords) emitRecord('accounts', a);
      emit({ type: 'STATE', stream: 'accounts', cursor: { fetched_at: nowIso() } });
    }

    // TRANSACTIONS — drive Export per account where applicable
    if (requested.has('transactions')) {
      const stream = requested.get('transactions');
      const sinceDateCfg = stream.time_range?.since?.slice(0, 10);
      // USAA's CSV export UI hard-caps the From Date at ~18 months ago
      // (empirically verified 2026-04-19 — 10/19/2024 accepted, 04/19/2024
      // rejected). Asking for an older date leaves the form in "Fix From
      // Date" state and the submit button never enables. Start at the
      // most-permissive floor (~17 months, safely inside the cap) and let
      // state advance forward over time.
      const seventeenMonthsAgo = new Date(Date.now() - 17 * 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

      // Accumulate per-account cursors across the loop and emit ONE STATE
      // at the end. Previous code emitted STATE inside the loop, each time
      // spreading the INITIAL `state.transactions` — which meant each emit
      // overwrote prior accounts' cursors, leaving only the last-processed
      // account's cursor committed. Observed 2026-04-21: state.transactions
      // had a cursor for Amex (last in loop) but not for Checking / Family
      // Checking / Visa — so those three full-re-exported every run.
      const transactionsCursor = { ...(state.transactions || {}) };

      for (const a of accounts) {
        if (!/checking|savings|credit-card/.test(a.account_type)) continue;
        const perAccState = state.transactions?.[a.account_id_raw || ''] || {};
        const priorLastDate = perAccState.last_date;
        const desiredSince = priorLastDate
          ? new Date(Date.parse(priorLastDate) - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10)
          : (sinceDateCfg || seventeenMonthsAgo);
        const todayIso = new Date().toISOString().slice(0, 10);

        // Try progressively smaller ranges if the first attempt times out.
        // Ladder: desired → 5y → 2y → 1y → 3mo.
        const candidateStarts = [desiredSince];
        const fiveYearsAgo = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        if (fiveYearsAgo > desiredSince) candidateStarts.push(fiveYearsAgo);
        if (twoYearsAgo > desiredSince) candidateStarts.push(twoYearsAgo);
        if (oneYearAgo > desiredSince) candidateStarts.push(oneYearAgo);
        if (threeMonthsAgo > desiredSince) candidateStarts.push(threeMonthsAgo);

        let csvPath = null;
        let usedSince = null;
        // Capture the most informative diagnostic across all range attempts so
        // a failure carries actionable evidence in the SKIP_RESULT emit.
        let lastDiag = null;
        const onDiagnostics = (info) => { lastDiag = info; };
        for (const sinceDate of candidateStarts) {
          emit({ type: 'PROGRESS', stream: 'transactions', message: `Export ${a.name} (${a.last_four || 'n/a'}) from ${sinceDate} to ${todayIso}` });
          try {
            csvPath = await driveExport(
              context,
              page,
              `https://www.usaa.com${a.account_url}`,
              { sinceDate, untilDate: todayIso, accountType: a.account_type, onDiagnostics },
            );
          } catch (err) {
            emit({ type: 'SKIP_RESULT', stream: 'transactions', reason: 'export_error', message: `${a.name}: ${err.message.slice(0, 160)}` });
            csvPath = null;
          }
          if (csvPath) { usedSince = sinceDate; break; }
          // If the affordance or dialog couldn't be located, shortening the
          // range won't help — bail out of the retry ladder for this account.
          if (lastDiag && (lastDiag.phase === 'no_export_affordance' || lastDiag.phase === 'export_dialog_unexpected_shape')) {
            emit({ type: 'PROGRESS', stream: 'transactions', message: `${a.name}: ${lastDiag.phase} — skipping retries` });
            break;
          }
          emit({ type: 'PROGRESS', stream: 'transactions', message: `retrying ${a.name} with shorter range` });
        }
        if (!csvPath) {
          // Produce a useful SKIP_RESULT. For credit-card accounts specifically,
          // call out the 2026-04-19 investigation gap so whoever next looks at
          // this doesn't repeat the exercise — the design note referenced in
          // driveExport's header comment is the place to capture the live UI.
          const isCreditCard = /credit-card/.test(a.account_type);
          const baseMessage = lastDiag
            ? `${a.name}: ${lastDiag.phase} at ${lastDiag.diag?.url || 'unknown url'}`
            : `${a.name}: export dialog didn't produce a download across all ranges — account may have no transactions or selectors shifted`;
          const ccSuffix = isCreditCard
            ? ' (credit-card export flow not verified live 2026-04-19 — see design-notes/usaa.md "Fallback path: DOM scrape")'
            : '';
          emit({
            type: 'SKIP_RESULT',
            stream: 'transactions',
            reason: isCreditCard ? 'credit_card_export_unverified' : 'export_no_download',
            message: `${baseMessage}${ccSuffix}`,
            diagnostics: lastDiag || null,
          });
          continue;
        }
        const text = await readFile(csvPath, 'utf8');
        const rows = parseCsv(text);
        const txns = rowsToTransactions(rows, { accountId: a.account_id_raw || a.last_four, accountName: a.name });
        let latest = priorLastDate;
        for (const t of txns) {
          emitRecord('transactions', t);
          if (!latest || t.date > latest) latest = t.date;
        }
        // Clean up temp CSV
        await unlink(csvPath).catch(() => {});
        const dir = csvPath.replace(/\/[^/]+$/, '');
        await readdir(dir).then((f) => { if (!f.length) rmSync(dir, { recursive: true, force: true }); }).catch(() => {});

        transactionsCursor[a.account_id_raw || a.last_four] = {
          last_date: latest || usedSince || null,
        };
        // Emit per-account checkpoint. The runtime overwrites prior STATEs
        // for this stream with this one, so we carry the full accumulator
        // each time. If the run crashes later, we keep cursors for the
        // accounts already processed rather than losing all of them.
        emit({ type: 'STATE', stream: 'transactions', cursor: transactionsCursor });
      }
    }

    // STATEMENTS — scrape /my/documents table, then hydrate PDF blobs per row.
    //
    // Phase A (download): for each row, drive the "Options" kebab -> "Download"
    // menu to capture the PDF via page.waitForEvent('download'). PDFs land at
    // ~/.pdpp/usaa-statements/<account_slug>/<YYYY-MM>-<sha8>.pdf — this is
    // the owner's archive, not a transient scratch dir (see design-notes/usaa-
    // historical-coverage-gap.md § "Storage").
    //
    // Phase B (parse): feed each PDF through pdf-parse and emit transactions
    // with `source: "pdf_statement_<YYYY-MM>"`. The id-hash scheme matches the
    // CSV path so CSV + PDF rows dedupe cleanly. USAA's statement templates
    // have drifted over the years; see connectors/usaa/statement-pdfs.js for
    // the per-era parser strategy + unknown-era fallback.
    //
    // Both phases degrade gracefully: if the Options menu selectors don't
    // match, we still emit the index-only statement record (document_url +
    // pdf_sha256 null). If the parser doesn't recognise the template, we
    // still emit the hydrated statement record but skip the transactions
    // extraction for that PDF with a diagnostic SKIP_RESULT.
    if (requested.has('statements') || requested.has('transactions')) {
      try {
        emit({ type: 'PROGRESS', stream: 'statements', message: 'Fetching statements index' });
        await page.goto('https://www.usaa.com/my/documents', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await sleep(5000);
        const docs = await page.evaluate(() => {
          const t = document.querySelector('table');
          if (!t) return [];
          return [...t.querySelectorAll('tbody tr')].map((tr, rowIndex) => {
            const cells = [...tr.querySelectorAll('td')];
            return {
              rowIndex,
              title: (cells[0]?.innerText || '').replace(/\s+/g, ' ').trim(),
              date_delivered: (cells[1]?.innerText || '').trim(),
              account_reference: (cells[2]?.innerText || '').trim(),
            };
          });
        });
        // Resolve the document row's account reference text back to a stable
        // account_id by matching against the accounts array. We prefer a
        // last-four match (`*3602`) because it's unambiguous across all USAA
        // account types; we fall back to a case-insensitive name substring
        // match for references that omit the digits. If neither hits we emit
        // null rather than guessing — downstream flows can still group by
        // account_reference, but the column signals the mapping was lossy.
        const resolveAccountId = (ref) => {
          if (!ref) return null;
          const last4 = (ref.match(/\*(\d{4})/) || [])[1];
          if (last4) {
            const byLast4 = accounts.find((a) => a.last_four === last4);
            if (byLast4 && byLast4.account_id_raw) return byLast4.account_id_raw;
          }
          const refLower = ref.toLowerCase();
          const byName = accounts.find((a) => a.name && refLower.includes(a.name.toLowerCase()));
          if (byName && byName.account_id_raw) return byName.account_id_raw;
          return null;
        };

        // Pre-compute the statement records (pre-hydration) so we emit them
        // even if Phase A bails partway through the list.
        const indexRows = docs
          .filter((d) => d.date_delivered)
          .map((d) => ({
            rowIndex: d.rowIndex,
            id: hashId(`${d.account_reference}|${d.date_delivered}|${d.title}`),
            account_id: resolveAccountId(d.account_reference),
            title: d.title,
            date_delivered: isoDate(d.date_delivered),
            account_reference: d.account_reference,
          }));

        // Resolve the credit-card account's last-four -> account_id.
        // (Needed so credit-card statements pick the credit-card parser.)
        const accountById = new Map(
          accounts
            .filter((a) => a.account_id_raw)
            .map((a) => [a.account_id_raw, a]),
        );

        // Track which rows we tried to hydrate so we only emit the statement
        // record once (after hydration). Phase A success/failure is surfaced
        // by merging pdf_path + pdf_sha256 into the emitted record when we
        // have them, or by emitting the plain index row when we don't.
        const hydrationResults = new Map(); // rowIndex -> { pdfPath, pdfSha256, buffer, err }
        let hydrationAttempts = 0;
        let hydrationSuccesses = 0;

        // Run Phase A whenever EITHER statements or transactions was requested —
        // transactions wants the PDF bytes to parse historical rows, statements
        // wants the hydrated metadata (pdf_path/sha256). We skip the whole pass
        // only if neither stream is wanted.
        try {
          const hydrated = await hydrateStatementPdfs({
            page,
            statements: indexRows,
            onProgress: ({ index, total, title }) => {
              hydrationAttempts = index + 1;
              emit({
                type: 'PROGRESS',
                stream: 'statements',
                message: `Downloading PDF ${index + 1}/${total}: ${title.slice(0, 60)}`,
              });
            },
            onSkip: ({ statement, reason, diag }) => {
              hydrationResults.set(statement.rowIndex, { err: reason, diag });
              emit({
                type: 'SKIP_RESULT',
                stream: 'statements',
                reason: `pdf_download_${reason}`,
                message: `${statement.title}: ${reason}`,
                diagnostics: diag || null,
              });
            },
          });
          for (const h of hydrated) {
            hydrationSuccesses++;
            hydrationResults.set(h.statement.rowIndex, {
              pdfPath: h.pdfPath,
              pdfSha256: h.pdfSha256,
              buffer: h.buffer,
            });
          }
        } catch (err) {
          emit({ type: 'SKIP_RESULT', stream: 'statements', reason: 'hydrate_crashed', message: err.message.slice(0, 160) });
        }

        // Emit statement records (hydrated where possible).
        if (requested.has('statements')) {
          for (const row of indexRows) {
            const h = hydrationResults.get(row.rowIndex) || {};
            // pdf_path is additive — not in the declared schema yet, but the
            // manifest is a permissive superset (additionalProperties isn't
            // declared false) so adding this doesn't regress consumers that
            // don't care. See the statements stream's "pdf_path" follow-up
            // in openspec/changes/add-polyfill-connector-system/design-notes/
            // usaa-historical-coverage-gap.md.
            emitRecord('statements', {
              id: row.id,
              account_id: row.account_id,
              title: row.title,
              date_delivered: row.date_delivered,
              account_reference: row.account_reference,
              document_url: h.pdfPath ? fileUrlForPath(h.pdfPath) : null,
              pdf_sha256: h.pdfSha256 || null,
              pdf_path: h.pdfPath || null,
              fetched_at: nowIso(),
            });
          }
          emit({
            type: 'PROGRESS',
            stream: 'statements',
            message: `Hydrated ${hydrationSuccesses}/${hydrationAttempts || indexRows.length} PDFs`,
          });
          emit({ type: 'STATE', stream: 'statements', cursor: { fetched_at: nowIso() } });
        }

        // Phase B — parse every successfully-downloaded PDF into transactions.
        // Gated on `transactions` being a requested stream so a statements-only
        // run doesn't pay the parse cost. Dedupe with CSV transactions happens
        // downstream via the shared id hash.
        if (requested.has('transactions')) {
          let pdfTxnCount = 0;
          let parsedStatements = 0;
          let unknownTemplates = 0;
          for (const row of indexRows) {
            const h = hydrationResults.get(row.rowIndex);
            if (!h || !h.buffer) continue;
            // Skip non-statement docs that the /my/documents index surfaces
            // alongside real statements (e.g. "USAA Pay Bills Terms and
            // Conditions"). Real statements always carry the word STATEMENT
            // in their title; non-statements typically have "Terms", "Notice",
            // "Agreement", "Disclosure", etc.
            const title = row.title || '';
            if (!/STATEMENT/i.test(title) ||
                /(TERMS\b|AGREEMENT\b|NOTICE\b|DISCLOSURE\b|CONDITION)/i.test(title)) {
              continue;
            }
            // Period is "YYYY-MM" of the statement's delivery date. USAA
            // delivers a monthly statement a few days after period close,
            // so this is close-enough for provenance labeling. We deliberately
            // avoid trying to re-derive the real statement period from the
            // PDF content because formats vary — the date_delivered is our
            // stable anchor.
            const period = (row.date_delivered || '').slice(0, 7) || 'unknown';
            const acct = row.account_id ? accountById.get(row.account_id) : null;
            const accountName = acct?.name || row.account_reference || null;
            try {
              const { txns, parseMeta } = await parsePdfStatement({
                buffer: h.buffer,
                accountId: row.account_id || row.account_reference || 'unknown',
                accountName,
                period,
              });
              if (!txns.length) {
                unknownTemplates++;
                emit({
                  type: 'SKIP_RESULT',
                  stream: 'transactions',
                  reason: 'pdf_template_unknown',
                  message: `${row.title} (${period}): no parser matched (era=${parseMeta.era})`,
                  diagnostics: {
                    statement_id: row.id,
                    year: parseMeta.year,
                    raw_text_sample: parseMeta.rawTextSample || null,
                  },
                });
                continue;
              }
              for (const t of txns) {
                emitRecord('transactions', t);
                pdfTxnCount++;
              }
              parsedStatements++;
            } catch (err) {
              emit({
                type: 'SKIP_RESULT',
                stream: 'transactions',
                reason: 'pdf_parse_failed',
                message: `${row.title}: ${err.message?.slice(0, 160)}`,
              });
            }
          }
          emit({
            type: 'PROGRESS',
            stream: 'transactions',
            message: `PDF parse: ${pdfTxnCount} txns across ${parsedStatements} statements (${unknownTemplates} unknown templates)`,
          });
        }
      } catch (err) {
        emit({ type: 'SKIP_RESULT', stream: 'statements', reason: 'scrape_failed', message: err.message.slice(0, 160) });
      }
    }

    // INBOX_MESSAGES — scrape /my/inbox table.
    if (requested.has('inbox_messages')) {
      try {
        emit({ type: 'PROGRESS', stream: 'inbox_messages', message: 'Fetching inbox' });
        await page.goto('https://www.usaa.com/my/inbox', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await sleep(5000);
        const msgs = await page.evaluate(() => {
          const t = document.querySelector('table');
          if (!t) return [];
          return [...t.querySelectorAll('tbody tr')].map((tr) => {
            const cells = [...tr.querySelectorAll('td')];
            return {
              status: (cells[0]?.innerText || '').replace(/\s+/g, ' ').trim(),
              date_short: (cells[1]?.innerText || '').replace(/\s+/g, ' ').trim(),
              preview: (cells[2]?.innerText || '').replace(/\s+/g, ' ').trim(),
            };
          });
        });
        const year = new Date().getFullYear();
        for (const m of msgs) {
          if (!m.date_short) continue;
          // "Apr 17" -> normalize to current year (best-guess)
          const parsed = new Date(`${m.date_short} ${year}`);
          const iso = isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
          const id = hashId(`${m.date_short}|${m.preview.slice(0, 120)}`);
          emitRecord('inbox_messages', {
            id,
            date_received: iso,
            status: /UNREAD/i.test(m.status) ? 'unread' : 'read',
            subject: m.preview.slice(0, 120),
            preview: m.preview,
            fetched_at: nowIso(),
          });
        }
        emit({ type: 'STATE', stream: 'inbox_messages', cursor: { fetched_at: nowIso() } });
      } catch (err) {
        emit({ type: 'SKIP_RESULT', stream: 'inbox_messages', reason: 'scrape_failed', message: err.message.slice(0, 160) });
      }
    }

    // CREDIT_CARD_BILLING — one record per credit-card account.
    if (requested.has('credit_card_billing')) {
      try {
        emit({ type: 'PROGRESS', stream: 'credit_card_billing', message: 'Fetching credit card billing details' });
        const cards = accounts.filter((a) => /credit-card/.test(a.account_type));
        for (const a of cards) {
          await page.goto(`https://www.usaa.com${a.account_url}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await sleep(6000);
          const billing = await page.evaluate(() => {
            const kv = {};
            const labels = [...document.querySelectorAll('dt, .label, .field-label')];
            for (const el of labels) {
              const label = (el.innerText || '').trim();
              const value = ((el.nextElementSibling || {}).innerText || '').trim();
              if (label && value && !kv[label]) kv[label] = value;
            }
            return kv;
          });
          const id = a.account_id_raw || a.last_four;
          emitRecord('credit_card_billing', {
            id,
            account_id: a.account_id_raw || null,
            account_nickname: billing['Account Nickname'] || billing['Nickname'] || null,
            current_balance_cents: currencyToCents(billing['Current Balance']),
            available_credit_cents: currencyToCents(billing['Available Credit']),
            credit_limit_cents: currencyToCents(billing['Credit Limit']),
            annual_percent_rate: billing['Annual Percent Rate'] || null,
            cash_advance_apr: billing['Cash Advance APR'] || null,
            cash_rewards_cents: currencyToCents(billing['Cash Rewards']),
            billing_status: billing['Billing Information'] || null,
            minimum_payment_met: /met/i.test(billing['Billing Information'] || ''),
            card_holders: billing['Card Holders'] || null,
            fetched_at: nowIso(),
          });
        }
        emit({ type: 'STATE', stream: 'credit_card_billing', cursor: { fetched_at: nowIso() } });
      } catch (err) {
        emit({ type: 'SKIP_RESULT', stream: 'credit_card_billing', reason: 'scrape_failed', message: err.message.slice(0, 160) });
      }
    }

    // Still-deferred streams (need live DOM + more work):
    for (const s of ['transfers', 'bill_payments', 'scheduled_transactions', 'external_accounts']) {
      if (requested.has(s)) {
        emit({
          type: 'SKIP_RESULT',
          stream: s,
          reason: 'selectors_pending',
          message: `${s} stream scaffolded in design-notes; click-chain or SPA-component wiring deferred.`,
        });
      }
    }
  } finally {
    await release().catch(() => {});
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e && e.message ? e.message : String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: /ECONN|ETIMEDOUT|timeout/i.test(msg) } });
  flushAndExit(1);
});
