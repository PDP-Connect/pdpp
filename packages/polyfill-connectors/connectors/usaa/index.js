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
import { launchPersistentContext } from '../../src/browser-profile.js';
import { ensureUsaaSession } from '../../src/auto-login/usaa.js';
import { resourceSet } from '../../src/scope-filters.js';

const rl = createInterface({ input: process.stdin, terminal: false });
function emit(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
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

async function driveExport(_context, page, accountUrl, { sinceDate, untilDate }) {
  // Returns a path to a downloaded CSV, or null if USAA didn't cooperate.
  await page.goto(accountUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(6000);

  // Click the Export affordance (it's a <button class="ent-as-utility-bar__item export">)
  const exportLoc = page.locator('button.ent-as-utility-bar__item.export, :text-is("Export")').first();
  if (!(await exportLoc.count())) return null;
  await exportLoc.click();
  await sleep(2500);

  // Select "Select Date Range" in the native select
  await page.selectOption('select[name="selectionType"]', 'date-range').catch(() => {});
  await sleep(1500);

  // Fill From and End date inputs. USAA uses a self-formatting React
  // input that needs real keystrokes (page.fill skips React's validators).
  const fromIn = page.locator('input[name="fromDate"]');
  const endIn = page.locator('input[name="endDate"]');
  await fromIn.click().catch(() => {});
  await fromIn.pressSequentially(mmddyyyy(sinceDate), { delay: 30 }).catch(() => {});
  await endIn.click().catch(() => {});
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
  const errorPromise = page.locator('[role="dialog"] [class*="errorMessage"]:not(:empty), [role="dialog"] :text-matches("no transactions|nothing to export", "i")')
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => 'error')
    .catch(() => null);

  let download = null;
  try {
    const outcome = await Promise.race([
      downloadPromise.then((d) => ({ kind: 'download', d })),
      errorPromise.then((r) => (r === 'error' ? { kind: 'error' } : null)),
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
  try {
    context = await launchPersistentContext({ headless: true });
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

    const accountRecords = accounts.map((a) => ({
      id: a.account_id_raw || hashId(a.raw_text),
      account_url: a.account_url,
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
        for (const sinceDate of candidateStarts) {
          emit({ type: 'PROGRESS', stream: 'transactions', message: `Export ${a.name} (${a.last_four || 'n/a'}) from ${sinceDate} to ${todayIso}` });
          try {
            csvPath = await driveExport(context, page, `https://www.usaa.com${a.account_url}`, { sinceDate, untilDate: todayIso });
          } catch (err) {
            emit({ type: 'SKIP_RESULT', stream: 'transactions', reason: 'export_error', message: `${a.name}: ${err.message.slice(0, 160)}` });
            csvPath = null;
          }
          if (csvPath) { usedSince = sinceDate; break; }
          emit({ type: 'PROGRESS', stream: 'transactions', message: `retrying ${a.name} with shorter range` });
        }
        if (!csvPath) {
          emit({ type: 'SKIP_RESULT', stream: 'transactions', reason: 'export_no_download', message: `${a.name}: export dialog didn't produce a download across all ranges — account may have no transactions or selectors shifted` });
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

        emit({ type: 'STATE', stream: 'transactions', cursor: {
          ...(state.transactions || {}),
          [a.account_id_raw || a.last_four]: { last_date: latest || usedSince || null },
        }});
      }
    }

    // STATEMENTS — scrape /my/documents table.
    if (requested.has('statements')) {
      try {
        emit({ type: 'PROGRESS', stream: 'statements', message: 'Fetching statements index' });
        await page.goto('https://www.usaa.com/my/documents', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await sleep(5000);
        const docs = await page.evaluate(() => {
          const t = document.querySelector('table');
          if (!t) return [];
          return [...t.querySelectorAll('tbody tr')].map((tr) => {
            const cells = [...tr.querySelectorAll('td')];
            return {
              title: (cells[0]?.innerText || '').replace(/\s+/g, ' ').trim(),
              date_delivered: (cells[1]?.innerText || '').trim(),
              account_reference: (cells[2]?.innerText || '').trim(),
            };
          });
        });
        for (const d of docs) {
          if (!d.date_delivered) continue;
          const iso = isoDate(d.date_delivered);
          const id = hashId(`${d.account_reference}|${d.date_delivered}|${d.title}`);
          // document_url and pdf_sha256 intentionally left null on this path.
          // The /my/documents table surfaces an "Options" kebab menu per row
          // that contains a "Download" item; the download fires a POST to a
          // short-lived signed URL rather than exposing a stable href on the
          // row. Hydrating those requires (a) clicking the kebab per-row,
          // (b) intercepting the download, (c) streaming bytes to compute a
          // sha-256, and (d) storing the blob somewhere (we don't want the
          // PDF contents inlined on the record). That's a multi-step blob-
          // hydration pass we haven't built yet, and getting the selectors
          // wrong without a live session to verify risks silent breakage of
          // the whole statements stream. The manifest reflects these fields
          // as populated-when-available so a consumer shouldn't treat null
          // as a schema violation.
          emitRecord('statements', {
            id,
            title: d.title,
            date_delivered: iso,
            account_reference: d.account_reference,
            document_url: null,
            pdf_sha256: null,
            fetched_at: nowIso(),
          });
        }
        emit({ type: 'STATE', stream: 'statements', cursor: { fetched_at: nowIso() } });
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
    await context.close().catch(() => {});
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e && e.message ? e.message : String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: /ECONN|ETIMEDOUT|timeout/i.test(msg) } });
  flushAndExit(1);
});
