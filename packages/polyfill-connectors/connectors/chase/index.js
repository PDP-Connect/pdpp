#!/usr/bin/env node
/**
 * PDPP Chase Connector (v0.1.0)
 *
 * Strategy: browser-drive chase.com's "Download account activity" affordance
 * to produce QFX (Quicken Web Connect) files, which parse canonically to
 * (account_id, fitid, date, amount, memo, name, type, checknum, refnum).
 *
 * Why QFX instead of Direct Connect or HTML scrape:
 * - Direct Connect is effectively dead for new personal-account enrollments
 *   as of 2025-2026 (see `design-notes/chase.md` — research done 2026-04-20).
 * - HTML scrape has hundreds of selectors subject to Chase's weekly UI
 *   churn. QFX splits the brittleness: only the ~5-selector download click
 *   path is fragile; the resulting file format has been stable since 2001.
 *
 * v0.1 streams (per `design-notes/chase.md`):
 *   - accounts: dashboard-scraped identity + QFX ACCTINFO augmentation
 *   - transactions: per-account, per-90-day-window QFX downloads + parse
 *   - statements: per-account monthly statement PDFs, hydrated to disk
 *   - balances: append_only point-in-time snapshots from QFX LEDGERBAL/AVAILBAL
 *
 * Selectors for the download UI are NOT verified live yet. This connector
 * emits diagnostic SKIP_RESULT with a DOM dump + screenshot when it can't
 * find the download affordance, so the first live run produces evidence
 * for the next iteration rather than silently failing with zero records.
 *
 * Auth: CHASE_USERNAME + CHASE_PASSWORD in env. 2FA via INTERACTION kind=otp.
 * CHASE_2FA_METHOD=text|voice|email (default text).
 */

import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ensureChaseSession } from '../../src/auto-login/chase.js';
import { runConnector } from '../../src/connector-runtime.js';
import { validateRecord } from './schemas.js';

// ─── Helpers ──────────────────────────────────────────────────────────────


// ─── Dashboard scrape: enumerate accounts ─────────────────────────────────

async function discoverAccounts(page) {
  // Navigate to dashboard overview — not the generic /dashboard URL which
  // often redirects to the last-viewed account. Overview consistently lists
  // all accounts.
  await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/overview', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  // Wait for at least one account label to appear rather than a fixed delay —
  // the dashboard renders cards asynchronously from an XHR, so fixed sleeps
  // are both slow and flaky. Fail soft if the selector never appears (returns
  // empty accounts list; caller's SKIP_RESULT diagnostic fires).
  await page.locator('[id^="accounts-name-link-button-"][id$="-label"]').first()
    .waitFor({ state: 'attached', timeout: 20000 })
    .catch(() => {});

  // Verified pattern 2026-04-21: Chase renders each account as a
  // <span class="accessible-text" id="accounts-name-link-button-<INTERNAL_ID>-label">
  // with text like "Sapphire Preferred (...9241)". The internal id matches
  // the transactionDetails param and is what the download form's
  // account-selector expects.
  return page.evaluate(() => {
    function walk(root, out = []) {
      root.querySelectorAll('*').forEach((el) => {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot, out);
      });
      return out;
    }
    const labels = walk(document)
      .filter((el) => el.id && /^accounts-name-link-button-\d+-label$/.test(el.id));
    return labels.map((el) => {
      const m = el.id.match(/^accounts-name-link-button-(\d+)-label$/);
      const displayName = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const lastFourMatch = displayName.match(/\.\.\.(\d{3,4})/);
      // Infer type from the display name — rough heuristic; refined by
      // inspecting the BAC/DDA/ABS param in the transactions URL if needed.
      const typeHint = /(Sapphire|Freedom|Ink|Amazon|Southwest|United|Hyatt|Disney|Marriott|IHG|Prime|Platinum|Slate)/i.test(displayName)
        ? 'credit_card'
        : /(Checking|Total Checking|Premier Checking)/i.test(displayName)
          ? 'checking'
          : /(Savings|Premier Savings)/i.test(displayName)
            ? 'savings'
            : 'unknown';
      return {
        internal_id: m[1],
        name: displayName,
        type: typeHint,
        last_four: lastFourMatch ? lastFourMatch[1] : null,
      };
    });
  });
}

// ─── QFX download click-path ──────────────────────────────────────────────

// Activity options enumerated live from Chase's mds-select on 2026-04-21:
//   Current display, including filters / Year to date / Last year /
//   Since last statement / 2026 statements / 2025 statements /
//   2024 statements / All transactions / Choose a date range
// We use the visible labels as locators (Playwright's `getByRole('option')`
// pierces shadow DOM).
async function selectActivity(page, optionLabel) {
  await page.locator('#select-downloadActivityOptionId').click({ timeout: 10000 });
  const opt = page.getByRole('option', { name: new RegExp(`^${optionLabel}$`, 'i') });
  await opt.waitFor({ state: 'visible', timeout: 5000 });
  await opt.click({ timeout: 5000 });
}

/**
 * Select File Type via click-driven dropdown selection. Chase's mds-select
 * ignores direct attribute mutation once any other form interaction has
 * happened — the first run's attribute-set worked only because nothing else
 * touched the form before Download, but re-renders (like selecting Date
 * Range on Activity) revert file type back to CSV. Clicking is durable.
 */
async function selectFileType(page, label) {
  await page.locator('#select-downloadFileTypeOption').click({ timeout: 10000 });
  const opt = page.getByRole('option', { name: new RegExp(`^${label}`, 'i') });
  await opt.waitFor({ state: 'visible', timeout: 5000 });
  await opt.click({ timeout: 5000 });
}

/**
 * Drive a single QFX download.
 *
 * @param {object} opts
 * @param {string} opts.activity - one of 'all' | 'since_last_statement' | 'year_to_date' | 'last_year' | 'current' | 'date_range'
 * @param {{from?: string, to?: string}} [opts.dateRange] - ISO dates, required when activity='date_range'
 */
async function downloadQfx(page, account, tmpDir, opts = {}) {
  const activity = opts.activity || 'all';

  // Chase URL params vary by product type. Verified 2026-04-21 for CARD,BAC
  // (credit card). Checking/savings shapes are speculative — see
  // `design-notes/chase.md`.
  const paramsFragment = account.type === 'credit_card'
    ? `CARD,BAC,${account.internal_id}`
    : account.type === 'checking'
      ? `DDA,PRIMARY,${account.internal_id},SECONDARY`
      : `CARD,BAC,${account.internal_id}`;

  const url = `https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/downloadAccountTransactions/index;params=${paramsFragment}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('#downloadFileTypeOption').waitFor({ state: 'attached', timeout: 20000 });

  // Select activity option FIRST so the Date-Range pickers render before we
  // set file type. Chase's form re-renders when Activity changes; doing file
  // type after Activity keeps the selection stable through the re-render.
  const labelMap = {
    all: 'All transactions',
    since_last_statement: 'Since last statement',
    year_to_date: 'Year to date',
    last_year: 'Last year',
    current: 'Current display, including filters',
    date_range: 'Choose a date range',
  };
  const label = labelMap[activity] || labelMap.all;

  if (activity !== 'current') {
    try {
      await selectActivity(page, label);
    } catch (err) {
      return { downloaded: false, error: `activity_select_failed (${label}): ${err.message.slice(0, 120)}` };
    }

    if (activity === 'date_range') {
      const from = opts.dateRange?.from;
      const to = opts.dateRange?.to;
      if (!from || !to) return { downloaded: false, error: 'date_range_missing_from_or_to' };
      const ok = await fillDateRange(page, from, to);
      if (!ok.ok) return { downloaded: false, error: `date_range_fill_failed: ${ok.error}` };
    }
  }

  // Now set File Type via click-select (attribute mutation gets clobbered
  // by Activity re-renders).
  try {
    await selectFileType(page, 'Quicken Web Connect');
  } catch (err) {
    return { downloaded: false, error: `file_type_select_failed: ${err.message.slice(0, 120)}` };
  }

  // Wait for the Download button to be enabled before clicking.
  await page.locator('mds-button#download').waitFor({ state: 'visible', timeout: 5000 });

  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  try {
    await page.locator('mds-button#download').click({ timeout: 10000 });
  } catch (err) {
    return { downloaded: false, error: `download_button_click_failed: ${err.message.slice(0, 120)}` };
  }

  try {
    const dl = await downloadPromise;
    const qfxPath = join(tmpDir, `chase-${account.internal_id}-${activity}-${Date.now()}.qfx`);
    await dl.saveAs(qfxPath);
    return { downloaded: true, qfxPath, activity };
  } catch (err) {
    return { downloaded: false, error: `download_event_timeout: ${err.message.slice(0, 120)}` };
  }
}

/**
 * Fill the From + To date pickers that appear after selecting "Choose a date
 * range".
 *
 * mds-datepicker#accountActivityFromDate and #accountActivityToDate host
 * inner `<input>` elements in their shadow roots. The picker has min-date
 * and max-date attributes that cap the range at ~24 months before today
 * (empirically 04/20/2024 on 04/21/2026). Dates outside that range are
 * silently clamped by the component.
 *
 * The inputs accept mm/dd/yyyy typed character-by-character. Playwright's
 * pressSequentially on the shadow-piercing `input` locator works.
 *
 * @param {string} from ISO date 'YYYY-MM-DD'
 * @param {string} to   ISO date 'YYYY-MM-DD'
 */
async function fillDateRange(page, from, to) {
  const mmddyyyy = (iso) => {
    const [y, m, d] = iso.split('-');
    if (!y || !m || !d) return null;
    return `${m}${d}${y}`;
  };
  const fromPacked = mmddyyyy(from);
  const toPacked = mmddyyyy(to);
  if (!fromPacked || !toPacked) return { ok: false, error: 'bad_iso_date' };

  try {
    const fromInput = page.locator('#accountActivityFromDate input').first();
    await fromInput.waitFor({ state: 'visible', timeout: 10000 });
    await fromInput.click({ timeout: 5000 });
    await fromInput.pressSequentially(fromPacked, { delay: 40 });

    const toInput = page.locator('#accountActivityToDate input').first();
    await toInput.click({ timeout: 5000 });
    await toInput.pressSequentially(toPacked, { delay: 40 });

    // Give the component a moment to validate/reflect selection.
    await page.locator('#accountActivityFromDate[value]').waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message.slice(0, 120) };
  }
}

// ─── Statements (PDF archive) ─────────────────────────────────────────────
//
// Navigate to Chase's Statements & Documents page and walk each row,
// clicking the `-download` anchor to save each monthly statement PDF.
// Pattern follows USAA's statements implementation (content-addressed
// storage, hash-based idempotence, per-account subfolders).
//
// Row structure verified live 2026-04-21:
//   table#accountsTable-0 (the account's statement table; index 0 = first
//     expanded account — Chase shows one account per table on the
//     Statements page, expanded via button#button-documentsAccordion-N).
//   Each row has three cells + action anchors:
//     Cell 0: date (e.g. "Apr 13, 2026")
//     Cell 1: "Statement" | "Tax document" | etc.
//     Cell 2: page count (e.g. "4 pages")
//     Cell 3: a.id=accountsTable-0-rowN-cell3-requestThisDocumentAnchor-download
//            (also -pdf which OPENS instead of saves)

const STATEMENT_ROOT = join(homedir(), '.pdpp', 'chase-statements');

function sha256Hex(buf) { return createHash('sha256').update(buf).digest('hex'); }
function shortHash(s) { return createHash('sha256').update(s).digest('hex').slice(0, 32); }

async function navigateToStatementsPage(page) {
  // Warm overview first — direct-nav to the documents URL can bounce through
  // login if the SPA isn't fully hydrated.
  await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for any account label to render before routing onward.
  await page.locator('[id^="accounts-name-link-button-"][id$="-label"]').first()
    .waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});

  await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index;mode=documents', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  // Wait for the accordion trigger to appear — confirms the page rendered.
  await page.locator('[id^="button-documentsAccordion-"]').first()
    .waitFor({ state: 'visible', timeout: 20000 });
}

/**
 * Enumerate the statement rows currently visible on the Statements page.
 * Each row maps to one monthly statement PDF. Returns an array of:
 *   { rowAnchorId, date_delivered_raw, title, account_reference, doc_kind }
 * in DOM order (newest first, per Chase's default ordering).
 */
async function enumerateStatementRows(page) {
  return page.evaluate(() => {
    function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
    const els = walk(document);
    const anchors = els.filter((el) =>
      el.tagName === 'A' && /accountsTable-\d+-row\d+-cell\d+-requestThisDocumentAnchor-download/.test(el.id || '')
    );
    // Parallel: find account accordion buttons, to associate each table with an account label.
    const accordions = [...document.querySelectorAll('[id^="button-documentsAccordion-"]')]
      .map((b) => ({
        id: b.id,
        tableIdx: (b.id.match(/documentsAccordion-(\d+)/) || [])[1],
        label: (b.innerText || '').replace(/\s+/g, ' ').trim(),
      }));
    const accountByTableIdx = new Map(accordions.map((a) => [a.tableIdx, a.label]));

    return anchors.map((a) => {
      // anchor id: accountsTable-<T>-row<R>-cell3-requestThisDocumentAnchor-download
      const m = a.id.match(/accountsTable-(\d+)-row(\d+)-/);
      const tableIdx = m?.[1];
      const rowIdx = m?.[2];
      // Walk up to the <tr> for date + type cells.
      let tr = a;
      while (tr && tr.tagName !== 'TR') tr = tr.parentElement;
      const cells = tr ? [...tr.querySelectorAll('td, th')] : [];
      const date_delivered_raw = (cells[0]?.innerText || '').trim();
      const doc_kind = (cells[1]?.innerText || '').trim();
      const account_reference = accountByTableIdx.get(tableIdx) || null;
      const title = [date_delivered_raw, doc_kind, account_reference].filter(Boolean).join(' ');
      return {
        rowAnchorId: a.id,
        tableIdx,
        rowIdx,
        date_delivered_raw,
        doc_kind,
        account_reference,
        title,
      };
    }).filter((r) => r.doc_kind && /statement/i.test(r.doc_kind));
  });
}

function parseDateDelivered(raw) {
  // Chase renders "Apr 13, 2026"; `new Date` parses reliably on v8 for this.
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function yearMonthFromIso(iso) {
  return iso ? iso.slice(0, 7) : 'unknown';
}

function accountSlug(accountId) {
  if (!accountId) return 'unknown';
  if (/^[A-Za-z0-9_-]+$/.test(accountId)) return accountId;
  return shortHash(accountId);
}

/**
 * Click the row's download anchor and capture the PDF via Playwright's
 * download event. Save to disk under ~/.pdpp/chase-statements/<account>/
 * <YYYY-MM>-<sha16>.pdf.
 */
async function downloadStatementPdf(page, row, accountId) {
  // Chase's anchor ids are safe ASCII (only letters, digits, hyphens) so
  // we can inline them into a CSS selector without CSS.escape (which is
  // browser-only — not available in Node).
  const anchor = page.locator(`#${row.rowAnchorId}`);
  const exists = await anchor.count().catch(() => 0);
  if (!exists) return { ok: false, error: 'anchor_not_found' };

  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  try {
    await anchor.click({ timeout: 10000 });
  } catch (err) {
    return { ok: false, error: `anchor_click_failed: ${err.message.slice(0, 120)}` };
  }

  let dl;
  try {
    dl = await downloadPromise;
  } catch (err) {
    return { ok: false, error: `download_event_timeout: ${err.message.slice(0, 120)}` };
  }

  const internalPath = await dl.path();
  if (!internalPath) return { ok: false, error: 'download_no_path' };
  const buffer = await readFile(internalPath);
  const pdfSha256 = sha256Hex(buffer);

  const isoDate = parseDateDelivered(row.date_delivered_raw);
  const slug = accountSlug(accountId);
  const dir = join(STATEMENT_ROOT, slug);
  await mkdir(dir, { recursive: true });
  const pdfPath = join(dir, `${yearMonthFromIso(isoDate)}-${pdfSha256.slice(0, 16)}.pdf`);

  // Idempotent: skip rewrite when the content is already at the expected path.
  const existing = await stat(pdfPath).catch(() => null);
  if (!existing || existing.size !== buffer.length) {
    await writeFile(pdfPath, buffer);
  }

  return { ok: true, pdfPath, pdfSha256 };
}

function fileUrl(p) {
  if (!p) return null;
  return pathToFileURL(p).href;
}

/**
 * Resolve a statement row's `account_reference` text (e.g.
 * "SAPPHIRE PREFERRED (...9241)") to the stable Chase internal account id
 * from our accounts array.
 */
function resolveAccountIdForRow(row, accounts) {
  if (!row.account_reference) return null;
  const last4Match = row.account_reference.match(/\.\.\.(\d{3,4})/);
  if (last4Match) {
    const byLast4 = accounts.find((a) => a.last_four === last4Match[1]);
    if (byLast4) return byLast4.internal_id;
  }
  const refLower = row.account_reference.toLowerCase();
  const byName = accounts.find((a) => a.name && refLower.includes(a.name.toLowerCase()));
  return byName ? byName.internal_id : null;
}

// ─── QFX parsing ──────────────────────────────────────────────────────────

async function parseQfxFile(path) {
  const ofxJs = await import('ofx-js');
  const OFX = ofxJs.OFX || ofxJs.default?.OFX || ofxJs.default || ofxJs;
  const content = await readFile(path, 'utf8');
  return OFX.parse(content);
}

// OFX datetime format: YYYYMMDDHHMMSS[.sss][TZ] — strip to YYYY-MM-DD.
function ofxDateToIso(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.length < 8) return null;
  const y = s.slice(0, 4);
  const m = s.slice(4, 6);
  const d = s.slice(6, 8);
  return `${y}-${m}-${d}`;
}

function ofxDateToFullIso(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.length < 8) return null;
  const date = ofxDateToIso(s);
  const hh = s.slice(8, 10) || '00';
  const mm = s.slice(10, 12) || '00';
  const ss = s.slice(12, 14) || '00';
  return `${date}T${hh}:${mm}:${ss}Z`;
}

// Walk an ofx-js parsed structure and extract our canonical shape.
// ofx-js yields deeply-nested objects matching OFX XML. Credit cards live
// under CREDITCARDMSGSRSV1 > CCSTMTTRNRS > CCSTMTRS; checking/savings under
// BANKMSGSRSV1 > STMTTRNRS > STMTRS. Structure is otherwise parallel.
function extractFromQfx(parsed) {
  const root = parsed?.OFX || parsed;
  if (!root) return { transactions: [], balance: null };

  // Find the statement response (credit card or bank).
  const cc = root.CREDITCARDMSGSRSV1?.CCSTMTTRNRS?.CCSTMTRS;
  const bank = root.BANKMSGSRSV1?.STMTTRNRS?.STMTRS;
  const stmt = cc || bank;
  if (!stmt) return { transactions: [], balance: null };

  const currency = stmt.CURDEF || 'USD';

  // Transactions — BANKTRANLIST > STMTTRN (can be a single object or an array).
  const trList = stmt.BANKTRANLIST;
  const rawTxns = trList?.STMTTRN;
  const txnArray = Array.isArray(rawTxns) ? rawTxns : (rawTxns ? [rawTxns] : []);
  const transactions = txnArray.map((t) => {
    const amtStr = String(t.TRNAMT || '0').trim();
    const amountCents = Math.round(Number(amtStr) * 100);
    return {
      fitid: String(t.FITID || ''),
      date: ofxDateToIso(t.DTPOSTED),
      amount_cents: amountCents,
      currency,
      type: t.TRNTYPE || null,
      name: t.NAME || null,
      memo: t.MEMO || null,
      check_number: t.CHECKNUM || null,
      reference_number: t.REFNUM || null,
    };
  }).filter((t) => t.fitid && t.date);

  // Balance — LEDGERBAL + AVAILBAL.
  let balance = null;
  const ledgerBal = stmt.LEDGERBAL;
  const availBal = stmt.AVAILBAL;
  if (ledgerBal || availBal) {
    const asOf = ofxDateToFullIso(ledgerBal?.DTASOF || availBal?.DTASOF);
    if (asOf) {
      balance = {
        as_of: asOf,
        ledger_cents: ledgerBal?.BALAMT != null ? Math.round(Number(ledgerBal.BALAMT) * 100) : null,
        available_cents: availBal?.BALAMT != null ? Math.round(Number(availBal.BALAMT) * 100) : null,
      };
    }
  }

  return { transactions, balance };
}

// ─── Main ─────────────────────────────────────────────────────────────────

runConnector({
  name: 'chase',
  validateRecord,
  // Chase fingerprints the shared daemon profile and bounces it to
  // /#/logon/logon/error regardless of cookie state. See
  // `design-notes/chase-anti-bot.md`. Isolated-per-connector profile works.
  // Headful by default so Chase's login accepts the submission.
  browser: { profileName: 'chase', headless: false },
  async ensureSession({ context, page, sendInteraction }) {
    await ensureChaseSession({
      context,
      page,
      sendInteractionAndWait: sendInteraction,
      nextInteractionId: () => undefined,
    });
  },
  async collect({ state: startState, requested, page, emit, emitRecord, progress, capture }) {
    const wantsAccounts = requested.has('accounts');
    const wantsTransactions = requested.has('transactions');
    const wantsBalances = requested.has('balances');
    const wantsStatements = requested.has('statements');

    // State is keyed by stream name at the runtime layer:
    //   { transactions: { per_account: {<id>: {max_seen_date, ...}} } }
    // Normalize to an inner shape the rest of the connector reads directly.
    const state = startState.transactions || startState || {};

    // Track max_seen_date per account across this run so the STATE cursor
    // reflects "I've seen transactions up to this date" per account. Used
    // next run to pick the "since_last_statement" activity for incremental
    // fetches.
    const maxSeenByAccount = { ...(state.per_account || {}) };

    // Choose Chase's Activity option based on scope + prior state.
    //   - If client asked for a specific time_range → date_range
    //   - If we have a prior cursor → since_last_statement
    //   - Otherwise → all (cold-start backfill)
    function chooseActivity(stream, accountId) {
      const streamScope = requested.get(stream);
      if (streamScope?.time_range?.since || streamScope?.time_range?.until) {
        return { activity: 'date_range', dateRange: { from: streamScope.time_range.since?.slice(0, 10), to: streamScope.time_range.until?.slice(0, 10) } };
      }
      const cursor = state.per_account?.[accountId];
      if (cursor?.max_seen_date) {
        return { activity: 'since_last_statement' };
      }
      return { activity: 'all' };
    }

    const tmpDir = await mkdtemp(join(tmpdir(), 'pdpp-chase-'));

    try {
      progress('Chase session verified; enumerating accounts');

      const accounts = await discoverAccounts(page);
      // Fixture capture: dashboard account-list DOM.
      if (capture) await capture.captureDom(page, 'dashboard-accounts');
      if (!accounts.length) {
        const diag = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          body_preview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
        })).catch(() => null);
        await emit({
          type: 'SKIP_RESULT',
          stream: 'accounts',
          reason: 'selectors_pending',
          message: 'No accounts discovered from dashboard. Selectors need calibration against live DOM.',
          diagnostics: diag,
        });
        return; // runtime emits DONE succeeded
      }

    progress(`Found ${accounts.length} account(s)`);

    // Apply the `accounts` stream's resources filter to the per-account
    // loop so we don't hit Chase's download page for accounts the client
    // didn't ask for.
    const accountsResFilter = resFilters.get('accounts') || resFilters.get('transactions') || resFilters.get('balances');
    const filteredAccounts = accountsResFilter && accountsResFilter.size
      ? accounts.filter((a) => accountsResFilter.has(a.internal_id))
      : accounts;

    // Emit accounts stream. Our record.id is Chase's internal account id
    // directly — stable, no hashing needed. Keeps transactions.account_id
    // aligned with the download URL param.
    if (wantsAccounts) {
      for (const a of filteredAccounts) {
        await emitRecord('accounts', {
          id: a.internal_id,
          name: a.name,
          type: a.type,
          last_four: a.last_four,
          balance_cents: null, // populated from QFX LEDGERBAL when downloads run
          available_balance_cents: null,
          credit_limit_cents: null,
          available_credit_cents: null,
          statement_balance_cents: null,
          status: null,
          balance_as_of: null,
          fetched_at: emittedAt,
        });
      }
    }

    // Transactions + balances: download QFX per account, parse, emit.
    if (wantsTransactions || wantsBalances) {
      for (const a of filteredAccounts) {
        const activityChoice = chooseActivity(wantsTransactions ? 'transactions' : 'balances', a.internal_id);
        await emit({
          type: 'PROGRESS',
          stream: 'transactions',
          message: `${a.name}: downloading QFX (activity=${activityChoice.activity})`,
        });

        const result = await downloadQfx(page, a, tmpDir, activityChoice);
        if (!result.downloaded) {
          await emit({
            type: 'SKIP_RESULT',
            stream: 'transactions',
            reason: 'qfx_download_failed',
            message: `${a.name}: ${result.error}`,
          });
          continue;
        }

        let parsed;
        try {
          parsed = await parseQfxFile(result.qfxPath);
        } catch (err) {
          await emit({
            type: 'SKIP_RESULT',
            stream: 'transactions',
            reason: 'qfx_parse_failed',
            message: `${a.name}: ${err.message.slice(0, 160)}`,
          });
          continue;
        }

        const { transactions, balance } = extractFromQfx(parsed);

        if (wantsTransactions) {
          let maxDate = maxSeenByAccount[a.internal_id]?.max_seen_date || null;
          for (const t of transactions) {
            await emitRecord('transactions', {
              id: `${a.internal_id}|${t.fitid}`,
              account_id: a.internal_id,
              account_name: a.name,
              fitid: t.fitid,
              date: t.date,
              amount: t.amount_cents,
              currency: t.currency,
              type: t.type,
              name: t.name,
              memo: t.memo,
              check_number: t.check_number,
              reference_number: t.reference_number,
              source: `qfx_download_${activityChoice.activity}_${t.date}`,
              fetched_at: emittedAt,
            });
            if (!maxDate || t.date > maxDate) maxDate = t.date;
          }
          if (maxDate) {
            maxSeenByAccount[a.internal_id] = {
              ...(maxSeenByAccount[a.internal_id] || {}),
              max_seen_date: maxDate,
              last_activity: activityChoice.activity,
              last_fetched_at: emittedAt,
            };
          }
        }

        if (wantsBalances && balance) {
          await emitRecord('balances', {
            id: `${a.internal_id}|${balance.as_of}`,
            account_id: a.internal_id,
            as_of: balance.as_of,
            ledger_balance_cents: balance.ledger_cents,
            available_balance_cents: balance.available_cents,
            fetched_at: emittedAt,
          });
        }

        await emit({
          type: 'PROGRESS',
          stream: 'transactions',
          message: `${a.name}: emitted ${transactions.length} transactions`,
        });
      }
    }

    // Statements: navigate to Statements & Documents, enumerate rows, download
    // each PDF, emit one record per statement with content-addressed path.
    if (wantsStatements) {
      try {
        await emit({ type: 'PROGRESS', stream: 'statements', message: 'Navigating to Statements & Documents' });
        await navigateToStatementsPage(page);
        // Fixture capture: statements list page DOM.
        if (capture) await capture.captureDom(page, 'statements-list');
        const rows = await enumerateStatementRows(page);
        await emit({ type: 'PROGRESS', stream: 'statements', message: `Found ${rows.length} statement row(s)` });

        for (const row of rows) {
          try {
            const dateIso = parseDateDelivered(row.date_delivered_raw);
            const accountId = resolveAccountIdForRow(row, filteredAccounts) || resolveAccountIdForRow(row, accounts);

            // Apply resources filter: if the accounts res filter excludes this
            // statement's account, skip it. (emitRecord will also skip, but
            // doing it here saves the PDF download.)
            if (accountsResFilter && accountsResFilter.size && accountId && !accountsResFilter.has(accountId)) continue;

            // Apply time_range filter: if client asked for statements.since and
            // this row predates it, skip the download.
            const stmtScope = requested.get('statements');
            if (stmtScope?.time_range?.since && dateIso && dateIso < stmtScope.time_range.since.slice(0, 10)) continue;
            if (stmtScope?.time_range?.until && dateIso && dateIso >= stmtScope.time_range.until.slice(0, 10)) continue;

            const id = shortHash(`${row.account_reference || ''}|${dateIso || row.date_delivered_raw}|${row.title}`);

            await emit({
              type: 'PROGRESS',
              stream: 'statements',
              message: `Downloading ${row.title}`,
            });

            const dlResult = await downloadStatementPdf(page, row, accountId);
            if (!dlResult.ok) {
              await emit({
                type: 'SKIP_RESULT',
                stream: 'statements',
                reason: 'pdf_download_failed',
                message: `${row.title}: ${dlResult.error}`,
              });
              // Still emit the index row so the owner has a record the
              // statement exists, just without hydrated bytes.
              await emitRecord('statements', {
                id,
                account_id: accountId,
                title: row.title,
                date_delivered: dateIso,
                account_reference: row.account_reference,
                document_url: null,
                pdf_path: null,
                pdf_sha256: null,
                fetched_at: emittedAt,
              });
              continue;
            }

            await emitRecord('statements', {
              id,
              account_id: accountId,
              title: row.title,
              date_delivered: dateIso,
              account_reference: row.account_reference,
              document_url: fileUrl(dlResult.pdfPath),
              pdf_path: dlResult.pdfPath,
              pdf_sha256: dlResult.pdfSha256,
              fetched_at: emittedAt,
            });
          } catch (rowErr) {
            await emit({
              type: 'SKIP_RESULT',
              stream: 'statements',
              reason: 'row_exception',
              message: `${row.title}: ${rowErr.message.slice(0, 160)}`,
            });
          }
        }

        await emit({ type: 'STATE', stream: 'statements', cursor: { fetched_at: emittedAt } });
      } catch (err) {
        await emit({
          type: 'SKIP_RESULT',
          stream: 'statements',
          reason: 'statements_scrape_failed',
          message: err.message.slice(0, 200),
        });
      }
    }
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    // Emit STATE for incremental resumption. The per_account cursor drives
    // the next run's chooseActivity() — when max_seen_date is present we'll
    // use "since_last_statement" instead of re-downloading all transactions.
    if (wantsTransactions && Object.keys(maxSeenByAccount).length) {
      await emit({
        type: 'STATE',
        stream: 'transactions',
        cursor: { per_account: maxSeenByAccount },
      });
    }
  },
});
